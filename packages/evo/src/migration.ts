import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import { assertAssetPath } from "./bundle/schema.ts";
import { atomicWriteFile, sha256 } from "./storage.ts";
import type { BundleManagedSource, BundleManagedSourceKind } from "./types.ts";

const GLOBAL_CONTEXT_FILES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

export interface EvoBundleMigrationOptions {
	agentDirectory?: string;
	systemPromptDirectories?: string[];
	skillDirectories?: string[];
	memoryDirectories?: string[];
	preferenceDirectories?: string[];
}

export interface EvoBundleMigrationResult {
	assets: BundleManagedSource[];
	promptPaths: string[];
	skillPaths: string[];
	memoryPaths: string[];
}

interface MigrationContext {
	bundleSourceDirectory: string;
	assetsByTarget: Map<string, BundleManagedSource>;
	promptPaths: string[];
	skillPaths: string[];
	memoryPaths: string[];
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

async function canonicalDirectory(path: string, optional: boolean): Promise<string | undefined> {
	let pathStat: Awaited<ReturnType<typeof lstat>>;
	const resolvedPath = resolve(path);
	try {
		pathStat = await lstat(resolvedPath);
	} catch (error) {
		if (optional && errorCode(error) === "ENOENT") return undefined;
		throw error;
	}
	if (pathStat.isSymbolicLink()) {
		throw new Error(`Evo-Pi migration refuses symbolic-link directory: ${resolvedPath}`);
	}
	if (!pathStat.isDirectory()) throw new Error(`Evo-Pi migration source is not a directory: ${resolvedPath}`);
	const canonicalPath = await realpath(resolvedPath);
	const confirmedStat = await lstat(resolvedPath);
	const canonicalStat = await lstat(canonicalPath);
	if (
		confirmedStat.isSymbolicLink() ||
		!confirmedStat.isDirectory() ||
		confirmedStat.dev !== pathStat.dev ||
		confirmedStat.ino !== pathStat.ino ||
		canonicalStat.dev !== confirmedStat.dev ||
		canonicalStat.ino !== confirmedStat.ino
	) {
		throw new Error(`Evo-Pi migration source directory changed during validation: ${resolvedPath}`);
	}
	return canonicalPath;
}

async function readDataFile(path: string): Promise<string> {
	const pathStat = await lstat(path);
	if (pathStat.isSymbolicLink()) throw new Error(`Evo-Pi migration refuses symbolic link: ${path}`);
	if (!pathStat.isFile()) throw new Error(`Evo-Pi migration source is not a regular file: ${path}`);
	if ((pathStat.mode & 0o111) !== 0) throw new Error(`Evo-Pi migration refuses executable file: ${path}`);

	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.dev !== pathStat.dev || before.ino !== pathStat.ino) {
			throw new Error(`Evo-Pi migration source changed during validation: ${path}`);
		}
		const content = await handle.readFile();
		const after = await handle.stat();
		if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
			throw new Error(`Evo-Pi migration source changed while it was read: ${path}`);
		}
		return new TextDecoder("utf-8", { fatal: true }).decode(content);
	} catch (error) {
		if (error instanceof TypeError) throw new Error(`Evo-Pi migration source is not valid UTF-8: ${path}`);
		throw error;
	} finally {
		await handle.close();
	}
}

async function copyAsset(
	context: MigrationContext,
	kind: BundleManagedSourceKind,
	sourceRoot: string,
	source: string,
	target: string,
): Promise<void> {
	assertAssetPath(target);
	const canonicalSourceRoot = await canonicalDirectory(sourceRoot, false);
	if (!canonicalSourceRoot) throw new Error(`Evo-Pi migration source directory disappeared: ${sourceRoot}`);
	const resolvedSource = resolve(source);
	const relativePath = relative(canonicalSourceRoot, resolvedSource).split(sep).join("/");
	if (!relativePath || relativePath === ".." || relativePath.startsWith("../")) {
		throw new Error(`Evo-Pi migration source is outside its declared root: ${resolvedSource}`);
	}
	const expectedParent = dirname(resolvedSource);
	if ((await canonicalDirectory(expectedParent, false)) !== expectedParent) {
		throw new Error(`Evo-Pi migration source traverses a symbolic link: ${resolvedSource}`);
	}
	const existing = context.assetsByTarget.get(target);
	if (existing) {
		if (
			existing.sourceRoot === canonicalSourceRoot &&
			existing.relativePath === relativePath &&
			existing.kind === kind
		) {
			return;
		}
		throw new Error(
			`Evo-Pi migration target collision at ${target}: ${join(existing.sourceRoot, existing.relativePath)} and ${resolvedSource}`,
		);
	}
	const content = await readDataFile(resolvedSource);
	if ((await canonicalDirectory(expectedParent, false)) !== expectedParent) {
		throw new Error(`Evo-Pi migration source parent changed while it was read: ${resolvedSource}`);
	}
	const targetPath = join(context.bundleSourceDirectory, target);
	await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
	await atomicWriteFile(targetPath, content);
	const asset = {
		kind,
		sourceRoot: canonicalSourceRoot,
		relativePath,
		targetPath: target,
		sourceSha256: sha256(content),
	} satisfies BundleManagedSource;
	context.assetsByTarget.set(target, asset);
	if (kind === "custom-prompt" || kind === "append-prompt" || kind === "prompt") {
		context.promptPaths.push(target);
	} else if (kind === "skill") {
		context.skillPaths.push(target);
	} else {
		context.memoryPaths.push(target);
	}
}

