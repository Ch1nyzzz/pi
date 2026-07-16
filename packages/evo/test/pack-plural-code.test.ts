import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileBundle, loadCompiledBundle } from "../src/bundle/compile.ts";
import { parseBundlePolicy } from "../src/bundle/schema.ts";
import { publishEvoComponentArtifact } from "../src/components/artifact.ts";
import { exportEvoPack } from "../src/pack/export.ts";
import { importEvoPack } from "../src/pack/import.ts";
import { computeEvoPackIntegrity, loadEvoPack, parseEvoPackManifest } from "../src/pack/pack.ts";
import { type EvoPaths, ensureEvoLayout, getEvoPaths } from "../src/paths.ts";

const roots: string[] = [];
const artifactDigest = "a".repeat(64);

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporary(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	roots.push(directory);
	return directory;
}

async function seedBundle(root: string): Promise<{ paths: EvoPaths; digest: string }> {
	const paths = getEvoPaths(join(root, "evo"));
	await ensureEvoLayout(paths);
	const source = join(root, "seed");
	await mkdir(source);
	await writeFile(join(source, "policy.json"), '{ "schemaVersion": 1 }\n');
	const bundle = await compileBundle({
		paths,
		sourceDirectory: source,
		parentDigest: null,
		summary: "plural pack seed",
	});
	return { paths, digest: bundle.digest };
}

async function copyArtifact(
	packDirectory: string,
	relativeDirectory: string,
	artifact: Awaited<ReturnType<typeof publishEvoComponentArtifact>>,
): Promise<void> {
	const destination = join(packDirectory, relativeDirectory);
	await mkdir(destination, { recursive: true });
	await writeFile(join(destination, "manifest.json"), await readFile(join(artifact.directory, "manifest.json")));
	await writeFile(join(destination, artifact.manifest.entrypoint), await readFile(artifact.entrypoint));
}

async function writePluralCodePack(
	packDirectory: string,
	sourceRoot: string,
	options: { invalidLastDeclaration?: boolean } = {},
): Promise<void> {
	const sourcePaths = getEvoPaths(join(sourceRoot, "pack-source-evo"));
	const definitions = [
		{ id: "read-notes", abi: "tool/v1", activationBoundary: "session" as const, directory: "components/read-notes" },
		{
			id: "summarize-notes",
			abi: "tool/v1",
			activationBoundary: "session" as const,
			directory: "components/summarize-notes",
		},
		{
			id: "deep-review",
			abi: "workflow/v1",
			activationBoundary: "invocation" as const,
			directory: "workflows/deep-review",
		},
		{
			id: "release-check",
			abi: "workflow/v1",
			activationBoundary: "invocation" as const,
			directory: "workflows/release-check",
		},
	];
	for (const definition of definitions) {
		const artifact = await publishEvoComponentArtifact(sourcePaths, {
			id: definition.id,
			version: "1.0.0",
			abi: definition.abi,
			activationBoundary: definition.activationBoundary,
			capabilities: [],
			entrypointContent: "process.stdin.resume();\n",
		});
		await copyArtifact(packDirectory, definition.directory, artifact);
	}
	const unsigned = parseEvoPackManifest({
		packFormat: 1,
		name: "plural-code-parts",
		version: "1.0.0",
		contents: {
			components: [
				{
					surface: "tool",
					abi: "tool/v1",
					id: "read-notes",
					artifact: "components/read-notes",
					capabilities: [],
				},
				{
					surface: "tool",
					abi: "tool/v1",
					id: "summarize-notes",
					artifact: "components/summarize-notes",
					capabilities: [],
				},
			],
			workflows: [
				{
					id: "deep-review",
					trigger: "/deep-review",
					abi: "workflow/v1",
					artifact: "workflows/deep-review",
					capabilities: [],
				},
				{
					id: options.invalidLastDeclaration ? "different-release-check" : "release-check",
					trigger: "/release-check",
					abi: "workflow/v1",
					artifact: "workflows/release-check",
					capabilities: [],
				},
			],
		},
		requiresAbis: ["tool/v1", "workflow/v1"],
		requiresCapabilities: [],
	});
	const integrity = await computeEvoPackIntegrity(packDirectory, unsigned);
	await writeFile(
		join(packDirectory, "pack.json"),
		`${JSON.stringify({ ...unsigned, integrity }, undefined, "\t")}\n`,
	);
}

