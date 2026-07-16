/**
 * Optimization Pack (pack.json v1) — the shareable envelope.
 *
 * See docs/optimization-packs.md. A pack bundles data-type parts (prompts,
 * skills, memory) and code-type parts (components, workflows) described by a
 * single pack.json, with a content-addressed integrity digest so a pack cannot
 * be silently modified in transit.
 *
 * This module parses/validates pack.json and computes/verifies integrity. It is
 * pure (no bundle mutation); import wiring lives elsewhere.
 */

import { lstat } from "node:fs/promises";
import { join, sep } from "node:path";
import { assertEvoAbiId, assertEvoCapability, assertEvoComponentId } from "../components/manifest.ts";
import { readRegularDirectoryNoFollow, readRegularFileNoFollow, resolveRegularDirectory } from "../secure-file.ts";
import { canonicalJson, sha256 } from "../storage.ts";

export const EVO_PACK_FORMAT = 1;

export interface EvoPackPrompt {
	target: "system" | "append-system";
	file: string;
}

export interface EvoPackSkill {
	name: string;
	dir: string;
}

export interface EvoPackMemory {
	file: string;
}

export interface EvoPackComponent {
	surface: string;
	abi: string;
	id: string;
	artifact: string;
	capabilities: string[];
}

export interface EvoPackWorkflow {
	id: string;
	trigger: string;
	abi: string;
	artifact: string;
	capabilities: string[];
}

export interface EvoPackContents {
	prompts: EvoPackPrompt[];
	skills: EvoPackSkill[];
	memory: EvoPackMemory[];
	components: EvoPackComponent[];
	workflows: EvoPackWorkflow[];
}

export interface EvoPackManifest {
	packFormat: 1;
	name: string;
	version: string;
	author?: string;
	description?: string;
	contents: EvoPackContents;
	requiresAbis: string[];
	requiresCapabilities: string[];
	integrity?: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const TRIGGER_RE = /^\/[a-z0-9][a-z0-9-]*$/;
const INTEGRITY_RE = /^sha256:[0-9a-f]{64}$/;

function asRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): unknown[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
	return value;
}

function asString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string`);
	return value;
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
	const allowedKeys = new Set(allowed);
	for (const key of Object.keys(record)) {
		if (!allowedKeys.has(key)) throw new Error(`${label} has unknown key: ${key}`);
	}
}

function assertUnique(values: readonly string[], label: string): void {
	if (new Set(values).size !== values.length) throw new Error(`${label} must not contain duplicates`);
}

function assertSameSet(actual: readonly string[], expected: readonly string[], label: string): void {
	const sortedActual = [...actual].sort();
	const sortedExpected = [...new Set(expected)].sort();
	if (sortedActual.join("\n") !== sortedExpected.join("\n")) {
		throw new Error(`${label} must exactly match declared code parts: expected [${sortedExpected.join(", ")}]`);
	}
}

/**
 * A pack-relative path must be relative, forward-only, and contain no `..`
 * segment, absolute prefix, or NUL. This blocks path traversal out of the pack
 * before any file is read.
 */
function assertSafeRelPath(value: string, label: string): void {
	if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty path`);
	if (value.includes("\0")) throw new Error(`${label} contains a NUL byte`);
	if (value.includes("\\")) throw new Error(`${label} must use forward slashes: ${value}`);
	if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
		throw new Error(`${label} must be relative, got ${value}`);
	}
	const segments = value.split("/");
	for (const segment of segments) {
		if (segment === "..") throw new Error(`${label} must not contain '..': ${value}`);
		if (segment === "" || segment === ".") {
			throw new Error(`${label} must be a canonical relative path: ${value}`);
		}
	}
}

function assertCapabilities(value: unknown, label: string): string[] {
	const list = asArray(value, label);
	const out: string[] = [];
	for (const [index, entry] of list.entries()) {
		if (typeof entry !== "string") throw new Error(`${label}[${index}] must be a string`);
		assertEvoCapability(entry, `${label}[${index}]`);
		out.push(entry);
	}
	if (new Set(out).size !== out.length) throw new Error(`${label} must not contain duplicates`);
	return out;
}