async function copyOptionalFile(
	context: MigrationContext,
	kind: BundleManagedSourceKind,
	sourceRoot: string,
	source: string,
	target: string,
): Promise<boolean> {
	try {
		await lstat(source);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return false;
		throw error;
	}
	await copyAsset(context, kind, sourceRoot, source, target);
	return true;
}

async function copyMarkdownDirectory(
	context: MigrationContext,
	kind: "prompt" | "memory" | "preference",
	directory: string,
): Promise<void> {
	const resolvedDirectory = await canonicalDirectory(directory, false);
	if (!resolvedDirectory) throw new Error(`Evo-Pi migration source directory disappeared: ${directory}`);
	const entries = (await readdir(resolvedDirectory, { withFileTypes: true })).sort((left, right) =>
		left.name.localeCompare(right.name),
	);
	for (const entry of entries) {
		const source = join(resolvedDirectory, entry.name);
		const entryStat = await lstat(source);
		if (entryStat.isSymbolicLink()) throw new Error(`Evo-Pi migration refuses symbolic link: ${source}`);
		if (!entryStat.isFile() || !entry.name.endsWith(".md")) {
			throw new Error(`Evo-Pi migration ${kind} directory may contain only direct Markdown files: ${source}`);
		}
		const targetDirectory = kind === "prompt" ? "prompts" : "memory";
		await copyAsset(context, kind, resolvedDirectory, source, `${targetDirectory}/${entry.name}`);
	}
}

async function discoverSkillFiles(directory: string, includeRootFiles: boolean): Promise<string[]> {
	const canonicalSkillDirectory = await canonicalDirectory(directory, false);
	if (!canonicalSkillDirectory) throw new Error(`Evo-Pi skill directory disappeared: ${directory}`);
	const entries = (await readdir(canonicalSkillDirectory, { withFileTypes: true })).sort((left, right) =>
		left.name.localeCompare(right.name),
	);
	const skillEntry = entries.find((entry) => entry.name === "SKILL.md");
	if (skillEntry) {
		const skillPath = join(canonicalSkillDirectory, skillEntry.name);
		const skillStat = await lstat(skillPath);
		if (skillStat.isSymbolicLink()) throw new Error(`Evo-Pi migration refuses symbolic link: ${skillPath}`);
		if (!skillStat.isFile()) throw new Error(`Evo-Pi migration SKILL.md is not a regular file: ${skillPath}`);
		if (entries.length !== 1) {
			throw new Error(`Evo-Pi migration refuses non-data skill support files in: ${canonicalSkillDirectory}`);
		}
		return [skillPath];
	}

	const result: string[] = [];
	for (const entry of entries) {
		const source = join(canonicalSkillDirectory, entry.name);
		const entryStat = await lstat(source);
		if (entryStat.isSymbolicLink()) throw new Error(`Evo-Pi migration refuses symbolic link: ${source}`);
		if (entryStat.isDirectory()) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") {
				throw new Error(`Evo-Pi migration refuses hidden or dependency directory in skills: ${source}`);
			}
			result.push(...(await discoverSkillFiles(source, false)));
			continue;
		}
		if (entryStat.isFile() && includeRootFiles && entry.name.endsWith(".md")) {
			result.push(source);
			continue;
		}
		throw new Error(`Evo-Pi migration skill source contains an unsupported or code file: ${source}`);
	}
	return result;
}

