import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileBundle, loadCompiledBundle } from "../src/bundle/compile.ts";
import { type EvoCliIO, runEvoCli } from "../src/cli.ts";
import { publishEvoComponentArtifact } from "../src/components/artifact.ts";
import { computeEvoPackIntegrity, loadEvoPack, parseEvoPackManifest } from "../src/pack/pack.ts";
import { getEvoPaths } from "../src/paths.ts";
import { BundleRegistry } from "../src/registry/registry.ts";
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

function captureCliOutput(): { io: EvoCliIO; messages: string[] } {
	const messages: string[] = [];
	return {
		messages,
		io: {
			interactive: false,
			write: (message) => messages.push(message),
			writeError: (message) => messages.push(message),
			question: async () => {
				throw new Error("unexpected interactive prompt");
			},
		},
	};
}

function captureInteractiveCliOutput(answer: "y" | "n"): { io: EvoCliIO; messages: string[]; prompts: string[] } {
	const messages: string[] = [];
	const prompts: string[] = [];
	return {
		messages,
		prompts,
		io: {
			interactive: true,
			write: (message) => messages.push(message),
			writeError: (message) => messages.push(message),
			question: async (prompt) => {
				prompts.push(prompt);
				return answer;
			},
		},
	};
}

async function seedActiveBundle(root: string) {
	const paths = getEvoPaths(join(root, "evo"));
	const source = join(root, "source");
	await mkdir(join(source, "prompts"), { recursive: true });
	await writeFile(join(source, "prompts", "system.md"), "Exported system prompt\n");
	await writeFile(join(source, "policy.json"), '{ "schemaVersion": 1 }\n');
	const bundle = await compileBundle({
		paths,
		sourceDirectory: source,
		parentDigest: null,
		summary: "pack CLI seed",
	});
	await new BundleRegistry(paths).initialize(bundle.digest);
	return { paths, bundle, service: new EvoService(paths) };
}

async function writeDataPack(packDirectory: string): Promise<string> {
	await mkdir(join(packDirectory, "prompts"));
	await writeFile(join(packDirectory, "prompts", "review.md"), "Review the smallest useful diff.\n");
	const unsigned = parseEvoPackManifest({
		packFormat: 1,
		name: "review-pack",
		version: "1.0.0",
		contents: {
			prompts: [{ target: "append-system", file: "prompts/review.md" }],
		},
		requiresAbis: [],
		requiresCapabilities: [],
	});
	const integrity = await computeEvoPackIntegrity(packDirectory, unsigned);
	await writeFile(
		join(packDirectory, "pack.json"),
		`${JSON.stringify({ ...unsigned, integrity }, undefined, "\t")}\n`,
	);
	return integrity;
}

const generationSource = `
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  const result = request.method === "initialize" ? { abi: request.payload.abi } : {};
  process.stdout.write(JSON.stringify({ id: request.id, ok: true, result }) + "\\n");
  if (request.method === "shutdown") process.exit(0);
});
`;

async function writeCapabilityPack(
	packDirectory: string,
	sourceRoot: string,
	entrypointContent = generationSource,
): Promise<string> {
	const sourcePaths = getEvoPaths(join(sourceRoot, "source-evo"));
	const artifact = await publishEvoComponentArtifact(sourcePaths, {
		id: "budgeted-generation",
		version: "1.0.0",
		abi: "generation/v1",
		activationBoundary: "turn",
		capabilities: ["infer"],
		entrypointContent,
	});
	const artifactDirectory = join(packDirectory, "components", artifact.manifest.id);
	await mkdir(artifactDirectory, { recursive: true });
	await writeFile(join(artifactDirectory, "manifest.json"), await readFile(join(artifact.directory, "manifest.json")));
	await writeFile(join(artifactDirectory, artifact.manifest.entrypoint), await readFile(artifact.entrypoint));
	const unsigned = parseEvoPackManifest({
		packFormat: 1,
		name: "budgeted-generation-pack",
		version: "1.0.0",
		contents: {
			components: [
				{
					surface: "generation",
					abi: artifact.manifest.abi,
					id: artifact.manifest.id,
					artifact: `components/${artifact.manifest.id}`,
					capabilities: ["infer"],
				},
			],
		},
		requiresAbis: [artifact.manifest.abi],
		requiresCapabilities: ["infer"],
	});
	const integrity = await computeEvoPackIntegrity(packDirectory, unsigned);
	await writeFile(
		join(packDirectory, "pack.json"),
		`${JSON.stringify({ ...unsigned, integrity }, undefined, "\t")}\n`,
	);
	return integrity;
}

