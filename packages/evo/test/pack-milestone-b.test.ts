import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@ch1nyzzz/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { compileBundle } from "../src/bundle/compile.ts";
import { createPolicyRuntimeExtension } from "../src/bundle/runtime.ts";
import { publishEvoComponentArtifact } from "../src/components/artifact.ts";
import { importEvoPack } from "../src/pack/import.ts";
import { computeEvoPackIntegrity, parseEvoPackManifest } from "../src/pack/pack.ts";
import { ensureEvoLayout, getEvoPaths } from "../src/paths.ts";
import { BundleRegistry } from "../src/registry/registry.ts";

type EventHandler = (event: Record<string, unknown>, context: ExtensionContext) => unknown;

function createHarness(root: string, sessionId: string) {
	const handlers = new Map<string, EventHandler[]>();
	const entries: unknown[] = [];
	let tools = ["read"];
	const api = {
		on(event: string, handler: EventHandler) {
			const existing = handlers.get(event) ?? [];
			existing.push(handler);
			handlers.set(event, existing);
		},
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		getActiveTools: () => [...tools],
		setActiveTools: (value: string[]) => {
			tools = [...value];
		},
	} as unknown as ExtensionAPI;
	const context = {
		cwd: root,
		hasUI: false,
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => join(root, `${sessionId}.jsonl`),
			getEntries: () => entries,
		},
		modelRegistry: { getAll: () => [], find: () => undefined },
		getContextUsage: () => ({ tokens: 10, contextWindow: 100, percent: 10 }),
		ui: { notify() {} },
	} as unknown as ExtensionContext;
	return {
		api,
		async emit(event: string, value: Record<string, unknown>): Promise<unknown[]> {
			const results: unknown[] = [];
			for (const handler of handlers.get(event) ?? []) results.push(await handler(value, context));
			return results;
		},
	};
}

const contextSource = String.raw`
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  let result = {};
  if (request.method === "initialize") result = { initialized: true };
  else if (request.method === "invoke") result = { messages: request.payload.messages.slice(-1) };
  else if (request.method === "health") result = { healthy: true };
  else if (request.method === "shutdown") result = { stopped: true };
  process.stdout.write(JSON.stringify({ id: request.id, ok: true, result }) + "\n");
  if (request.method === "shutdown") process.exit(0);
});
`;

describe("Milestone B: shared context component Canary", () => {
	const roots: string[] = [];

	afterEach(async () => {
		await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	});

	async function temporary(prefix: string): Promise<string> {
		const directory = await mkdtemp(join(tmpdir(), prefix));
		roots.push(directory);
		return directory;
	}

	it("imports, activates, pins, and rolls back a context/v1 transform", async () => {
		const root = await temporary("evo-pack-milestone-b-root-");
		const packDirectory = await temporary("evo-pack-milestone-b-pack-");
		const paths = getEvoPaths(join(root, "evo"));
		await ensureEvoLayout(paths);
		const source = join(root, "stable-source");
		await mkdir(source);
		await writeFile(join(source, "policy.json"), '{ "schemaVersion": 1 }\n');
		const stable = await compileBundle({
			paths,
			sourceDirectory: source,
			parentDigest: null,
			summary: "Milestone B stable parent",
		});
		const registry = new BundleRegistry(paths);
		await registry.initialize(stable.digest);

		const sourcePaths = getEvoPaths(join(root, "pack-source-evo"));
		const artifact = await publishEvoComponentArtifact(sourcePaths, {
			id: "last-message-context",
			version: "1.0.0",
			abi: "context/v1",
			activationBoundary: "session",
			capabilities: [],
			entrypointContent: contextSource,
		});
		const artifactDirectory = join(packDirectory, "components", artifact.manifest.id);
		await mkdir(artifactDirectory, { recursive: true });
		await writeFile(
			join(artifactDirectory, "manifest.json"),
			await readFile(join(artifact.directory, "manifest.json")),
		);
		await writeFile(join(artifactDirectory, artifact.manifest.entrypoint), await readFile(artifact.entrypoint));
		const unsigned = parseEvoPackManifest({
			packFormat: 1,
			name: "last-message-context",
			version: "1.0.0",
			contents: {
				components: [
					{
						surface: "context",
						abi: "context/v1",
						id: artifact.manifest.id,
						artifact: `components/${artifact.manifest.id}`,
						capabilities: [],
					},
				],
			},
			requiresAbis: ["context/v1"],
			requiresCapabilities: [],
		});
		const integrity = await computeEvoPackIntegrity(packDirectory, unsigned);
		await writeFile(
			join(packDirectory, "pack.json"),
			`${JSON.stringify({ ...unsigned, integrity }, undefined, "\t")}\n`,
		);

		const imported = await importEvoPack({
			paths,
			parentDigest: stable.digest,
			packDir: packDirectory,
		});
		const component = imported.importedComponents[0];
		if (!component?.proposal.candidateDigest) throw new Error("Milestone B import did not stage a candidate");
		expect(component.proposal.tier).toBe("T1");
		await registry.activateTrial({
			digest: component.proposal.candidateDigest,
			proposalId: component.proposal.id,
			plan: "One-session context transform Canary",
		});

		const first = createHarness(paths.root, "canary-session");
		await createPolicyRuntimeExtension({ root: paths.root, componentSandbox: false })(first.api);
		await first.emit("session_start", { type: "session_start", reason: "startup" });
		const messages = [
			{ role: "user", content: "first", timestamp: 1 },
			{ role: "user", content: "second", timestamp: 2 },
		];
		expect(await first.emit("context", { type: "context", messages })).toEqual([{ messages: [messages[1]] }]);

		await registry.rollback(undefined, "Rollback the Milestone B Canary");
		expect(await first.emit("context", { type: "context", messages })).toEqual([{ messages: [messages[1]] }]);
		await first.emit("session_shutdown", { type: "session_shutdown", reason: "new" });

		const afterRollback = createHarness(paths.root, "rollback-session");
		await createPolicyRuntimeExtension({ root: paths.root, componentSandbox: false })(afterRollback.api);
		await afterRollback.emit("session_start", { type: "session_start", reason: "startup" });
		expect(await afterRollback.emit("context", { type: "context", messages })).toEqual([undefined]);
		expect(await registry.readStableDigest()).toBe(stable.digest);
		await afterRollback.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
	});
});
