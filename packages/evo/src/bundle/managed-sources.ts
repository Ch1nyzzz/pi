import { constants, realpathSync } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
	type BeforeAgentStartEvent,
	type BuildSystemPromptOptions,
	buildSystemPrompt,
	loadSkills,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import { sha256 } from "../storage.ts";
import type { BundleManagedSource, CompiledBundle } from "../types.ts";

export interface ManagedRuntimeResources {
	targetContents: ReadonlyMap<string, string>;
	skills: readonly Skill[];
}

export interface ManagedPromptReplacement {
	systemPrompt: string;
	excludedTargets: ReadonlySet<string>;
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

function managedSourcePath(source: BundleManagedSource): string {
	return join(source.sourceRoot, ...source.relativePath.split("/"));
}

async function readManagedSourceIfPresent(source: BundleManagedSource): Promise<string | undefined> {
	let canonicalRoot: string;
	try {
		canonicalRoot = await realpath(source.sourceRoot);
	} catch (error) {
		if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return undefined;
		throw error;
	}
	if (canonicalRoot !== source.sourceRoot) {
		throw new Error(`Evo-Pi managed source root is no longer canonical: ${source.sourceRoot}`);
	}

	const path = managedSourcePath(source);
	let pathStat: Awaited<ReturnType<typeof lstat>>;
	try {
		pathStat = await lstat(path);
	} catch (error) {
		if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return undefined;
		throw error;
	}
	if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
		throw new Error(`Evo-Pi managed source is no longer a regular file: ${path}`);
	}
	if ((pathStat.mode & 0o111) !== 0) {
		throw new Error(`Evo-Pi managed source became executable: ${path}`);
	}
	if ((await realpath(path)) !== path) {
		throw new Error(`Evo-Pi managed source now traverses a symbolic link: ${path}`);
	}

	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.dev !== pathStat.dev || before.ino !== pathStat.ino) {
			throw new Error(`Evo-Pi managed source changed during validation: ${path}`);
		}
		const bytes = await handle.readFile();
		const after = await handle.stat();
		if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
			throw new Error(`Evo-Pi managed source changed while it was read: ${path}`);
		}
		try {
			return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch (error) {
			if (error instanceof TypeError) {
				throw new Error(`Evo-Pi managed source is not valid UTF-8: ${path}`);
			}
			throw error;
		}
	} finally {
		await handle.close();
	}
}

export async function verifyManagedSourceSnapshots(sources: readonly BundleManagedSource[]): Promise<void> {
	for (const source of sources) {
		const content = await readManagedSourceIfPresent(source);
		if (content !== undefined && sha256(content) !== source.sourceSha256) {
			throw new Error(`Evo-Pi managed source drifted outside the registry: ${managedSourcePath(source)}`);
		}
	}
}

function normalizeRelativePath(path: string): string {
	return path.split(sep).join("/");
}

