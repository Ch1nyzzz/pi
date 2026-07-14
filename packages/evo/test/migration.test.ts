import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileBundle } from "../src/bundle/compile.ts";
import { parseBundlePolicy } from "../src/bundle/schema.ts";
import { getEvoPaths } from "../src/paths.ts";
import { EvoService } from "../src/service.ts";

const SKILL = `---
name: review
description: Review a change without executing code.
---

# Review

Read the diff and report risks.
`;

describe("Evo-Pi initial data migration", () => {
	const temporaryDirectories: string[] = [];

	afterEach(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
		);
	});

	async function createTemporaryDirectory(): Promise<string> {
		const directory = await mkdtemp(join(tmpdir(), "pi-evo-migration-"));
		temporaryDirectories.push(directory);
		return directory;
	}

	it("migrates conventional agent data with verifiable managed-source metadata", async () => {
		const temporaryDirectory = await createTemporaryDirectory();
		const agentDirectory = join(temporaryDirectory, "agent");
		await mkdir(join(agentDirectory, "skills", "review"), { recursive: true });
		await mkdir(join(agentDirectory, "prompts"), { recursive: true });
		await writeFile(join(agentDirectory, "SYSTEM.md"), "Use the custom worker contract.\n");
		await writeFile(join(agentDirectory, "APPEND_SYSTEM.md"), "Append the local verification rules.\n");
		await writeFile(join(agentDirectory, "AGENTS.md"), "Prefer concise technical prose.\n");
		await writeFile(join(agentDirectory, "skills", "review", "SKILL.md"), SKILL);
		await writeFile(join(agentDirectory, "prompts", "slash-only.md"), "This is a slash prompt template.\n");

		const service = new EvoService(getEvoPaths(join(agentDirectory, "evo")));
		const seed = await service.init(["write", "read", "read"]);

		expect(seed.manifest.summary).toBe("Initial Evo-Pi data bundle migrated from Pi resources");
		expect(seed.manifest.files.map((file) => file.path)).toEqual([
			"policy.json",
			"memory/global-context.md",
			"prompts/append-system.md",
			"prompts/system.md",
			"skills/review/SKILL.md",
		]);
		expect(seed.policy).toMatchObject({
			enabledTools: ["read", "write"],
			promptOrder: ["prompts/system.md", "prompts/append-system.md"],
			stablePromptPaths: ["prompts/system.md", "prompts/append-system.md"],
			coreAssets: ["prompts/system.md", "prompts/append-system.md"],
		});
		expect(seed.policy.managedSources?.map((source) => source.kind)).toEqual([
			"custom-prompt",
			"append-prompt",
			"context",
			"skill",
		]);
		expect(seed.policy.managedSources?.map((source) => source.sourceRoot)).toEqual([
			agentDirectory,
			agentDirectory,
			agentDirectory,
			join(agentDirectory, "skills"),
		]);
		expect(seed.policy.managedSources?.map((source) => source.relativePath)).toEqual([
			"SYSTEM.md",
			"APPEND_SYSTEM.md",
			"AGENTS.md",
			"review/SKILL.md",
		]);
		const manifestByPath = new Map(seed.manifest.files.map((file) => [file.path, file.sha256]));
		for (const source of seed.policy.managedSources ?? []) {
			expect(source.sourceSha256).toBe(manifestByPath.get(source.targetPath));
		}
		expect(await readFile(join(seed.directory, "prompts", "system.md"), "utf8")).toBe(
			"Use the custom worker contract.\n",
		);
		expect(seed.manifest.files.some((file) => file.path.includes("slash-only"))).toBe(false);

		await writeFile(join(agentDirectory, "SYSTEM.md"), "A changed host prompt must not mutate the seed.\n");
		await writeFile(join(agentDirectory, "skills", "review", "helper.ts"), "export const unsafe = true;\n");
		const repeated = await service.init();
		expect(repeated.digest).toBe(seed.digest);
		expect(await readFile(join(repeated.directory, "prompts", "system.md"), "utf8")).toBe(
			"Use the custom worker contract.\n",
		);
	});

	it("imports explicitly selected prompt, skill, memory, and preference directories", async () => {
		const temporaryDirectory = await createTemporaryDirectory();
		const prompts = join(temporaryDirectory, "prompt-fragments");
		const skills = join(temporaryDirectory, "selected-skills");
		const memory = join(temporaryDirectory, "memory-source");
		const preferences = join(temporaryDirectory, "preference-source");
		await Promise.all([prompts, skills, memory, preferences].map((directory) => mkdir(directory)));
		await writeFile(join(prompts, "workflow.md"), "Use the selected workflow.\n");
		await writeFile(join(skills, "review.md"), SKILL);
		await writeFile(join(memory, "project.md"), "The long-lived project is Orion.\n");
		await writeFile(join(preferences, "style.md"), "Prefer direct answers.\n");

		const service = new EvoService(getEvoPaths(join(temporaryDirectory, "state")));
		const seed = await service.init(undefined, {
			systemPromptDirectories: [prompts],
			skillDirectories: [skills],
			memoryDirectories: [memory],
			preferenceDirectories: [preferences],
		});

		expect(seed.manifest.files.map((file) => file.path)).toEqual([
			"policy.json",
			"memory/project.md",
			"memory/style.md",
			"prompts/workflow.md",
			"skills/review/SKILL.md",
		]);
		expect(seed.policy.managedSources?.map((source) => source.kind)).toEqual([
			"prompt",
			"skill",
			"memory",
			"preference",
		]);
		expect(seed.policy.coreAssets).toEqual([]);
	});

	it("rejects symbolic links without initializing the registry", async () => {
		const temporaryDirectory = await createTemporaryDirectory();
		const memory = join(temporaryDirectory, "memory");
		await mkdir(memory);
		await writeFile(join(temporaryDirectory, "outside.md"), "Outside data.\n");
		await symlink(join(temporaryDirectory, "outside.md"), join(memory, "linked.md"));
		const service = new EvoService(getEvoPaths(join(temporaryDirectory, "state")));

		await expect(service.init(undefined, { memoryDirectories: [memory] })).rejects.toThrow("symbolic link");
		expect(await service.status()).toMatchObject({ initialized: false });
	});

	it("rejects skill support code instead of silently producing an incomplete skill", async () => {
		const temporaryDirectory = await createTemporaryDirectory();
		const skills = join(temporaryDirectory, "skills");
		await mkdir(join(skills, "review"), { recursive: true });
		await writeFile(join(skills, "review", "SKILL.md"), SKILL);
		await writeFile(join(skills, "review", "helper.ts"), "export const unsafe = true;\n");
		const service = new EvoService(getEvoPaths(join(temporaryDirectory, "state")));

		await expect(service.init(undefined, { skillDirectories: [skills] })).rejects.toThrow(
			"refuses non-data skill support files",
		);
		expect(await service.status()).toMatchObject({ initialized: false });
	});

	it("rejects executable and unsafe Markdown assets", async () => {
		const temporaryDirectory = await createTemporaryDirectory();
		const executablePrompts = join(temporaryDirectory, "executable-prompts");
		const unsafeMemory = join(temporaryDirectory, "unsafe-memory");
		await mkdir(executablePrompts);
		await mkdir(unsafeMemory);
		await writeFile(join(executablePrompts, "run.md"), "Do not execute this file.\n");
		await chmod(join(executablePrompts, "run.md"), 0o755);
		await writeFile(join(unsafeMemory, "bad name.md"), "Unsafe target name.\n");

		const executableService = new EvoService(getEvoPaths(join(temporaryDirectory, "executable-state")));
		await expect(executableService.init(undefined, { systemPromptDirectories: [executablePrompts] })).rejects.toThrow(
			"executable file",
		);

		const unsafeService = new EvoService(getEvoPaths(join(temporaryDirectory, "unsafe-state")));
		await expect(unsafeService.init(undefined, { memoryDirectories: [unsafeMemory] })).rejects.toThrow(
			"disallowed data path",
		);
	});

	it("keeps source digests stable across evolved target contents", async () => {
		const temporaryDirectory = await createTemporaryDirectory();
		const sourceDirectory = join(temporaryDirectory, "bundle-source");
		const sourceRoot = await realpath(temporaryDirectory);
		await mkdir(join(sourceDirectory, "memory"), { recursive: true });
		await writeFile(join(sourceDirectory, "memory", "user.md"), "Evolved target content.\n");
		await writeFile(
			join(sourceDirectory, "policy.json"),
			`${JSON.stringify({
				schemaVersion: 1,
				managedSources: [
					{
						kind: "memory",
						sourceRoot,
						relativePath: "original-user.md",
						targetPath: "memory/user.md",
						sourceSha256: "0".repeat(64),
					},
				],
			})}\n`,
		);

		const bundle = await compileBundle({
			paths: getEvoPaths(join(temporaryDirectory, "state")),
			sourceDirectory,
			parentDigest: null,
			summary: "Evolved managed target",
		});
		expect(bundle.policy.managedSources?.[0]?.sourceSha256).toBe("0".repeat(64));

		expect(() =>
			parseBundlePolicy({
				schemaVersion: 1,
				managedSources: [
					{
						kind: "skill",
						sourceRoot,
						relativePath: "review/SKILL.md",
						targetPath: "memory/user.md",
						sourceSha256: "0".repeat(64),
					},
				],
			}),
		).toThrow("does not match kind skill");
		const physicalSource = {
			sourceRoot,
			relativePath: "SYSTEM.md",
			sourceSha256: "0".repeat(64),
		};
		expect(() =>
			parseBundlePolicy({
				schemaVersion: 1,
				managedSources: [
					{ ...physicalSource, kind: "custom-prompt", targetPath: "prompts/system.md" },
					{ ...physicalSource, kind: "prompt", targetPath: "prompts/duplicate.md" },
				],
			}),
		).toThrow("duplicate source paths");
		expect(() =>
			parseBundlePolicy({
				schemaVersion: 1,
				managedSources: [
					{ ...physicalSource, kind: "custom-prompt", targetPath: "prompts/system.md" },
					{
						...physicalSource,
						kind: "custom-prompt",
						relativePath: "OTHER_SYSTEM.md",
						targetPath: "prompts/other-system.md",
					},
				],
			}),
		).toThrow("at most one custom-prompt");

		const missingTargetSource = join(temporaryDirectory, "missing-target-source");
		await mkdir(missingTargetSource);
		await writeFile(
			join(missingTargetSource, "policy.json"),
			`${JSON.stringify({
				schemaVersion: 1,
				managedSources: [
					{
						kind: "memory",
						sourceRoot,
						relativePath: "missing.md",
						targetPath: "memory/missing.md",
						sourceSha256: "0".repeat(64),
					},
				],
			})}\n`,
		);
		await expect(
			compileBundle({
				paths: getEvoPaths(join(temporaryDirectory, "missing-target-state")),
				sourceDirectory: missingTargetSource,
				parentDigest: null,
				summary: "Invalid missing managed target",
			}),
		).rejects.toThrow("references missing asset");
	});
});
