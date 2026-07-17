import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deterministicPreferenceId } from "../src/memory/preferences.ts";
import { buildPackDataChanges } from "../src/pack/import.ts";
import { parseEvoPackManifest } from "../src/pack/pack.ts";

describe("buildPackDataChanges", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "evo-pack-import-"));
		await mkdir(join(dir, "prompts"), { recursive: true });
		await mkdir(join(dir, "skills", "git-triage"), { recursive: true });
		await mkdir(join(dir, "memory"), { recursive: true });
		await writeFile(join(dir, "prompts", "git.md"), "prefer small commits\n");
		await writeFile(join(dir, "skills", "git-triage", "SKILL.md"), "# git triage\n");
		await writeFile(
			join(dir, "memory", "preferences.json"),
			`${JSON.stringify(
				{
					schemaVersion: 1,
					preferences: [
						{
							id: deterministicPreferenceId("Prefer small commits."),
							instruction: "Prefer small commits.",
							source: { sessionId: "source-session", sequence: 1, quote: "Prefer small commits." },
							addedAt: "2026-07-15T00:00:00.000Z",
						},
					],
				},
				undefined,
				"\t",
			)}\n`,
		);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	function manifest(overrides: Record<string, unknown> = {}) {
		return parseEvoPackManifest({
			packFormat: 1,
			name: "better-git-workflow",
			version: "1.0.0",
			contents: {
				prompts: [{ target: "append-system", file: "prompts/git.md" }],
				skills: [{ name: "git-triage", dir: "skills/git-triage" }],
			},
			requiresAbis: [],
			requiresCapabilities: [],
			...overrides,
		});
	}

	it("maps skills to skills/<name>/SKILL.md with file content", async () => {
		const result = await buildPackDataChanges(dir, manifest());
		const skill = result.changes.find((c) => c.path === "skills/git-triage/SKILL.md");
		expect(skill).toBeDefined();
		expect(skill?.content).toBe("# git triage\n");
		expect(result.addedSkillPaths).toEqual(["skills/git-triage/SKILL.md"]);
	});

	it("maps prompts to uniquely-named prompts/<name>.md assets", async () => {
		const result = await buildPackDataChanges(dir, manifest());
		expect(result.addedPromptPaths).toHaveLength(1);
		const p = result.addedPromptPaths[0];
		expect(p).toMatch(/^prompts\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/);
		expect(result.changes.find((c) => c.path === p)?.content).toBe("prefer small commits\n");
	});

	it("merges structured memory and replaces foreign session provenance with pack provenance", async () => {
		const result = await buildPackDataChanges(
			dir,
			manifest({
				contents: {
					prompts: [{ target: "append-system", file: "prompts/git.md" }],
					skills: [{ name: "git-triage", dir: "skills/git-triage" }],
					memory: [{ file: "memory/preferences.json" }],
				},
			}),
		);
		expect(result.addedMemoryPreferences).toBe(1);
		const change = result.changes.find((entry) => entry.path === "memory/preferences.json");
		expect(change?.content).toBeDefined();
		const memory = JSON.parse(change?.content ?? "") as {
			preferences: Array<{ instruction: string; source: Record<string, unknown> }>;
		};
		expect(memory.preferences).toEqual([
			expect.objectContaining({
				instruction: "Prefer small commits.",
				source: expect.objectContaining({
					packName: "better-git-workflow",
					packVersion: "1.0.0",
					file: "memory/preferences.json",
					integrity: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
				}),
			}),
		]);
	});

	it("preserves active preferences and rejects conflicting imported ids", async () => {
		const parent = {
			schemaVersion: 1 as const,
			preferences: [
				{
					id: deterministicPreferenceId("Prefer small commits."),
					instruction: "Use large commits.",
					source: { sessionId: "active-session", sequence: 1, quote: "Use large commits." },
					addedAt: "2026-07-14T00:00:00.000Z",
				},
			],
		};
		await expect(
			buildPackDataChanges(dir, manifest({ contents: { memory: [{ file: "memory/preferences.json" }] } }), parent),
		).rejects.toThrow(/id conflicts/);
	});

	it("produces unique prompt asset names for multiple prompts", async () => {
		await writeFile(join(dir, "prompts", "b.md"), "second\n");
		const result = await buildPackDataChanges(
			dir,
			manifest({
				contents: {
					prompts: [
						{ target: "append-system", file: "prompts/git.md" },
						{ target: "append-system", file: "prompts/b.md" },
					],
					skills: [],
				},
			}),
		);
		const paths = result.addedPromptPaths;
		expect(paths).toHaveLength(2);
		expect(new Set(paths).size).toBe(2);
	});
});