export async function prepareManagedRuntimeResources(bundle: CompiledBundle): Promise<ManagedRuntimeResources> {
	const targetContents = new Map<string, string>();
	for (const source of bundle.policy.managedSources ?? []) {
		if (targetContents.has(source.targetPath)) continue;
		targetContents.set(source.targetPath, await readFile(join(bundle.directory, source.targetPath), "utf8"));
	}

	const expectedSkillPaths = bundle.manifest.files
		.map((file) => file.path)
		.filter((path) => path.startsWith("skills/"))
		.sort();
	if (expectedSkillPaths.length === 0) return { targetContents, skills: [] };

	const skillDirectory = join(bundle.directory, "skills");
	const loaded = loadSkills({
		cwd: bundle.directory,
		agentDir: bundle.directory,
		skillPaths: [skillDirectory],
		includeDefaults: false,
	});
	if (loaded.diagnostics.length > 0) {
		const detail = loaded.diagnostics.map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`).join("; ");
		throw new Error(`Evo-Pi bundle contains invalid or ambiguous skills: ${detail}`);
	}
	const actualSkillPaths = loaded.skills
		.map((skill) => normalizeRelativePath(relative(bundle.directory, resolve(skill.filePath))))
		.sort();
	if (actualSkillPaths.join("\n") !== expectedSkillPaths.join("\n")) {
		throw new Error("Evo-Pi bundle skill discovery did not match its manifest");
	}
	return { targetContents, skills: loaded.skills };
}

function targetContent(resources: ManagedRuntimeResources, source: BundleManagedSource): string {
	const content = resources.targetContents.get(source.targetPath);
	if (content === undefined) {
		throw new Error(`Evo-Pi managed target was not prepared: ${source.targetPath}`);
	}
	return content;
}

function pathMatchesSource(path: string, source: BundleManagedSource): boolean {
	const expected = managedSourcePath(source);
	const resolved = resolve(path);
	if (resolved === expected) return true;
	try {
		return realpathSync(resolved) === expected;
	} catch {
		return false;
	}
}

function replaceAssembledBase(current: string, original: string, replacement: string): string {
	const index = current.indexOf(original);
	if (index === -1 || index !== current.lastIndexOf(original)) return replacement;
	return current.slice(0, index) + replacement + current.slice(index + original.length);
}

export function replaceManagedHostResources(options: {
	event: Pick<BeforeAgentStartEvent, "systemPrompt" | "systemPromptOptions">;
	bundle: CompiledBundle;
	resources: ManagedRuntimeResources;
}): ManagedPromptReplacement {
	const sources = options.bundle.policy.managedSources ?? [];
	if (sources.length === 0) {
		return { systemPrompt: options.event.systemPrompt, excludedTargets: new Set() };
	}

	const excludedTargets = new Set<string>();
	const originalOptions = options.event.systemPromptOptions;
	const managedOptions: BuildSystemPromptOptions = { ...originalOptions };
	const customPrompt = sources.find((source) => source.kind === "custom-prompt");
	if (
		customPrompt &&
		(originalOptions.customPrompt === undefined || sha256(originalOptions.customPrompt) === customPrompt.sourceSha256)
	) {
		managedOptions.customPrompt = targetContent(options.resources, customPrompt);
		excludedTargets.add(customPrompt.targetPath);
	}
	const appendPrompt = sources.find((source) => source.kind === "append-prompt");
	if (
		appendPrompt &&
		(originalOptions.appendSystemPrompt === undefined ||
			sha256(originalOptions.appendSystemPrompt) === appendPrompt.sourceSha256)
	) {
		managedOptions.appendSystemPrompt = targetContent(options.resources, appendPrompt);
		excludedTargets.add(appendPrompt.targetPath);
	}

	const contextSources = sources.filter((source) => source.kind === "context");
	const usedContextTargets = new Set<string>();
	const contextFiles = (originalOptions.contextFiles ?? []).map((file) => {
		const source = contextSources.find((candidate) => pathMatchesSource(file.path, candidate));
		if (!source) return file;
		usedContextTargets.add(source.targetPath);
		excludedTargets.add(source.targetPath);
		return {
			path: join(options.bundle.directory, source.targetPath),
			content: targetContent(options.resources, source),
		};
	});
	for (const source of contextSources) {
		if (usedContextTargets.has(source.targetPath)) continue;
		excludedTargets.add(source.targetPath);
		contextFiles.push({
			path: join(options.bundle.directory, source.targetPath),
			content: targetContent(options.resources, source),
		});
	}
	managedOptions.contextFiles = contextFiles;

	const managedSkillSources = sources.filter((source) => source.kind === "skill");
	const bundleSkillPaths = new Set(options.resources.skills.map((skill) => resolve(skill.filePath)));
	const bundleSkillNames = new Set(options.resources.skills.map((skill) => skill.name));
	managedOptions.skills = [
		...(originalOptions.skills ?? []).filter(
			(skill) =>
				!managedSkillSources.some((source) => pathMatchesSource(skill.filePath, source)) &&
				!bundleSkillPaths.has(resolve(skill.filePath)) &&
				!bundleSkillNames.has(skill.name),
		),
		...options.resources.skills,
	];

	const originalBase = buildSystemPrompt(originalOptions);
	const managedBase = buildSystemPrompt(managedOptions);
	return {
		systemPrompt: replaceAssembledBase(options.event.systemPrompt, originalBase, managedBase),
		excludedTargets,
	};
}