/**
 * Parse and validate a pack.json manifest. Fail-closed: any malformed field
 * rejects the whole manifest rather than silently dropping it.
 */
export function parseEvoPackManifest(raw: unknown): EvoPackManifest {
	const record = asRecord(raw, "pack.json");
	exactKeys(
		record,
		[
			"packFormat",
			"name",
			"version",
			"author",
			"description",
			"contents",
			"requiresAbis",
			"requiresCapabilities",
			"integrity",
		],
		"pack.json",
	);

	if (record.packFormat !== EVO_PACK_FORMAT) {
		throw new Error(`pack.json packFormat must be ${EVO_PACK_FORMAT}`);
	}
	const name = asString(record.name, "pack.json name");
	if (!NAME_RE.test(name) || name.length > 128) throw new Error(`pack.json name is invalid: ${name}`);
	const version = asString(record.version, "pack.json version");
	if (!VERSION_RE.test(version) || version.length > 128) throw new Error(`pack.json version is invalid: ${version}`);

	if (record.author !== undefined && typeof record.author !== "string") {
		throw new Error("pack.json author must be a string");
	}
	if (record.description !== undefined && typeof record.description !== "string") {
		throw new Error("pack.json description must be a string");
	}
	if (record.integrity !== undefined) {
		if (typeof record.integrity !== "string" || !INTEGRITY_RE.test(record.integrity)) {
			throw new Error("pack.json integrity must be 'sha256:<64 hex>'");
		}
	}

	const contentsRecord = asRecord(record.contents ?? {}, "pack.json contents");
	exactKeys(contentsRecord, ["prompts", "skills", "memory", "components", "workflows"], "pack.json contents");

	const prompts: EvoPackPrompt[] = asArray(contentsRecord.prompts, "contents.prompts").map((entry, i) => {
		const p = asRecord(entry, `contents.prompts[${i}]`);
		exactKeys(p, ["target", "file"], `contents.prompts[${i}]`);
		if (p.target !== "system" && p.target !== "append-system") {
			throw new Error(`contents.prompts[${i}].target must be 'system' or 'append-system'`);
		}
		const file = asString(p.file, `contents.prompts[${i}].file`);
		assertSafeRelPath(file, `contents.prompts[${i}].file`);
		return { target: p.target, file };
	});

	const skills: EvoPackSkill[] = asArray(contentsRecord.skills, "contents.skills").map((entry, i) => {
		const s = asRecord(entry, `contents.skills[${i}]`);
		exactKeys(s, ["name", "dir"], `contents.skills[${i}]`);
		const skillName = asString(s.name, `contents.skills[${i}].name`);
		const dir = asString(s.dir, `contents.skills[${i}].dir`);
		assertSafeRelPath(dir, `contents.skills[${i}].dir`);
		return { name: skillName, dir };
	});

	const memory: EvoPackMemory[] = asArray(contentsRecord.memory, "contents.memory").map((entry, i) => {
		const m = asRecord(entry, `contents.memory[${i}]`);
		exactKeys(m, ["file"], `contents.memory[${i}]`);
		const file = asString(m.file, `contents.memory[${i}].file`);
		assertSafeRelPath(file, `contents.memory[${i}].file`);
		return { file };
	});

	const components: EvoPackComponent[] = asArray(contentsRecord.components, "contents.components").map((entry, i) => {
		const c = asRecord(entry, `contents.components[${i}]`);
		exactKeys(c, ["surface", "abi", "id", "artifact", "capabilities"], `contents.components[${i}]`);
		const id = asString(c.id, `contents.components[${i}].id`);
		assertEvoComponentId(id, `contents.components[${i}].id`);
		const abi = asString(c.abi, `contents.components[${i}].abi`);
		assertEvoAbiId(abi, `contents.components[${i}].abi`);
		const surface = asString(c.surface, `contents.components[${i}].surface`);
		assertEvoComponentId(surface, `contents.components[${i}].surface`);
		if (surface === "workflow") {
			throw new Error(`contents.components[${i}].surface workflow must use contents.workflows`);
		}
		const artifact = asString(c.artifact, `contents.components[${i}].artifact`);
		assertSafeRelPath(artifact, `contents.components[${i}].artifact`);
		return {
			surface,
			abi,
			id,
			artifact,
			capabilities: assertCapabilities(c.capabilities, `contents.components[${i}].capabilities`),
		};
	});

	const workflows: EvoPackWorkflow[] = asArray(contentsRecord.workflows, "contents.workflows").map((entry, i) => {
		const w = asRecord(entry, `contents.workflows[${i}]`);
		exactKeys(w, ["id", "trigger", "abi", "artifact", "capabilities"], `contents.workflows[${i}]`);
		const id = asString(w.id, `contents.workflows[${i}].id`);
		assertEvoComponentId(id, `contents.workflows[${i}].id`);
		const trigger = asString(w.trigger, `contents.workflows[${i}].trigger`);
		if (!TRIGGER_RE.test(trigger)) throw new Error(`contents.workflows[${i}].trigger must look like '/name'`);
		const abi = asString(w.abi, `contents.workflows[${i}].abi`);
		assertEvoAbiId(abi, `contents.workflows[${i}].abi`);
		const artifact = asString(w.artifact, `contents.workflows[${i}].artifact`);
		assertSafeRelPath(artifact, `contents.workflows[${i}].artifact`);
		return {
			id,
			trigger,
			abi,
			artifact,
			capabilities: assertCapabilities(w.capabilities, `contents.workflows[${i}].capabilities`),
		};
	});

	const requiresAbis = asArray(record.requiresAbis, "pack.json requiresAbis").map((entry, i) => {
		const abi = asString(entry, `requiresAbis[${i}]`);
		assertEvoAbiId(abi, `requiresAbis[${i}]`);
		return abi;
	});
	assertUnique(requiresAbis, "pack.json requiresAbis");
	const requiresCapabilities = assertCapabilities(record.requiresCapabilities, "pack.json requiresCapabilities");
	assertUnique(
		prompts.map((entry) => entry.file),
		"contents.prompts file references",
	);
	assertUnique(
		skills.map((entry) => entry.name),
		"contents.skills names",
	);
	assertUnique(
		skills.map((entry) => entry.dir),
		"contents.skills directory references",
	);
	assertUnique(
		memory.map((entry) => entry.file),
		"contents.memory file references",
	);
	assertUnique(
		components.filter((entry) => entry.surface !== "tool").map((entry) => entry.surface),
		"contents.components singleton surfaces",
	);
	assertUnique(
		components.map((entry) => entry.id),
		"contents.components ids",
	);
	assertUnique(
		components.map((entry) => entry.artifact),
		"contents.components artifact references",
	);
	assertUnique(
		workflows.map((entry) => entry.id),
		"contents.workflows ids",
	);
	assertUnique(
		workflows.map((entry) => entry.trigger),
		"contents.workflows triggers",
	);
	assertUnique(
		workflows.map((entry) => entry.artifact),
		"contents.workflows artifact references",
	);
	const codeParts = [...components, ...workflows];
	assertUnique(
		codeParts.map((entry) => entry.id),
		"pack code part ids",
	);
	assertSameSet(
		requiresAbis,
		codeParts.map((entry) => entry.abi),
		"pack.json requiresAbis",
	);
	assertSameSet(
		requiresCapabilities,
		codeParts.flatMap((entry) => entry.capabilities),
		"pack.json requiresCapabilities",
	);

	return {
		packFormat: EVO_PACK_FORMAT,
		name,
		version,
		...(record.author === undefined ? {} : { author: record.author as string }),
		...(record.description === undefined ? {} : { description: record.description as string }),
		contents: { prompts, skills, memory, components, workflows },
		requiresAbis,
		requiresCapabilities,
		...(record.integrity === undefined ? {} : { integrity: record.integrity as string }),
	};
}

