import { join } from "node:path";
import { isDigest } from "../bundle/schema.ts";
import { type EvoCapabilityGrant, parseEvoCapabilityGrants } from "../components/capabilities/broker.ts";
import {
	assertEvoAbiId,
	assertEvoCapability,
	assertEvoComponentId,
	parseEvoComponentManifest,
} from "../components/manifest.ts";
import { createDefaultEvoAbiRegistry, type EvoAbiRegistry } from "../components/registry.ts";
import { type EvoPackComponent, type EvoPackWorkflow, loadEvoPack } from "../pack/pack.ts";
import { readRegularDirectoryNoFollow, readRegularFileNoFollow, resolveRegularDirectory } from "../secure-file.ts";
import { canonicalJson, sha256 } from "../storage.ts";
import type { EvoComponentActivationBoundary, EvoComponentManifest } from "../types.ts";

export const MAX_UNKNOWN_ABI_REQUESTS_PER_PACK = 4;
export const MAX_UNKNOWN_ABI_PARTS = 8;
export const MAX_UNKNOWN_ABI_MANIFEST_BYTES = 16 * 1024;
export const MAX_UNKNOWN_ABI_ENTRYPOINT_BYTES = 64 * 1024;
export const MAX_UNKNOWN_ABI_SOURCE_BYTES = 256 * 1024;
export const MAX_UNKNOWN_ABI_REQUEST_BYTES = 384 * 1024;
export const MAX_UNKNOWN_ABI_CODE_PATCH_BYTES = 256 * 1024;
export const MAX_UNKNOWN_ABI_PATCH_FILES = 12;

const PACK_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const PACK_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const PACK_INTEGRITY_PATTERN = /^sha256:[0-9a-f]{64}$/;
const WORKFLOW_TRIGGER_PATTERN = /^\/[a-z0-9][a-z0-9-]*$/;
const ACTIVATION_BOUNDARIES = new Set<EvoComponentActivationBoundary>(["turn", "session", "process", "invocation"]);

export interface UnknownAbiPackSource {
	kind: "optimization-pack";
	name: string;
	version: string;
	integrity: string;
}

/**
 * The exact selection that may be proposed only after this ABI lands and the
 * user retries import. Keeping grants here makes the future authority
 * reviewable without mutating policy or broker state during ABI generation.
 */
export interface UnknownAbiCandidateSelection {
	id: string;
	abi: string;
	artifactDigest: string;
	grants: EvoCapabilityGrant[];
}

export interface UnknownAbiBuilderPart {
	kind: "component" | "workflow";
	surface: string;
	trigger?: string;
	selection: UnknownAbiCandidateSelection;
	manifest: EvoComponentManifest;
	entrypointContent: string;
}

export interface UnknownAbiBuilderRequest {
	schemaVersion: 1;
	source: UnknownAbiPackSource;
	targetAbi: string;
	surface: string;
	activationBoundary: EvoComponentActivationBoundary;
	capabilityCeiling: string[];
	parts: UnknownAbiBuilderPart[];
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
	const allowedKeys = new Set(allowed);
	for (const key of Object.keys(record)) {
		if (!allowedKeys.has(key)) throw new Error(`${label} has unknown key: ${key}`);
	}
}

function nonEmptyString(value: unknown, label: string, maxLength = 128): string {
	if (typeof value !== "string" || !value || value.length > maxLength) {
		throw new Error(`${label} must be a non-empty string of at most ${maxLength} characters`);
	}
	return value;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
	return [...left].sort().join("\n") === [...right].sort().join("\n");
}

function artifactIdentityDigest(manifest: EvoComponentManifest): string {
	const { artifactDigest: _artifactDigest, ...identity } = manifest;
	return sha256(canonicalJson({ componentArtifactSchemaVersion: 1, manifest: identity }));
}

