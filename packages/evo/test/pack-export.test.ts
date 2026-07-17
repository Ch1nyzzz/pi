import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileBundle } from "../src/bundle/compile.ts";
import { publishEvoComponentArtifact } from "../src/components/artifact.ts";
import { deterministicPreferenceId } from "../src/memory/preferences.ts";
import { exportEvoPack } from "../src/pack/export.ts";
import { loadEvoPack } from "../src/pack/pack.ts";
import { getEvoPaths } from "../src/paths.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporary(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	roots.push(directory);
	return directory;
}

describe("optimization pack export", () => {
	it("exports bundle data and a selected component with verified integrity", async () => {
		const root = await temporary("evo-pack-export-");
		const paths = getEvoPaths(join(root, "evo"));
		const artifact = await publishEvoComponentArtifact(paths, {
			id: "context-pruner",
			version: "1.0.0",
			abi: "context/v1",
			activationBoundary: "session",
			capabilities: [],
			entrypointContent: "process.stdin.resume();\n",
		});
		const source = join(root, "bundle-source");
		await mkdir(join(source, "prompts"), { recursive: true });
		await mkdir(join(source, "skills", "review"), { recursive: true });
		await mkdir(join(source, "memory"), { recursive: true });
		await writeFile(join(source, "prompts", "system.md"), "system\n");
		await writeFile(join(source, "skills", "review", "SKILL.md"), "# Review\n");
		await writeFile(join(source, "memory", "notes.md"), "local episodic notes\n");
		await writeFile(
			join(source, "memory", "preferences.json"),
			`${JSON.stringify({
				schemaVersion: 1,
				preferences: [
					{
						id: deterministicPreferenceId("Review focused changes."),
						instruction: "Review focused changes.",
						source: {
							sessionId: "export-session",
							sequence: 1,
							quote: "Review focused changes.",
						},
						addedAt: "2026-07-15T00:00:00.000Z",
					},
				],
			})}\n`,
		);
		await writeFile(
			join(source, "policy.json"),
			`${JSON.stringify(
				{
					schemaVersion: 1,
					components: {
						context: {
							id: artifact.manifest.id,
							abi: artifact.manifest.abi,
							artifactDigest: artifact.manifest.artifactDigest,
							config: {},
						},
					},
				},
				undefined,
				"\t",
			)}\n`,
		);
		const bundle = await compileBundle({
			paths,
			sourceDirectory: source,
			parentDigest: null,
			summary: "pack export fixture",
		});
		const destination = join(root, "exported");

		const manifest = await exportEvoPack({
			paths,
			bundleDigest: bundle.digest,
			targetDirectory: destination,
			name: "exported-bundle",
			version: "1.0.0",
			author: "tester",
		});
		const loaded = await loadEvoPack(destination);

		expect(manifest.integrity).toMatch(/^sha256:/);
		expect(loaded.integrity.ok).toBe(true);
		expect(loaded.manifest.contents.prompts).toEqual([{ target: "system", file: "prompts/system.md" }]);
		expect(loaded.manifest.contents.skills).toEqual([{ name: "review", dir: "skills/review" }]);
		expect(loaded.manifest.contents.memory).toEqual([{ file: "memory/preferences.json" }]);
		expect(loaded.manifest.contents.components[0]).toMatchObject({
			surface: "context",
			abi: "context/v1",
			id: "context-pruner",
		});
	});
});