/** All pack-relative file references, split into single files and directory roots. */
function referencedPaths(manifest: EvoPackManifest): { files: string[]; dirs: string[] } {
	const files: string[] = [];
	const dirs: string[] = [];
	for (const p of manifest.contents.prompts) files.push(p.file);
	for (const m of manifest.contents.memory) files.push(m.file);
	for (const s of manifest.contents.skills) dirs.push(s.dir);
	for (const c of manifest.contents.components) dirs.push(c.artifact);
	for (const w of manifest.contents.workflows) dirs.push(w.artifact);
	return { files, dirs };
}

async function walkFiles(root: string, rel: string, out: string[]): Promise<void> {
	const abs = join(root, rel);
	const info = await lstat(abs);
	if (info.isSymbolicLink()) throw new Error(`pack path is a symlink: ${rel}`);
	if (info.isDirectory()) {
		const entries = await readRegularDirectoryNoFollow(abs, `pack directory ${rel}`);
		for (const entry of entries) {
			if (entry.isSymbolicLink()) throw new Error(`pack path is a symlink: ${rel}/${entry.name}`);
			await walkFiles(root, rel === "" ? entry.name : `${rel}/${entry.name}`, out);
		}
	} else if (info.isFile()) {
		out.push(rel);
	} else {
		throw new Error(`pack path is neither file nor directory: ${rel}`);
	}
}