function parsePackSource(value: unknown): UnknownAbiPackSource {
	const source = asRecord(value, "unknown ABI request.source");
	exactKeys(source, ["kind", "name", "version", "integrity"], "unknown ABI request.source");
	if (source.kind !== "optimization-pack") {
		throw new Error("unknown ABI request.source.kind must be optimization-pack");
	}
	const name = nonEmptyString(source.name, "unknown ABI request.source.name");
	if (!PACK_NAME_PATTERN.test(name)) throw new Error("unknown ABI request.source.name is invalid");
	const version = nonEmptyString(source.version, "unknown ABI request.source.version");
	if (!PACK_VERSION_PATTERN.test(version)) throw new Error("unknown ABI request.source.version is invalid");
	const integrity = nonEmptyString(source.integrity, "unknown ABI request.source.integrity", 71);
	if (!PACK_INTEGRITY_PATTERN.test(integrity)) {
		throw new Error("unknown ABI request.source.integrity must be a sha256 pack digest");
	}
	return { kind: "optimization-pack", name, version, integrity };
}

function parseSelection(value: unknown, label: string): UnknownAbiCandidateSelection {
	const selection = asRecord(value, label);
	exactKeys(selection, ["id", "abi", "artifactDigest", "grants"], label);
	const id = nonEmptyString(selection.id, `${label}.id`);
	assertEvoComponentId(id, `${label}.id`);
	const abi = nonEmptyString(selection.abi, `${label}.abi`);
	assertEvoAbiId(abi, `${label}.abi`);
	if (typeof selection.artifactDigest !== "string" || !isDigest(selection.artifactDigest)) {
		throw new Error(`${label}.artifactDigest must be a digest`);
	}
	return {
		id,
		abi,
		artifactDigest: selection.artifactDigest,
		grants: parseEvoCapabilityGrants(selection.grants, `${label}.grants`),
	};
}

function parsePart(value: unknown, index: number): UnknownAbiBuilderPart {
	const label = `unknown ABI request.parts[${index}]`;
	const part = asRecord(value, label);
	exactKeys(part, ["kind", "surface", "trigger", "selection", "manifest", "entrypointContent"], label);
	if (part.kind !== "component" && part.kind !== "workflow") {
		throw new Error(`${label}.kind must be component or workflow`);
	}
	const surface = nonEmptyString(part.surface, `${label}.surface`);
	assertEvoComponentId(surface, `${label}.surface`);
	let trigger: string | undefined;
	if (part.kind === "workflow") {
		trigger = nonEmptyString(part.trigger, `${label}.trigger`);
		if (!WORKFLOW_TRIGGER_PATTERN.test(trigger)) throw new Error(`${label}.trigger is invalid`);
		if (surface !== "workflow") throw new Error(`${label}.surface must be workflow`);
	} else {
		if (part.trigger !== undefined) throw new Error(`${label}.trigger is only valid for workflows`);
		if (surface === "workflow") throw new Error(`${label}.surface workflow requires kind workflow`);
	}
	const selection = parseSelection(part.selection, `${label}.selection`);
	const manifest = parseEvoComponentManifest(part.manifest);
	if (typeof part.entrypointContent !== "string") {
		throw new Error(`${label}.entrypointContent must be a string`);
	}
	const entrypointBytes = Buffer.from(part.entrypointContent);
	if (entrypointBytes.byteLength > MAX_UNKNOWN_ABI_ENTRYPOINT_BYTES) {
		throw new Error(`${label}.entrypointContent exceeds ${MAX_UNKNOWN_ABI_ENTRYPOINT_BYTES} bytes`);
	}
	if (part.entrypointContent.includes("\0")) throw new Error(`${label}.entrypointContent contains a NUL byte`);
	if (sha256(entrypointBytes) !== manifest.entrypointSha256) {
		throw new Error(`${label}.entrypointContent digest does not match its manifest`);
	}
	if (artifactIdentityDigest(manifest) !== manifest.artifactDigest) {
		throw new Error(`${label}.manifest artifact identity is invalid`);
	}
	if (
		selection.id !== manifest.id ||
		selection.abi !== manifest.abi ||
		selection.artifactDigest !== manifest.artifactDigest
	) {
		throw new Error(`${label}.selection does not match its artifact manifest`);
	}
	if (
		!sameStringSet(
			manifest.capabilities,
			selection.grants.map((grant) => grant.capability),
		)
	) {
		throw new Error(`${label}.selection must explicitly grant exactly the declared capability set`);
	}
	return {
		kind: part.kind,
		surface,
		...(trigger ? { trigger } : {}),
		selection,
		manifest,
		entrypointContent: part.entrypointContent,
	};
}

