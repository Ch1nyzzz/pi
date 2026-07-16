import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	computeEvoPackIntegrity,
	loadEvoPack,
	parseEvoPackManifest,
	verifyEvoPackIntegrity,
} from "../src/pack/pack.ts";

function baseManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		packFormat: 1,
		name: "better-git-workflow",
		version: "1.0.0",
		author: "friend",
		description: "test pack",
		contents: {
			prompts: [{ target: "append-system", file: "prompts/git.md" }],
			skills: [{ name: "git-triage", dir: "skills/git-triage" }],
		},
		requiresAbis: [],
		requiresCapabilities: [],
		...overrides,
	};
}

describe("parseEvoPackManifest", () => {
	it("parses a valid manifest and defaults empty content arrays", () => {
		const m = parseEvoPackManifest(baseManifest());
		expect(m.name).toBe("better-git-workflow");
		expect(m.contents.prompts).toHaveLength(1);
		expect(m.contents.skills[0].name).toBe("git-triage");
		expect(m.contents.components).toEqual([]);
		expect(m.contents.workflows).toEqual([]);
	});

	it("parses component and workflow parts with capabilities", () => {
		const m = parseEvoPackManifest(
			baseManifest({
				contents: {
					components: [
						{
							surface: "tool",
							abi: "tool/v1",
							id: "git-blame",
							artifact: "components/git-blame",
							capabilities: ["read-file"],
						},
					],
					workflows: [
						{
							id: "deep-review",
							trigger: "/deep-review",
							abi: "workflow/v1",
							artifact: "workflows/deep-review",
							capabilities: ["spawn-agent"],
						},
					],
				},
				requiresAbis: ["tool/v1", "workflow/v1"],
				requiresCapabilities: ["read-file", "spawn-agent"],
			}),
		);
		expect(m.contents.components[0].abi).toBe("tool/v1");
		expect(m.contents.workflows[0].trigger).toBe("/deep-review");
		expect(m.requiresCapabilities).toContain("spawn-agent");
	});

	it("fails closed on wrong packFormat", () => {
		expect(() => parseEvoPackManifest(baseManifest({ packFormat: 2 }))).toThrow(/packFormat/);
	});

	it("rejects an invalid name", () => {
		expect(() => parseEvoPackManifest(baseManifest({ name: "Bad Name!" }))).toThrow(/name/);
	});

	it("rejects a path-traversal file reference", () => {
		expect(() =>
			parseEvoPackManifest(
				baseManifest({ contents: { prompts: [{ target: "system", file: "../../etc/passwd" }] } }),
			),
		).toThrow(/\.\./);
	});

	it("rejects backslashes and non-canonical relative paths", () => {
		for (const file of ["prompts\\git.md", "prompts/./git.md", "prompts//git.md", "prompts/git.md/"]) {
			expect(() =>
				parseEvoPackManifest(baseManifest({ contents: { prompts: [{ target: "system", file }] } })),
			).toThrow(/forward slashes|canonical relative path/);
		}
	});

	it("rejects an absolute artifact path", () => {
		expect(() =>
			parseEvoPackManifest(
				baseManifest({
					contents: {
						components: [{ surface: "tool", abi: "tool/v1", id: "x", artifact: "/abs/path", capabilities: [] }],
					},
				}),
			),
		).toThrow(/relative/);
	});

	it("rejects a malformed trigger", () => {
		expect(() =>
			parseEvoPackManifest(
				baseManifest({
					contents: {
						workflows: [
							{ id: "x", trigger: "deep-review", abi: "workflow/v1", artifact: "workflows/x", capabilities: [] },
						],
					},
				}),
			),
		).toThrow(/trigger/);
	});

	it("rejects duplicate capabilities", () => {
		expect(() =>
			parseEvoPackManifest(
				baseManifest({
					contents: {
						components: [
							{
								surface: "tool",
								abi: "tool/v1",
								id: "x",
								artifact: "components/x",
								capabilities: ["read-file", "read-file"],
							},
						],
					},
				}),
			),
		).toThrow(/duplicate/);
	});

	it("rejects unknown manifest and content keys", () => {
		expect(() => parseEvoPackManifest(baseManifest({ surprise: true }))).toThrow(/unknown key/);
		expect(() =>
			parseEvoPackManifest(
				baseManifest({
					contents: {
						prompts: [{ target: "system", file: "prompts/git.md", surprise: true }],
					},
				}),
			),
		).toThrow(/unknown key/);
	});

	it("requires ABI and capability summaries to exactly match code parts", () => {
		const contents = {
			components: [
				{
					surface: "context",
					abi: "context/v1",
					id: "pruner",
					artifact: "components/pruner",
					capabilities: ["infer"],
				},
			],
		};
		expect(() => parseEvoPackManifest(baseManifest({ contents }))).toThrow(/requiresAbis/);
		expect(() =>
			parseEvoPackManifest(
				baseManifest({
					contents,
					requiresAbis: ["context/v1"],
					requiresCapabilities: [],
				}),
			),
		).toThrow(/requiresCapabilities/);
	});
});