describe("optimization pack CLI", () => {
	it("imports by staging proposals and reports digests without activation", async () => {
		const root = await temporary("evo-pack-cli-import-");
		const packDirectory = await temporary("evo-pack-cli-source-");
		const { paths, bundle, service } = await seedActiveBundle(root);
		const integrity = await writeDataPack(packDirectory);
		const { io, messages } = captureCliOutput();

		await runEvoCli(["import", packDirectory], { paths, service, io });

		const proposals = await service.listProposals();
		expect(proposals).toHaveLength(1);
		expect(await service.registry.readStableDigest()).toBe(bundle.digest);
		expect(proposals[0]?.status).toBe("pending");
		const output = messages.join("\n");
		expect(output).toContain(integrity);
		expect(output).toContain(proposals[0]?.candidateDigest);
		expect(output).toContain("Activation: none; 1 proposal(s) staged for review.");
	});

	it("exports the active bundle with explicit pack metadata", async () => {
		const root = await temporary("evo-pack-cli-export-");
		const { paths, bundle, service } = await seedActiveBundle(root);
		const destination = join(root, "shared-pack");
		const { io, messages } = captureCliOutput();

		await runEvoCli(["export", destination, "shared-bundle", "2.1.0"], { paths, service, io });

		const exported = await loadEvoPack(destination);
		expect(exported.integrity.ok).toBe(true);
		expect(exported.manifest).toMatchObject({ name: "shared-bundle", version: "2.1.0" });
		expect(exported.manifest.contents.prompts).toContainEqual({
			target: "system",
			file: "prompts/system.md",
		});
		const output = messages.join("\n");
		expect(output).toContain(bundle.digest);
		expect(output).toContain(exported.manifest.integrity);
	});

	it("does not stage a capability-bearing pack until the exact budget is confirmed", async () => {
		const root = await temporary("evo-pack-cli-grant-decline-");
		const packDirectory = await temporary("evo-pack-cli-grant-source-");
		const { paths, service } = await seedActiveBundle(root);
		const integrity = await writeCapabilityPack(packDirectory, root);
		const { io, messages, prompts } = captureInteractiveCliOutput("n");

		await runEvoCli(["import", packDirectory], { paths, service, io, model: "faux/model" });

		expect(await service.listProposals()).toEqual([]);
		expect(messages.join("\n")).toContain(integrity);
		expect(messages.join("\n")).toContain('"maxTotalTokens": 81920');
		expect(messages.join("\n")).toContain("Pack import cancelled before staging");
		expect(prompts).toHaveLength(1);
	});

	it("persists confirmed component grants in the candidate without activating the broker", async () => {
		const root = await temporary("evo-pack-cli-grant-accept-");
		const packDirectory = await temporary("evo-pack-cli-grant-source-");
		const { paths, service } = await seedActiveBundle(root);
		await writeCapabilityPack(packDirectory, root);
		const { io } = captureInteractiveCliOutput("y");

		await runEvoCli(["import", packDirectory], { paths, service, io, model: "faux/model" });

		const proposals = await service.listProposals();
		expect(proposals).toHaveLength(1);
		const candidateDigest = proposals[0]?.candidateDigest;
		if (!candidateDigest) throw new Error("Capability pack import did not produce a candidate");
		const candidate = await loadCompiledBundle(paths, candidateDigest);
		expect(candidate.policy.components?.generation?.grants).toEqual([
			{
				capability: "infer",
				maxCalls: 16,
				models: ["faux/model"],
				maxInputTokens: 65_536,
				maxOutputTokens: 16_384,
				maxTotalTokens: 81_920,
				maxCostUsd: 5,
				maxOutputTokensPerCall: 4_096,
			},
		]);
		await expect(readFile(join(paths.registry, "capability-grants.json"), "utf8")).rejects.toThrow();
	});

	it("pins the previewed integrity across interactive approval", async () => {
		const root = await temporary("evo-pack-cli-integrity-pin-");
		const packDirectory = await temporary("evo-pack-cli-integrity-source-");
		const { paths, service } = await seedActiveBundle(root);
		const approvedIntegrity = await writeCapabilityPack(packDirectory, root);
		const messages: string[] = [];
		let replacementIntegrity: string | undefined;
		const io: EvoCliIO = {
			interactive: true,
			write: (message) => messages.push(message),
			writeError: (message) => messages.push(message),
			question: async () => {
				replacementIntegrity = await writeCapabilityPack(
					packDirectory,
					root,
					`${generationSource}\n// replaced after approval preview\n`,
				);
				return "y";
			},
		};

		await expect(runEvoCli(["import", packDirectory], { paths, service, io, model: "faux/model" })).rejects.toThrow(
			`pack changed after preflight: expected ${approvedIntegrity}`,
		);
		expect(replacementIntegrity).toBeDefined();
		expect(replacementIntegrity).not.toBe(approvedIntegrity);
		expect(messages.join("\n")).toContain(approvedIntegrity);
		expect(await service.listProposals()).toEqual([]);
	});
});