export function parseUnknownAbiBuilderRequest(value: unknown): UnknownAbiBuilderRequest {
	const request = asRecord(value, "unknown ABI request");
	exactKeys(
		request,
		["schemaVersion", "source", "targetAbi", "surface", "activationBoundary", "capabilityCeiling", "parts"],
		"unknown ABI request",
	);
	if (request.schemaVersion !== 1) throw new Error("unknown ABI request.schemaVersion must be 1");
	const source = parsePackSource(request.source);
	const targetAbi = nonEmptyString(request.targetAbi, "unknown ABI request.targetAbi");
	assertEvoAbiId(targetAbi, "unknown ABI request.targetAbi");
	const surface = nonEmptyString(request.surface, "unknown ABI request.surface");
	assertEvoComponentId(surface, "unknown ABI request.surface");
	if (
		typeof request.activationBoundary !== "string" ||
		!ACTIVATION_BOUNDARIES.has(request.activationBoundary as EvoComponentActivationBoundary)
	) {
		throw new Error("unknown ABI request.activationBoundary is invalid");
	}
	if (
		!Array.isArray(request.capabilityCeiling) ||
		request.capabilityCeiling.some((capability) => typeof capability !== "string")
	) {
		throw new Error("unknown ABI request.capabilityCeiling must be a string array");
	}
	const capabilityCeiling = request.capabilityCeiling as string[];
	for (const [index, capability] of capabilityCeiling.entries()) {
		assertEvoCapability(capability, `unknown ABI request.capabilityCeiling[${index}]`);
	}
	if (new Set(capabilityCeiling).size !== capabilityCeiling.length) {
		throw new Error("unknown ABI request.capabilityCeiling must not contain duplicates");
	}
	if (!Array.isArray(request.parts) || request.parts.length === 0) {
		throw new Error("unknown ABI request.parts must be a non-empty array");
	}
	if (request.parts.length > MAX_UNKNOWN_ABI_PARTS) {
		throw new Error(`unknown ABI request.parts exceeds ${MAX_UNKNOWN_ABI_PARTS} parts`);
	}
	const parts = request.parts.map((part, index) => parsePart(part, index));
	if (surface !== "tool" && surface !== "workflow" && parts.length !== 1) {
		throw new Error(`unknown ABI singleton surface ${surface} must have exactly one candidate part`);
	}
	for (const [index, part] of parts.entries()) {
		if (part.surface !== surface) throw new Error(`unknown ABI request.parts[${index}] has a different surface`);
		if (part.selection.abi !== targetAbi) {
			throw new Error(`unknown ABI request.parts[${index}] targets a different ABI`);
		}
		if (part.manifest.activationBoundary !== request.activationBoundary) {
			throw new Error(`unknown ABI request.parts[${index}] has a different activation boundary`);
		}
	}
	if (new Set(parts.map((part) => part.selection.id)).size !== parts.length) {
		throw new Error("unknown ABI request.parts must not contain duplicate component ids");
	}
	if (new Set(parts.map((part) => part.selection.artifactDigest)).size !== parts.length) {
		throw new Error("unknown ABI request.parts must not contain duplicate artifacts");
	}
	const triggers = parts.flatMap((part) => (part.trigger ? [part.trigger] : []));
	if (new Set(triggers).size !== triggers.length) {
		throw new Error("unknown ABI request.parts must not contain duplicate workflow triggers");
	}
	const declaredCeiling = [...new Set(parts.flatMap((part) => part.manifest.capabilities))].sort();
	if (!sameStringSet(capabilityCeiling, declaredCeiling)) {
		throw new Error("unknown ABI request.capabilityCeiling must exactly match candidate declarations");
	}
	const sourceBytes = parts.reduce((total, part) => total + Buffer.byteLength(part.entrypointContent), 0);
	if (sourceBytes > MAX_UNKNOWN_ABI_SOURCE_BYTES) {
		throw new Error(`unknown ABI request source exceeds ${MAX_UNKNOWN_ABI_SOURCE_BYTES} bytes`);
	}
	const parsed: UnknownAbiBuilderRequest = {
		schemaVersion: 1,
		source,
		targetAbi,
		surface,
		activationBoundary: request.activationBoundary as EvoComponentActivationBoundary,
		capabilityCeiling: [...capabilityCeiling].sort(),
		parts: parts.sort((left, right) => left.selection.id.localeCompare(right.selection.id)),
	};
	if (Buffer.byteLength(canonicalJson(parsed)) > MAX_UNKNOWN_ABI_REQUEST_BYTES) {
		throw new Error(`unknown ABI request exceeds ${MAX_UNKNOWN_ABI_REQUEST_BYTES} bytes`);
	}
	return parsed;
}

