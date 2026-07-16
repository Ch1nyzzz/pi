import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileBundle, loadCompiledBundle } from "../src/bundle/compile.ts";
import { publishEvoComponentArtifact } from "../src/components/artifact.ts";
import { importEvoPack } from "../src/pack/import.ts";
import { computeEvoPackIntegrity, parseEvoPackManifest } from "../src/pack/pack.ts";
import { ensureEvoLayout, getEvoPaths } from "../src/paths.ts";
import { EvoService } from "../src/service.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporary(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	roots.push(directory);
	return directory;
}

async function seedBundle(root: string) {
	const paths = getEvoPaths(join(root, "evo"));
	await ensureEvoLayout(paths);
	const source = join(root, "seed");
	await mkdir(source);
	await writeFile(join(source, "policy.json"), '{ "schemaVersion": 1 }\n');
	const bundle = await compileBundle({
		paths,
		sourceDirectory: source,
		parentDigest: null,
		summary: "pack component seed",
	});
	return { paths, bundle };
}

const contextSource = `
import { createInterface } from "node:readline";
let abi;
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    abi = request.payload.abi;
    process.stdout.write(JSON.stringify({ id: request.id, ok: true, result: { abi } }) + "\\n");
  } else if (request.method === "invoke") {
    process.stdout.write(JSON.stringify({
      id: request.id,
      ok: true,
      result: { messages: request.payload.messages.slice(-1) }
    }) + "\\n");
  } else {
    process.stdout.write(JSON.stringify({ id: request.id, ok: true, result: {} }) + "\\n");
    if (request.method === "shutdown") process.exit(0);
  }
});
`;

async function writeComponentPack(options: {
	packDir: string;
	sourceRoot: string;
	declaredId?: string;
	abi?: string;
	includePrompt?: boolean;
	promptContent?: string;
	capabilities?: string[];
}): Promise<void> {
	const sourcePaths = getEvoPaths(join(options.sourceRoot, "source-evo"));
	const abi = options.abi ?? "context/v1";
	const artifact = await publishEvoComponentArtifact(sourcePaths, {
		id: "last-message",
		version: "1.0.0",
		abi,
		activationBoundary: "session",
		capabilities: options.capabilities ?? [],
		entrypointContent: contextSource,
	});
	const artifactDirectory = join(options.packDir, "components", "last-message");
	await mkdir(artifactDirectory, { recursive: true });
	await writeFile(join(artifactDirectory, "manifest.json"), await readFile(join(artifact.directory, "manifest.json")));
	await writeFile(join(artifactDirectory, artifact.manifest.entrypoint), await readFile(artifact.entrypoint));
	if (options.includePrompt) {
		await mkdir(join(options.packDir, "prompts"), { recursive: true });
		await writeFile(
			join(options.packDir, "prompts", "context.md"),
			options.promptContent ?? "Keep only the most relevant context.\n",
		);
	}
	const base = {
		packFormat: 1,
		name: "last-message-context",
		version: "1.0.0",
		contents: {
			...(options.includePrompt ? { prompts: [{ target: "append-system", file: "prompts/context.md" }] } : {}),
			components: [
				{
					surface: "context",
					abi,
					id: options.declaredId ?? artifact.manifest.id,
					artifact: "components/last-message",
					capabilities: options.capabilities ?? [],
				},
			],
		},
		requiresAbis: [abi],
		requiresCapabilities: options.capabilities ?? [],
	};
	const integrity = await computeEvoPackIntegrity(options.packDir, parseEvoPackManifest(base));
	await writeFile(join(options.packDir, "pack.json"), `${JSON.stringify({ ...base, integrity }, undefined, "\t")}\n`);
}