/**
 * Content-addressed integrity over the canonical pack: the manifest (minus its
 * own integrity field) plus a sorted map of every referenced file's sha256. Any
 * change to the manifest or any referenced byte changes the digest.
 */
export async function computeEvoPackIntegrity(packDir: string, manifest: EvoPackManifest): Promise<string> {
	const root = await resolveRegularDirectory(packDir, "pack directory");
	const { files, dirs } = referencedPaths(manifest);
	const collected: string[] = [];
	for (const file of files) await walkFiles(root, file, collected);
	for (const dir of dirs) await walkFiles(root, dir, collected);

	const digests: Record<string, string> = {};
	for (const rel of collected) {
		if (digests[rel] !== undefined) continue;
		digests[rel] = sha256(await readRegularFileNoFollow(join(root, rel.split("/").join(sep)), `pack file ${rel}`));
	}

	const { integrity: _omit, ...manifestWithoutIntegrity } = manifest;
	const canonical = canonicalJson({
		packIntegritySchemaVersion: 1,
		manifest: manifestWithoutIntegrity,
		files: digests,
	});
	return `sha256:${sha256(canonical)}`;
}

export interface EvoPackIntegrityResult {
	ok: boolean;
	expected: string | undefined;
	actual: string;
}

/** Verify a pack's declared integrity against its actual contents. */
export async function verifyEvoPackIntegrity(
	packDir: string,
	manifest: EvoPackManifest,
): Promise<EvoPackIntegrityResult> {
	const actual = await computeEvoPackIntegrity(packDir, manifest);
	return {
		ok: manifest.integrity !== undefined && manifest.integrity === actual,
		expected: manifest.integrity,
		actual,
	};
}

/** Load, parse, and integrity-check a pack directory's pack.json. */
export async function loadEvoPack(
	packDir: string,
): Promise<{ manifest: EvoPackManifest; integrity: EvoPackIntegrityResult }> {
	const root = await resolveRegularDirectory(packDir, "pack directory");
	const raw = JSON.parse(
		(await readRegularFileNoFollow(join(root, "pack.json"), "pack.json")).toString("utf8"),
	) as unknown;
	const manifest = parseEvoPackManifest(raw);
	const integrity = await verifyEvoPackIntegrity(root, manifest);
	return { manifest, integrity };
}