type PackCodePart = { kind: "component"; part: EvoPackComponent } | { kind: "workflow"; part: EvoPackWorkflow };

async function inspectPackArtifact(
	packDirectory: string,
	codePart: PackCodePart,
	grants: readonly EvoCapabilityGrant[],
): Promise<UnknownAbiBuilderPart> {
	const declaration = codePart.part;
	const directory = join(packDirectory, declaration.artifact);
	const entries = (await readRegularDirectoryNoFollow(directory, `Pack component artifact ${declaration.id}`)).sort(
		(left, right) => left.name.localeCompare(right.name),
	);
	if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
		throw new Error(`Pack component artifact contains a non-regular file: ${declaration.id}`);
	}
	const manifestEntry = entries.find((entry) => entry.name === "manifest.json");
	if (!manifestEntry) throw new Error(`Pack component artifact has no manifest: ${declaration.id}`);
	const manifestPath = join(directory, "manifest.json");
	const manifestBytes = await readRegularFileNoFollow(
		manifestPath,
		`Pack component manifest ${declaration.id}`,
		MAX_UNKNOWN_ABI_MANIFEST_BYTES,
	);
	let manifestText: string;
	try {
		manifestText = new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes);
	} catch (error) {
		throw new Error(`Pack component manifest is not UTF-8: ${declaration.id}`, { cause: error });
	}
	const manifest = parseEvoComponentManifest(JSON.parse(manifestText) as unknown);
	const expectedFiles = [manifest.entrypoint, "manifest.json"].sort();
	if (entries.map((entry) => entry.name).join("\n") !== expectedFiles.join("\n")) {
		throw new Error(`Pack component artifact file set is invalid: ${declaration.id}`);
	}
	const entrypointPath = join(directory, manifest.entrypoint);
	const entrypointBytes = await readRegularFileNoFollow(
		entrypointPath,
		`Pack component entrypoint ${declaration.id}`,
		MAX_UNKNOWN_ABI_ENTRYPOINT_BYTES,
	);
	let entrypointContent: string;
	try {
		entrypointContent = new TextDecoder("utf-8", { fatal: true }).decode(entrypointBytes);
	} catch (error) {
		throw new Error(`Pack component entrypoint is not UTF-8: ${declaration.id}`, { cause: error });
	}
	if (
		manifest.id !== declaration.id ||
		manifest.abi !== declaration.abi ||
		!sameStringSet(manifest.capabilities, declaration.capabilities)
	) {
		throw new Error(`Pack component declaration does not match artifact: ${declaration.id}`);
	}
	const parsedGrants = parseEvoCapabilityGrants(grants, `grantsByComponent.${declaration.id}`);
	const surface = codePart.kind === "workflow" ? "workflow" : codePart.part.surface;
	return parsePart(
		{
			kind: codePart.kind,
			surface,
			...(codePart.kind === "workflow" ? { trigger: codePart.part.trigger } : {}),
			selection: {
				id: manifest.id,
				abi: manifest.abi,
				artifactDigest: manifest.artifactDigest,
				grants: parsedGrants,
			},
			manifest,
			entrypointContent,
		},
		0,
	);
}