function lastCandidate(result: Awaited<ReturnType<typeof importEvoPack>>, parentDigest: string): string {
	let expectedParent = result.proposal?.candidateDigest ?? parentDigest;
	for (const imported of result.importedComponents) {
		expect(imported.proposal.parentBundleDigest).toBe(expectedParent);
		if (!imported.proposal.candidateDigest) throw new Error(`Missing candidate for ${imported.id}`);
		expectedParent = imported.proposal.candidateDigest;
	}
	return expectedParent;
}

describe("plural code-part schemas", () => {
	it("parses exact tool/workflow policy entries and rejects ambiguity", () => {
		const policy = parseBundlePolicy({
			schemaVersion: 1,
			components: {
				context: { id: "context-pruner", abi: "context/v1", artifactDigest },
			},
			tools: [
				{ id: "read-notes", abi: "tool/v1", artifactDigest },
				{ id: "summarize-notes", abi: "tool/v1", artifactDigest: "b".repeat(64) },
			],
			workflows: [
				{ id: "deep-review", trigger: "/deep-review", abi: "workflow/v1", artifactDigest: "c".repeat(64) },
			],
		});
		expect(policy.tools?.map((selection) => selection.id)).toEqual(["read-notes", "summarize-notes"]);
		expect(policy.workflows?.[0].trigger).toBe("/deep-review");
		expect(() =>
			parseBundlePolicy({
				schemaVersion: 1,
				tools: [{ id: "bad", abi: "context/v1", artifactDigest }],
			}),
		).toThrow(/tool\/v1/);
		expect(() =>
			parseBundlePolicy({
				schemaVersion: 1,
				tools: [{ id: "bad", abi: "tool/v1", artifactDigest, extra: true }],
			}),
		).toThrow(/unknown key/);
		expect(() =>
			parseBundlePolicy({
				schemaVersion: 1,
				components: { tool: { id: "bad", abi: "tool/v1", artifactDigest } },
			}),
		).toThrow(/plural policy field/);
		expect(() =>
			parseBundlePolicy({
				schemaVersion: 1,
				workflows: [
					{ id: "one", trigger: "/same", abi: "workflow/v1", artifactDigest },
					{ id: "two", trigger: "/same", abi: "workflow/v1", artifactDigest: "b".repeat(64) },
				],
			}),
		).toThrow(/duplicate triggers/);
	});

	it("allows repeated tool surfaces but rejects duplicate singleton surfaces and code ids", () => {
		const tool = (id: string, artifact: string) => ({
			surface: "tool",
			abi: "tool/v1",
			id,
			artifact,
			capabilities: [],
		});
		expect(
			parseEvoPackManifest({
				packFormat: 1,
				name: "two-tools",
				version: "1",
				contents: { components: [tool("one", "components/one"), tool("two", "components/two")] },
				requiresAbis: ["tool/v1"],
				requiresCapabilities: [],
			}).contents.components,
		).toHaveLength(2);
		expect(() =>
			parseEvoPackManifest({
				packFormat: 1,
				name: "two-contexts",
				version: "1",
				contents: {
					components: [
						{ ...tool("one", "components/one"), surface: "context", abi: "context/v1" },
						{ ...tool("two", "components/two"), surface: "context", abi: "context/v1" },
					],
				},
				requiresAbis: ["context/v1"],
				requiresCapabilities: [],
			}),
		).toThrow(/singleton surfaces/);
		expect(() =>
			parseEvoPackManifest({
				packFormat: 1,
				name: "duplicate-id",
				version: "1",
				contents: {
					components: [tool("same", "components/same")],
					workflows: [
						{
							id: "same",
							trigger: "/same",
							abi: "workflow/v1",
							artifact: "workflows/same",
							capabilities: [],
						},
					],
				},
				requiresAbis: ["tool/v1", "workflow/v1"],
				requiresCapabilities: [],
			}),
		).toThrow(/code part ids/);
	});
});

