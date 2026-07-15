import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileBundle } from "../src/bundle/compile.ts";
import {
	loadEvoComponentArtifact,
	publishEvoComponentArtifact,
	validateEvoComponentSelection,
} from "../src/components/artifact.ts";
import { EvoComponentProcess } from "../src/components/process-runtime.ts";
import { COMPACTION_V1_ABI, createDefaultEvoAbiRegistry } from "../src/components/registry.ts";
import { getEvoPaths } from "../src/paths.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-evo-component-"));
	roots.push(root);
	return { root, paths: getEvoPaths(join(root, "evo")) };
}

const componentSource = `
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  try {
    let result;
    if (request.method === "initialize") result = { initialized: true };
    else if (request.method === "invoke") result = {
      summary: request.payload.conversation,
      firstKeptEntryId: request.payload.firstKeptEntryId,
      metrics: { durationMs: 1 }
    };
    else if (request.method === "health") result = { healthy: true };
    else if (request.method === "shutdown") result = { stopped: true };
    process.stdout.write(JSON.stringify({ id: request.id, ok: true, result }) + "\\n");
    if (request.method === "shutdown") process.exit(0);
  } catch (error) {
    process.stdout.write(JSON.stringify({ id: request.id, ok: false, error: String(error) }) + "\\n");
  }
});
`;

describe("Evo component ABI", () => {
	it("publishes, validates, and invokes a content-addressed compaction/v1 component", async () => {
		const { paths } = await fixture();
		const artifact = await publishEvoComponentArtifact(paths, {
			id: "hierarchical-summary",
			version: "1.0.0",
			abi: "compaction/v1",
			activationBoundary: "session",
			capabilities: [],
			entrypointContent: componentSource,
		});
		const selection = {
			id: artifact.manifest.id,
			abi: artifact.manifest.abi,
			artifactDigest: artifact.manifest.artifactDigest,
			config: { style: "structured" },
		};
		const registry = createDefaultEvoAbiRegistry();
		expect((await validateEvoComponentSelection(paths, "compaction", selection, registry)).manifest).toEqual(
			artifact.manifest,
		);
		const process = new EvoComponentProcess(
			await loadEvoComponentArtifact(paths, artifact.manifest.artifactDigest, registry),
			COMPACTION_V1_ABI,
			COMPACTION_V1_ABI.validateConfig(selection.config),
			{ sandbox: false, requestTimeoutMs: 5_000 },
		);
		await expect(
			process.invoke({
				conversation: "hello",
				firstKeptEntryId: "entry-2",
				tokensBefore: 100,
				reason: "threshold",
			}),
		).resolves.toMatchObject({ summary: "hello", firstKeptEntryId: "entry-2" });
		await process.shutdown();
	});

	it("rejects unknown ABIs and bundles whose component artifact is missing", async () => {
		const { root, paths } = await fixture();
		const registry = createDefaultEvoAbiRegistry();
		expect(() => registry.require("invented/v1")).toThrow("Unknown Evo component ABI");
		const source = join(root, "bundle");
		await mkdir(source, { recursive: true });
		await writeFile(
			join(source, "policy.json"),
			JSON.stringify({
				schemaVersion: 1,
				components: {
					compaction: {
						id: "missing-component",
						abi: "compaction/v1",
						artifactDigest: "a".repeat(64),
						config: {},
					},
				},
			}),
		);
		await expect(
			compileBundle({ paths, sourceDirectory: source, parentDigest: null, summary: "missing component" }),
		).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rejects a component capability that exceeds its ABI ceiling", async () => {
		const { paths } = await fixture();
		const artifact = await publishEvoComponentArtifact(paths, {
			id: "network-summary",
			version: "1",
			abi: "compaction/v1",
			activationBoundary: "session",
			capabilities: ["network.fetch"],
			entrypointContent: componentSource,
		});
		await expect(
			loadEvoComponentArtifact(paths, artifact.manifest.artifactDigest, createDefaultEvoAbiRegistry()),
		).rejects.toThrow("capability exceeds ABI ceiling");
	});
});