async function copySkillDirectory(context: MigrationContext, directory: string): Promise<void> {
	const resolvedDirectory = await canonicalDirectory(directory, false);
	if (!resolvedDirectory) throw new Error(`Evo-Pi migration source directory disappeared: ${directory}`);
	const discovered = (await discoverSkillFiles(resolvedDirectory, true)).map((path) => resolve(path)).sort();
	const loaded = loadSkills({
		cwd: resolvedDirectory,
		agentDir: resolvedDirectory,
		skillPaths: [resolvedDirectory],
		includeDefaults: false,
	});
	if (loaded.diagnostics.length > 0) {
		const detail = loaded.diagnostics.map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`).join("; ");
		throw new Error(`Evo-Pi migration refuses invalid or ambiguous skills: ${detail}`);
	}
	const loadedPaths = loaded.skills.map((skill) => resolve(skill.filePath)).sort();
	if (loadedPaths.join("\n") !== discovered.join("\n")) {
		throw new Error(`Evo-Pi migration could not safely and completely discover skills in: ${resolvedDirectory}`);
	}
	for (const skill of loaded.skills.sort((left, right) => left.name.localeCompare(right.name))) {
		await copyAsset(context, "skill", resolvedDirectory, skill.filePath, `skills/${skill.name}/SKILL.md`);
	}
}

async function copyConventionalAgentData(context: MigrationContext, agentDirectory: string): Promise<void> {
	const resolvedAgentDirectory = await canonicalDirectory(agentDirectory, false);
	if (!resolvedAgentDirectory) throw new Error(`Evo-Pi agent directory disappeared: ${agentDirectory}`);
	await copyOptionalFile(
		context,
		"custom-prompt",
		resolvedAgentDirectory,
		join(resolvedAgentDirectory, "SYSTEM.md"),
		"prompts/system.md",
	);
	await copyOptionalFile(
		context,
		"append-prompt",
		resolvedAgentDirectory,
		join(resolvedAgentDirectory, "APPEND_SYSTEM.md"),
		"prompts/append-system.md",
	);

	for (const name of GLOBAL_CONTEXT_FILES) {
		if (
			await copyOptionalFile(
				context,
				"context",
				resolvedAgentDirectory,
				join(resolvedAgentDirectory, name),
				"memory/global-context.md",
			)
		) {
			break;
		}
	}

	const conventionalSkills = join(resolvedAgentDirectory, "skills");
	const canonicalSkills = await canonicalDirectory(conventionalSkills, true);
	if (canonicalSkills) await copySkillDirectory(context, canonicalSkills);
}

export function inferAgentDirectoryForEvoRoot(evoRoot: string): string | undefined {
	const resolvedRoot = resolve(evoRoot);
	return basename(resolvedRoot) === "evo" ? dirname(resolvedRoot) : undefined;
}

export async function migratePiDataToBundleSource(options: {
	bundleSourceDirectory: string;
	sources?: EvoBundleMigrationOptions;
	defaultAgentDirectory?: string;
}): Promise<EvoBundleMigrationResult> {
	const bundleSourceDirectory = await canonicalDirectory(options.bundleSourceDirectory, false);
	if (!bundleSourceDirectory) {
		throw new Error(`Evo-Pi bundle source directory disappeared: ${options.bundleSourceDirectory}`);
	}
	const context: MigrationContext = {
		bundleSourceDirectory,
		assetsByTarget: new Map(),
		promptPaths: [],
		skillPaths: [],
		memoryPaths: [],
	};
	const sources = options.sources ?? {};
	const agentDirectory = sources.agentDirectory ?? options.defaultAgentDirectory;
	if (agentDirectory) await copyConventionalAgentData(context, agentDirectory);
	for (const directory of sources.systemPromptDirectories ?? []) {
		await copyMarkdownDirectory(context, "prompt", directory);
	}
	for (const directory of sources.skillDirectories ?? []) await copySkillDirectory(context, directory);
	for (const directory of sources.memoryDirectories ?? []) {
		await copyMarkdownDirectory(context, "memory", directory);
	}
	for (const directory of sources.preferenceDirectories ?? []) {
		await copyMarkdownDirectory(context, "preference", directory);
	}
	return {
		assets: [...context.assetsByTarget.values()],
		promptPaths: context.promptPaths,
		skillPaths: context.skillPaths,
		memoryPaths: context.memoryPaths,
	};
}