describe("registered-ABI component pack import", () => {
	it("publishes the artifact and stages a context selection proposal", async () => {
		const root = await temporary("evo-pack-code-root-");
		const packDir = await temporary("evo-pack-code-");
		const { paths, bundle } = await seedBundle(root);
		await writeComponentPack({ packDir, sourceRoot: root });

		const result = await importEvoPack({ paths, parentDigest: bundle.digest, packDir });

		expect(result.proposal).toBeUndefined();
		expect(result.importedComponents).toHaveLength(1);
		expect(result.unregisteredAbis).toEqual([]);
		const imported = result.importedComponents[0];
		expect(imported.abi).toBe("context/v1");
		expect(imported.proposal.targetAbi).toBe("context/v1");
		expect(imported.proposal.tier).toBe("T1");
		expect(imported.proposal.l1.reason).toContain("Canary");
		const candidate = await loadCompiledBundle(paths, imported.proposal.candidateDigest as string);
		expect(candidate.policy.components?.context).toMatchObject({
			id: "last-message",
			abi: "context/v1",
			artifactDigest: imported.artifactDigest,
		});
	});

	it("imports the verified snapshot when the source artifact changes after preflight", async () => {
		const root = await temporary("evo-pack-code-mutation-root-");
		const packDir = await temporary("evo-pack-code-mutation-");
		const { paths, bundle } = await seedBundle(root);
		await writeComponentPack({ packDir, sourceRoot: root });
		const approvedManifest = JSON.parse(
			await readFile(join(packDir, "components", "last-message", "manifest.json"), "utf8"),
		) as { artifactDigest: string };
		const replacement = await publishEvoComponentArtifact(getEvoPaths(join(root, "replacement-source")), {
			id: "last-message",
			version: "1.0.0",
			abi: "context/v1",
			activationBoundary: "session",
			capabilities: [],
			entrypointContent: `${contextSource}\n// replacement source\n`,
		});

		const result = await importEvoPack({
			paths,
			parentDigest: bundle.digest,
			packDir,
			beforeStage: async () => {
				await writeFile(
					join(packDir, "components", "last-message", "manifest.json"),
					await readFile(join(replacement.directory, "manifest.json")),
				);
				await writeFile(
					join(packDir, "components", "last-message", replacement.manifest.entrypoint),
					await readFile(replacement.entrypoint),
				);
			},
		});

		expect(result.importedComponents[0]?.artifactDigest).toBe(approvedManifest.artifactDigest);
		expect(result.importedComponents[0]?.artifactDigest).not.toBe(replacement.manifest.artifactDigest);
	});

	it("rejects a pack declaration that does not match the imported artifact", async () => {
		const root = await temporary("evo-pack-code-root-");
		const packDir = await temporary("evo-pack-code-");
		const { paths, bundle } = await seedBundle(root);
		await writeComponentPack({ packDir, sourceRoot: root, declaredId: "different-id", includePrompt: true });

		await expect(importEvoPack({ paths, parentDigest: bundle.digest, packDir })).rejects.toThrow(
			/declaration does not match/,
		);
		expect(await new EvoService(paths).listProposals()).toEqual([]);
		expect(await readdir(paths.components)).toEqual([]);
	});

	it("validates unknown-ABI artifacts before staging mixed-pack data", async () => {
		const root = await temporary("evo-pack-unknown-root-");
		const packDir = await temporary("evo-pack-unknown-");
		const { paths, bundle } = await seedBundle(root);
		await writeComponentPack({
			packDir,
			sourceRoot: root,
			abi: "invented/v1",
			declaredId: "different-id",
			includePrompt: true,
		});

		await expect(importEvoPack({ paths, parentDigest: bundle.digest, packDir })).rejects.toThrow(
			/declaration does not match/,
		);
		expect(await new EvoService(paths).listProposals()).toEqual([]);
		expect(await readdir(paths.components)).toEqual([]);
	});

	it("leaves no pack artifacts or proposals when beforeStage fails", async () => {
		const root = await temporary("evo-pack-before-stage-root-");
		const packDir = await temporary("evo-pack-before-stage-");
		const { paths, bundle } = await seedBundle(root);
		await writeComponentPack({ packDir, sourceRoot: root, includePrompt: true });

		await expect(
			importEvoPack({
				paths,
				parentDigest: bundle.digest,
				packDir,
				beforeStage: async (preflight) => {
					expect(preflight.packDirectory).not.toBe(packDir);
					expect(preflight.unknownAbiRequests).toEqual([]);
					throw new Error("builder failed");
				},
			}),
		).rejects.toThrow("builder failed");
		expect(await new EvoService(paths).listProposals()).toEqual([]);
		expect(await readdir(paths.components)).toEqual([]);
	});

	it("finishes data shadow staging before invoking an unknown-ABI callback", async () => {
		const root = await temporary("evo-pack-data-preflight-root-");
		const packDir = await temporary("evo-pack-data-preflight-");
		const { paths, bundle } = await seedBundle(root);
		await writeComponentPack({
			packDir,
			sourceRoot: root,
			abi: "invented/v1",
			includePrompt: true,
			promptContent: "x".repeat(64 * 1024 + 1),
		});
		let callbackInvoked = false;

		await expect(
			importEvoPack({
				paths,
				parentDigest: bundle.digest,
				packDir,
				beforeStage: async () => {
					callbackInvoked = true;
				},
			}),
		).rejects.toThrow(/Prompt bytes/);
		expect(callbackInvoked).toBe(false);
		expect(await new EvoService(paths).listProposals()).toEqual([]);
		expect(await readdir(paths.components)).toEqual([]);
	});

	it("chains component selection after the data candidate for a multi-part pack", async () => {
		const root = await temporary("evo-pack-code-root-");
		const packDir = await temporary("evo-pack-code-");
		const { paths, bundle } = await seedBundle(root);
		await writeComponentPack({ packDir, sourceRoot: root, includePrompt: true });

		const result = await importEvoPack({ paths, parentDigest: bundle.digest, packDir });

		if (!result.proposal?.candidateDigest) throw new Error("Multi-part pack did not stage its data candidate");
		const component = result.importedComponents[0];
		expect(component?.proposal.parentBundleDigest).toBe(result.proposal.candidateDigest);
		if (!component?.proposal.candidateDigest)
			throw new Error("Multi-part pack did not stage its component candidate");
		const candidate = await loadCompiledBundle(paths, component.proposal.candidateDigest);
		expect(candidate.manifest.files.some((file) => file.path.startsWith("prompts/"))).toBe(true);
		expect(candidate.policy.components?.context?.id).toBe("last-message");
	});

	it("reports an unregistered ABI without publishing or selecting it", async () => {
		const root = await temporary("evo-pack-code-root-");
		const packDir = await temporary("evo-pack-code-");
		const { paths, bundle } = await seedBundle(root);
		await writeComponentPack({ packDir, sourceRoot: root, abi: "invented/v1" });

		const result = await importEvoPack({ paths, parentDigest: bundle.digest, packDir });
		expect(result.importedComponents).toEqual([]);
		expect(result.unregisteredAbis).toEqual(["invented/v1"]);
	});

	it("rejects missing grants before staging data from a mixed pack", async () => {
		const root = await temporary("evo-pack-code-root-");
		const packDir = await temporary("evo-pack-code-");
		const { paths, bundle } = await seedBundle(root);
		await writeComponentPack({ packDir, sourceRoot: root, includePrompt: true, capabilities: ["infer"] });

		await expect(importEvoPack({ paths, parentDigest: bundle.digest, packDir })).rejects.toThrow(
			/requires an explicit grant/,
		);
		expect(await new EvoService(paths).listProposals()).toEqual([]);
	});
});