export async function createUnknownAbiBuilderRequestsFromPack(options: {
	packDirectory: string;
	grantsByComponent?: Readonly<Record<string, readonly EvoCapabilityGrant[]>>;
	registry?: EvoAbiRegistry;
}): Promise<UnknownAbiBuilderRequest[]> {
	const packDirectory = await resolveRegularDirectory(options.packDirectory, "pack directory");
	const loaded = await loadEvoPack(packDirectory);
	if (!loaded.integrity.ok) {
		throw new Error(
			`pack integrity check failed: expected ${loaded.integrity.expected ?? "(none declared)"}, got ${loaded.integrity.actual}`,
		);
	}
	const registry = options.registry ?? createDefaultEvoAbiRegistry();
	const grouped = new Map<string, UnknownAbiBuilderPart[]>();
	const codeParts: PackCodePart[] = [
		...loaded.manifest.contents.components.map((part): PackCodePart => ({ kind: "component", part })),
		...loaded.manifest.contents.workflows.map((part): PackCodePart => ({ kind: "workflow", part })),
	];
	for (const codePart of codeParts) {
		if (registry.get(codePart.part.abi)) continue;
		const part = await inspectPackArtifact(
			packDirectory,
			codePart,
			options.grantsByComponent?.[codePart.part.id] ?? [],
		);
		const group = grouped.get(codePart.part.abi) ?? [];
		group.push(part);
		grouped.set(codePart.part.abi, group);
	}
	if (grouped.size > MAX_UNKNOWN_ABI_REQUESTS_PER_PACK) {
		throw new Error(`Pack exceeds ${MAX_UNKNOWN_ABI_REQUESTS_PER_PACK} unregistered ABIs per import`);
	}
	const requests = [...grouped.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([targetAbi, parts]) => {
			const first = parts[0];
			if (!first) throw new Error(`Unknown ABI ${targetAbi} has no candidate parts`);
			return parseUnknownAbiBuilderRequest({
				schemaVersion: 1,
				source: {
					kind: "optimization-pack",
					name: loaded.manifest.name,
					version: loaded.manifest.version,
					integrity: loaded.integrity.actual,
				},
				targetAbi,
				surface: first.surface,
				activationBoundary: first.manifest.activationBoundary,
				capabilityCeiling: [...new Set(parts.flatMap((part) => part.manifest.capabilities))].sort(),
				parts,
			});
		});
	const confirmed = await loadEvoPack(packDirectory);
	if (
		!confirmed.integrity.ok ||
		confirmed.integrity.actual !== loaded.integrity.actual ||
		canonicalJson(confirmed.manifest) !== canonicalJson(loaded.manifest)
	) {
		throw new Error(
			`Pack changed while creating unknown ABI requests: expected ${loaded.integrity.actual}, got ${confirmed.integrity.actual}`,
		);
	}
	return requests;
}

function allowedUnknownAbiPatchPath(path: string): boolean {
	if (path === "packages/evo/src/components/registry.ts") return true;
	if (path === "packages/evo/src/bundle/runtime.ts") return true;
	if (path === "packages/evo/src/types.ts" || path === "packages/evo/src/extension.ts") return true;
	if (
		path.startsWith("packages/evo/src/components/") &&
		!path.startsWith("packages/evo/src/components/capabilities/") &&
		path.endsWith(".ts")
	) {
		return true;
	}
	return /^packages\/evo\/test\/[A-Za-z0-9._/-]+\.test\.ts$/.test(path);
}

function containsQuotedLiteral(text: string, value: string): boolean {
	return text.includes(`"${value}"`) || text.includes(`'${value}'`);
}

