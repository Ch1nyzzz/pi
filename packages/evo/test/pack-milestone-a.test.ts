import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compileBundle, materializeBundle } from "../src/bundle/compile.ts";
import { importPackData } from "../src/pack/import.ts";
import { computeEvoPackIntegrity, parseEvoPackManifest } from "../src/pack/pack.ts";
import { ensureEvoLayout, getEvoPaths } from "../src/paths.ts";

/**
 * Milestone A: `evo-pi import ./pack` installs a pack's data parts into the
 * bundle end-to-end — verify integrity, stage a data proposal against the stable
 * bundle, and confirm the candidate bundle actually contains the imported skill
 * and prompt.
 */
describe("Milestone A: data pack import end-to-end", () => {
	let root: string;
	let packDir: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "evo-root-"));
		packDir = await mkdtemp(join(tmpdir(), "evo-pack-a-"));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
		await rm(packDir, { recursive: true, force: true });
	});

	async function seedBundle(): Promise<{ paths: ReturnType<typeof getEvoPaths>; digest: string }> {
		const paths = getEvoPaths(root);
		await ensureEvoLayout(paths);
		const seedDir = await mkdtemp(join(root, ".seed-"));
		await writeFile(
			join(seedDir, "policy.json"),
			JSON.stringify({
				schemaVersion: 1,
				enabledFeatures: [],
				coreAssets: [],
				modelRouting: {},
				validation: { requiredChecks: [] },
			}),
		);
		const bundle = await compileBundle({
			paths,
			sourceDirectory: seedDir,
			parentDigest: null,
			summary: "test seed bundle",
		});
		await rm(seedDir, { recursive: true, force: true });
		return { paths, digest: bundle.digest };
	}

	async function writePack(): Promise<void> {
		await mkdir(join(packDir, "prompts"), { recursive: true });
		await mkdir(join(packDir, "skills", "git-triage"), { recursive: true });
		await writeFile(join(packDir, "prompts", "git.md"), "prefer small, reviewable commits\n");
		await writeFile(
			join(packDir, "skills", "git-triage", "SKILL.md"),
			"# git triage\n\nTriage git state before acting.\n",
		);
		const base = {
			packFormat: 1,
			name: "better-git-workflow",
			version: "1.0.0",
			contents: {
				prompts: [{ target: "append-system", file: "prompts/git.md" }],
				skills: [{ name: "git-triage", dir: "skills/git-triage" }],
			},
			requiresAbis: [],
			requiresCapabilities: [],
		};
		const integrity = await computeEvoPackIntegrity(packDir, parseEvoPackManifest(base));
		await writeFile(join(packDir, "pack.json"), JSON.stringify({ ...base, integrity }, null, 2));
	}

	it("stages a data proposal whose candidate bundle contains the imported skill and prompt", async () => {
		const { paths, digest } = await seedBundle();
		await writePack();

		const result = await importPackData({ paths, parentDigest: digest, packDir });

		expect(result.proposal).toBeDefined();
		expect(result.addedSkillPaths).toEqual(["skills/git-triage/SKILL.md"]);
		expect(result.addedPromptPaths).toHaveLength(1);
		expect(result.skippedCode).toBe(0);

		// The candidate bundle must actually carry the imported assets.
		const candidateDigest = result.proposal?.candidateDigest;
		expect(candidateDigest).toBeDefined();
		const out = await mkdtemp(join(root, ".candidate-"));
		await materializeBundle(paths, candidateDigest as string, out);
		const skill = await readFile(join(out, "skills", "git-triage", "SKILL.md"), "utf8");
		expect(skill).toContain("git triage");
		const promptPath = result.addedPromptPaths[0];
		const prompt = await readFile(join(out, promptPath), "utf8");
		expect(prompt).toContain("reviewable commits");
	});

	it("rejects a tampered pack (integrity mismatch)", async () => {
		const { paths, digest } = await seedBundle();
		await writePack();
		// Tamper with a referenced file after integrity was computed.
		await writeFile(join(packDir, "prompts", "git.md"), "tampered\n");

		await expect(importPackData({ paths, parentDigest: digest, packDir })).rejects.toThrow(/integrity/);
	});
});