describe("pack integrity", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "evo-pack-"));
		await mkdir(join(dir, "prompts"), { recursive: true });
		await mkdir(join(dir, "skills", "git-triage"), { recursive: true });
		await writeFile(join(dir, "prompts", "git.md"), "prefer small commits\n");
		await writeFile(join(dir, "skills", "git-triage", "SKILL.md"), "# git triage\n");
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("computes a stable content-addressed integrity", async () => {
		const manifest = parseEvoPackManifest(baseManifest());
		const a = await computeEvoPackIntegrity(dir, manifest);
		const b = await computeEvoPackIntegrity(dir, manifest);
		expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(a).toBe(b);
	});

	it("verifies a matching declared integrity and rejects a mismatch", async () => {
		const manifest = parseEvoPackManifest(baseManifest());
		const integrity = await computeEvoPackIntegrity(dir, manifest);
		const withIntegrity = parseEvoPackManifest(baseManifest({ integrity }));

		const ok = await verifyEvoPackIntegrity(dir, withIntegrity);
		expect(ok.ok).toBe(true);

		// Mutating a referenced file breaks integrity.
		await writeFile(join(dir, "prompts", "git.md"), "tampered\n");
		const broken = await verifyEvoPackIntegrity(dir, withIntegrity);
		expect(broken.ok).toBe(false);
		expect(broken.expected).toBe(integrity);
		expect(broken.actual).not.toBe(integrity);
	});

	it("loadEvoPack parses and integrity-checks pack.json from disk", async () => {
		const manifest = parseEvoPackManifest(baseManifest());
		const integrity = await computeEvoPackIntegrity(dir, manifest);
		await writeFile(join(dir, "pack.json"), JSON.stringify(baseManifest({ integrity }), null, 2));

		const loaded = await loadEvoPack(dir);
		expect(loaded.manifest.name).toBe("better-git-workflow");
		expect(loaded.integrity.ok).toBe(true);
	});

	it("rejects direct-file and directory-root symlinks", async () => {
		const outside = join(dir, "outside.md");
		await writeFile(outside, "outside\n");
		await rm(join(dir, "prompts", "git.md"));
		await symlink(outside, join(dir, "prompts", "git.md"));
		await expect(computeEvoPackIntegrity(dir, parseEvoPackManifest(baseManifest()))).rejects.toThrow(/symlink/);

		await rm(join(dir, "prompts", "git.md"));
		await writeFile(join(dir, "prompts", "git.md"), "restored\n");
		await rm(join(dir, "skills", "git-triage"), { recursive: true });
		await symlink(join(dir, "prompts"), join(dir, "skills", "git-triage"));
		await expect(computeEvoPackIntegrity(dir, parseEvoPackManifest(baseManifest()))).rejects.toThrow(/symlink/);
	});
});