describe("plural tool/workflow pack round trip", () => {
	it("preflights every code part before publishing or staging the first", async () => {
		const sourceRoot = await temporary("evo-pack-plural-failure-root-");
		const packDirectory = await temporary("evo-pack-plural-failure-pack-");
		const source = await seedBundle(sourceRoot);
		await writePluralCodePack(packDirectory, sourceRoot, { invalidLastDeclaration: true });

		await expect(
			importEvoPack({ paths: source.paths, parentDigest: source.digest, packDir: packDirectory }),
		).rejects.toThrow(/declaration does not match/);
		expect(await readdir(source.paths.proposals)).toEqual([]);
		expect(await readdir(source.paths.components)).toEqual([]);
	});

	it("stages every code part on a chained parent and preserves them through export/import", async () => {
		const sourceRoot = await temporary("evo-pack-plural-source-");
		const packDirectory = await temporary("evo-pack-plural-pack-");
		const source = await seedBundle(sourceRoot);
		await writePluralCodePack(packDirectory, sourceRoot);

		const imported = await importEvoPack({
			paths: source.paths,
			parentDigest: source.digest,
			packDir: packDirectory,
		});
		expect(imported.importedComponents.map((part) => [part.surface, part.id, part.trigger])).toEqual([
			["tool", "read-notes", undefined],
			["tool", "summarize-notes", undefined],
			["workflow", "deep-review", "/deep-review"],
			["workflow", "release-check", "/release-check"],
		]);
		expect(imported.pendingWorkflows).toBe(0);
		const sourceCandidate = lastCandidate(imported, source.digest);
		const sourceBundle = await loadCompiledBundle(source.paths, sourceCandidate);
		expect(sourceBundle.policy.tools?.map((selection) => selection.id)).toEqual(["read-notes", "summarize-notes"]);
		expect(sourceBundle.policy.workflows?.map((selection) => selection.trigger)).toEqual([
			"/deep-review",
			"/release-check",
		]);

		const exportedDirectory = join(sourceRoot, "exported");
		await exportEvoPack({
			paths: source.paths,
			bundleDigest: sourceCandidate,
			targetDirectory: exportedDirectory,
			name: "plural-round-trip",
			version: "1.0.0",
		});
		const exported = await loadEvoPack(exportedDirectory);
		expect(exported.integrity.ok).toBe(true);
		expect(exported.manifest.contents.components.map((part) => part.id)).toEqual(["read-notes", "summarize-notes"]);
		expect(exported.manifest.contents.workflows.map((part) => part.trigger)).toEqual([
			"/deep-review",
			"/release-check",
		]);

		const targetRoot = await temporary("evo-pack-plural-target-");
		const target = await seedBundle(targetRoot);
		const roundTrip = await importEvoPack({
			paths: target.paths,
			parentDigest: target.digest,
			packDir: exportedDirectory,
		});
		const targetCandidate = lastCandidate(roundTrip, target.digest);
		const targetBundle = await loadCompiledBundle(target.paths, targetCandidate);
		expect(targetBundle.policy.tools?.map((selection) => selection.id)).toEqual(["read-notes", "summarize-notes"]);
		expect(targetBundle.policy.workflows?.map((selection) => [selection.id, selection.trigger])).toEqual([
			["deep-review", "/deep-review"],
			["release-check", "/release-check"],
		]);
	});
});