function parseAddedCapabilityCeilings(patch: string): string[][] {
	const added = patch
		.split("\n")
		.filter((line) => line.startsWith("+") && !line.startsWith("+++"))
		.map((line) => line.slice(1))
		.join("\n");
	const ceilings: string[][] = [];
	for (const match of added.matchAll(/capabilityCeiling\s*:\s*\[([^\]\n]*)\]/g)) {
		const body = match[1] ?? "";
		const capabilities: string[] = [];
		let remainder = body;
		for (const literal of body.matchAll(/(["'])([a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*)\1/g)) {
			capabilities.push(literal[2] as string);
			remainder = remainder.replace(literal[0], "");
		}
		if (remainder.replaceAll(",", "").trim()) {
			throw new Error("Unknown ABI Builder capabilityCeiling must contain only string literals");
		}
		ceilings.push(capabilities);
	}
	return ceilings;
}

/**
 * Enforce the narrow infrastructure-patch envelope before a worktree exists.
 * Git staging still performs the authoritative path, mode, binary, whitespace,
 * and L1 checks.
 */
export function assertUnknownAbiCodePatch(request: UnknownAbiBuilderRequest, patch: string): string[] {
	if (!patch.trim()) throw new Error("Unknown ABI Builder codePatch must not be empty");
	if (Buffer.byteLength(patch) > MAX_UNKNOWN_ABI_CODE_PATCH_BYTES) {
		throw new Error(`Unknown ABI Builder codePatch exceeds ${MAX_UNKNOWN_ABI_CODE_PATCH_BYTES} bytes`);
	}
	if (patch.includes("\0")) throw new Error("Unknown ABI Builder codePatch contains a NUL byte");
	const paths: string[] = [];
	for (const line of patch.split("\n")) {
		if (!line.startsWith("diff --git ")) continue;
		const match = /^diff --git a\/([^\t ]+) b\/([^\t ]+)\r?$/.exec(line);
		if (!match || match[1] !== match[2]) {
			throw new Error("Unknown ABI Builder codePatch has a malformed or renamed diff header");
		}
		paths.push(match[1]);
	}
	if (paths.length === 0) throw new Error("Unknown ABI Builder codePatch must use complete git diff headers");
	if (paths.length > MAX_UNKNOWN_ABI_PATCH_FILES) {
		throw new Error(`Unknown ABI Builder codePatch exceeds ${MAX_UNKNOWN_ABI_PATCH_FILES} files`);
	}
	if (new Set(paths).size !== paths.length) {
		throw new Error("Unknown ABI Builder codePatch has duplicate file diffs");
	}
	for (const path of paths) {
		if (!allowedUnknownAbiPatchPath(path)) {
			throw new Error(`Unknown ABI Builder codePatch changes a forbidden path: ${path}`);
		}
	}
	for (const required of ["packages/evo/src/components/registry.ts", "packages/evo/src/bundle/runtime.ts"] as const) {
		if (!paths.includes(required)) {
			throw new Error(`Unknown ABI Builder codePatch must change ${required}`);
		}
	}
	if (!paths.some((path) => path.startsWith("packages/evo/test/"))) {
		throw new Error("Unknown ABI Builder codePatch must add or update a focused Evo test");
	}
	if (!patch.includes("EvoAbiDefinition") || !containsQuotedLiteral(patch, request.targetAbi)) {
		throw new Error("Unknown ABI Builder codePatch must define the exact requested EvoAbiDefinition");
	}
	const ceilings = parseAddedCapabilityCeilings(patch);
	if (ceilings.length === 0) {
		throw new Error("Unknown ABI Builder codePatch must define an explicit capability ceiling");
	}
	for (const ceiling of ceilings) {
		if (!sameStringSet(ceiling, request.capabilityCeiling)) {
			throw new Error("Unknown ABI Builder codePatch widens or narrows the declared capability ceiling");
		}
	}
	for (const part of request.parts) {
		if (patch.includes(part.selection.artifactDigest)) {
			throw new Error("Unknown ABI Builder codePatch must not hard-code a future component selection");
		}
	}
	return [...paths].sort();
}
