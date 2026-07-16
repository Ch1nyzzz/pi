import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@ch1nyzzz/pi-ai";
import { fauxAssistantMessage, registerFauxProvider } from "@ch1nyzzz/pi-ai/compat";
import {
	AuthStorage,
	createAgentSessionFromServices,
	createAgentSessionServices,
	type ExtensionAPI,
	type ExtensionContext,
	SessionManager,
} from "@ch1nyzzz/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { compileBundle } from "../src/bundle/compile.ts";
import { createPolicyRuntimeExtension } from "../src/bundle/runtime.ts";
import { publishEvoComponentArtifact } from "../src/components/artifact.ts";
import { EvoCapabilityBroker, type EvoCapabilityGrant } from "../src/components/capabilities/broker.ts";
import type { EvoCapabilityService } from "../src/components/capabilities/service.ts";
import { EvoMemoryStore } from "../src/components/memory/store.ts";
import { composeDeepReviewEntrypoint } from "../src/pack/templates/deep-review.ts";
import { type EvoPaths, getEvoPaths } from "../src/paths.ts";
import { BundleRegistry } from "../src/registry/registry.ts";
import { sha256, withFileLock } from "../src/storage.ts";
import type {
	BundlePolicy,
	CompiledBundle,
	EvoComponentActivationBoundary,
	EvoComponentSelection,
	EvoWorkflowSelection,
} from "../src/types.ts";

type EventHandler = (event: Record<string, unknown>, context: ExtensionContext) => unknown;

interface RegisteredTool {
	name: string;
	execute(toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}

interface RegisteredCommand {
	handler(args: string): Promise<void> | void;
}

interface HarnessRegistry {
	getAll(): Model<string>[];
	find(provider: string, id: string): Model<string> | undefined;
	getApiKeyAndHeaders(
		model: Model<string>,
	): Promise<
		| { ok: true; apiKey: string; headers?: Record<string, string>; env?: Record<string, string> }
		| { ok: false; error: string }
	>;
}

interface HarnessOptions {
	hostToolNames?: string[];
	hostCommandNames?: string[];
	modelRegistry?: HarnessRegistry;
}

function createHarness(root: string, options: HarnessOptions = {}) {
	const handlers = new Map<string, EventHandler[]>();
	const notifications: string[] = [];
	const entries: unknown[] = [];
	const sentMessages: unknown[] = [];
	const registeredTools = new Map<string, RegisteredTool>();
	const registeredCommands = new Map<string, RegisteredCommand>();
	const hostToolNames = new Set(options.hostToolNames ?? []);
	const hostCommandNames = new Set(options.hostCommandNames ?? []);
	let activeTools = ["read"];
	let thinkingLevel = "low";
	let model = options.modelRegistry?.getAll()[0];
	const modelRegistry: HarnessRegistry = options.modelRegistry ?? {
		getAll: () => [],
		find: () => undefined,
		getApiKeyAndHeaders: async () => ({ ok: false, error: "No harness model is configured" }),
	};
	const api = {
		on(event: string, handler: EventHandler) {
			const existing = handlers.get(event) ?? [];
			existing.push(handler);
			handlers.set(event, existing);
		},
		appendEntry(customType: string, data: unknown) {
			entries.push({ type: "custom", customType, data });
		},
		getActiveTools: () => [...activeTools],
		setActiveTools(value: string[]) {
			activeTools = [...value];
		},
		getAllTools: () => [...[...hostToolNames].map((name) => ({ name })), ...[...registeredTools.values()]],
		registerTool(tool: RegisteredTool) {
			registeredTools.set(tool.name, tool);
		},
		getCommands: () => [
			...[...hostCommandNames].map((name) => ({ name })),
			...[...registeredCommands].map(([name]) => ({ name })),
		],
		registerCommand(name: string, command: RegisteredCommand) {
			registeredCommands.set(name, command);
		},
		sendMessage(message: unknown) {
			sentMessages.push(message);
		},
		getThinkingLevel: () => thinkingLevel,
		setThinkingLevel(value: string) {
			thinkingLevel = value;
		},
		setModel: async (value: Model<string>) => {
			model = value;
			return true;
		},
	} as unknown as ExtensionAPI;
	const context = {
		cwd: root,
		hasUI: false,
		sessionManager: {
			getSessionId: () => "s3-s4-runtime",
			getSessionFile: () => join(root, "session.jsonl"),
			getEntries: () => entries,
		},
		get model() {
			return model;
		},
		modelRegistry,
		getContextUsage: () => ({ tokens: 12, contextWindow: 1_000, percent: 1.2 }),
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
		},
	} as unknown as ExtensionContext;
	return {
		api,
		notifications,
		sentMessages,
		getActiveTools: () => [...activeTools],
		getTool(name: string): RegisteredTool {
			const tool = registeredTools.get(name);
			if (!tool) throw new Error(`Harness tool is not registered: ${name}`);
			return tool;
		},
		async invokeCommand(name: string, args: string): Promise<void> {
			const command = registeredCommands.get(name);
			if (!command) throw new Error(`Harness command is not registered: ${name}`);
			await command.handler(args);
		},
		async emit(event: string, value: Record<string, unknown>): Promise<unknown[]> {
			const results: unknown[] = [];
			for (const handler of handlers.get(event) ?? []) results.push(await handler(value, context));
			return results;
		},
	};
}

interface ComponentFixture {
	id: string;
	abi: string;
	boundary: EvoComponentActivationBoundary;
	capabilities?: string[];
	source: string;
	grants?: EvoCapabilityGrant[];
}

async function publishSelection(paths: EvoPaths, fixture: ComponentFixture): Promise<EvoComponentSelection> {
	const capabilities = fixture.capabilities ?? (fixture.abi === "memory/v1" ? ["memory-read", "memory-write"] : []);
	const grants =
		fixture.grants ??
		(fixture.abi === "memory/v1"
			? [
					{ capability: "memory-read" as const, maxCalls: 10_000 },
					{ capability: "memory-write" as const, maxCalls: 10_000 },
				]
			: undefined);
	const artifact = await publishEvoComponentArtifact(paths, {
		id: fixture.id,
		version: "1.0.0",
		abi: fixture.abi,
		activationBoundary: fixture.boundary,
		capabilities,
		entrypointContent: fixture.source,
	});
	return {
		id: artifact.manifest.id,
		abi: artifact.manifest.abi,
		artifactDigest: artifact.manifest.artifactDigest,
		config: {},
		...(grants ? { grants } : {}),
	};
}

async function compilePolicy(
	paths: EvoPaths,
	policy: BundlePolicy,
	parentDigest: string | null,
	summary: string,
): Promise<CompiledBundle> {
	const source = await mkdtemp(join(paths.root, "policy-source-"));
	await writeFile(join(source, "policy.json"), `${JSON.stringify(policy, undefined, "\t")}\n`);
	return compileBundle({ paths, sourceDirectory: source, parentDigest, summary });
}

const generationRedoSource = String.raw`
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
function reply(id, result) {
  process.stdout.write(JSON.stringify({ id, ok: true, result }) + "\n");
}
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") return reply(request.id, { initialized: true });
  if (request.method === "invoke") return reply(request.id, { redo: true });
  if (request.method === "health") return reply(request.id, { healthy: true });
  if (request.method === "shutdown") {
    reply(request.id, { stopped: true });
    process.exit(0);
  }
});
`;

function toolSource(label: string): string {
	return String.raw`
import { createInterface } from "node:readline";
const label = ${JSON.stringify(label)};
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let stuck = false;
function reply(id, result) {
  process.stdout.write(JSON.stringify({ id, ok: true, result }) + "\n");
}
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (stuck) return;
  if (request.method === "initialize") return reply(request.id, { initialized: true });
  if (request.method === "invoke") {
    if (request.payload.params.wait === true) {
      stuck = true;
      return;
    }
    return reply(request.id, {
      content: [{ type: "text", text: label + ":" + String(request.payload.params.value) }],
      details: { label, params: request.payload.params }
    });
  }
  if (request.method === "health") return reply(request.id, { healthy: true });
  if (request.method === "shutdown") {
    reply(request.id, { stopped: true });
    process.exit(0);
  }
});
`;
}

const nestedCapabilityToolSource = String.raw`
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
function reply(id, result) {
  process.stdout.write(JSON.stringify({ id, ok: true, result }) + "\n");
}
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") return reply(request.id, { initialized: true });
  if (request.method === "invoke") {
    process.stdout.write(JSON.stringify({
      type: "capability-request",
      invokeId: request.id,
      id: "blocked-read",
      capability: "read-file",
      payload: { root: "workspace", path: "README.md" }
    }) + "\n");
    return;
  }
});
`;

function contextCapabilitySource(modelRoute: string): string {
	return String.raw`
import { createInterface } from "node:readline";
const modelRoute = ${JSON.stringify(modelRoute)};
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let invoke;
function reply(id, result) {
  process.stdout.write(JSON.stringify({ id, ok: true, result }) + "\n");
}
function fail(id, error) {
  process.stdout.write(JSON.stringify({ id, ok: false, error }) + "\n");
}
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return reply(message.id, { initialized: true });
  if (message.method === "invoke") {
    invoke = message;
    process.stdout.write(JSON.stringify({
      type: "capability-request",
      invokeId: message.id,
      id: "retrieve-context",
      capability: "retrieve",
      payload: { query: "project alpha", limit: 1 }
    }) + "\n");
    return;
  }
  if (message.type === "capability-result" && message.id === "retrieve-context") {
    if (!message.ok) return fail(invoke.id, message.error.message);
    const retrievedText = message.result.fragments[0]?.text ?? "no retrieved memory";
    process.stdout.write(JSON.stringify({
      type: "capability-request",
      invokeId: invoke.id,
      id: "infer-context",
      capability: "infer",
      payload: {
        model: modelRoute,
        prompt: "Use this retrieved memory: " + retrievedText,
        maxOutputTokens: 64
      }
    }) + "\n");
    return;
  }
  if (message.type === "capability-result" && message.id === "infer-context") {
    if (!message.ok) return fail(invoke.id, message.error.message);
    return reply(invoke.id, { messages: invoke.payload.messages });
  }
  if (message.method === "health") return reply(message.id, { healthy: true });
  if (message.method === "shutdown") {
    reply(message.id, { stopped: true });
    process.exit(0);
  }
});
`;
}

function workflowSource(label: string): string {
	return String.raw`
import { createInterface } from "node:readline";
const label = ${JSON.stringify(label)};
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
function reply(id, result) {
  process.stdout.write(JSON.stringify({ id, ok: true, result }) + "\n");
}
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") return reply(request.id, { initialized: true });
  if (request.method === "invoke") {
    return reply(request.id, { result: { label, trigger: request.payload.trigger, args: request.payload.args } });
  }
  if (request.method === "health") return reply(request.id, { healthy: true });
  if (request.method === "shutdown") {
    reply(request.id, { stopped: true });
    process.exit(0);
  }
});
`;
}

const spawnAgentWorkflowSource = String.raw`
import { createInterface } from "node:readline";
let invoke;
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
function reply(id, result) {
  process.stdout.write(JSON.stringify({ id, ok: true, result }) + "\n");
}
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return reply(message.id, { initialized: true });
  if (message.method === "invoke") {
    invoke = message;
    process.stdout.write(JSON.stringify({
      type: "capability-request",
      invokeId: message.id,
      id: "spawn-1",
      capability: "spawn-agent",
      payload: {
        model: "faux/faux-1",
        prompt: "Review " + String(message.payload.args.text),
        maxOutputTokens: 64,
        tools: []
      }
    }) + "\n");
    return;
  }
  if (message.type === "capability-result") {
    if (!message.ok) return reply(invoke.id, { result: { error: message.error } });
    return reply(invoke.id, { result: { child: message.result } });
  }
  if (message.method === "health") return reply(message.id, { healthy: true });
  if (message.method === "shutdown") {
    reply(message.id, { stopped: true });
    process.exit(0);
  }
});
`;

const memorySource = String.raw`
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
function reply(id, result) {
  process.stdout.write(JSON.stringify({ id, ok: true, result }) + "\n");
}
function messageText(message) {
  if (!message) return "empty";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "empty";
  return message.content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("-") || "empty";
}
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") return reply(request.id, { initialized: true });
  if (request.method === "invoke") {
    const input = request.payload;
    if (input.mode === "recall") {
      return reply(request.id, {
        mode: "recall",
        fragments: [{ id: "recalled", text: "query:" + input.query }]
      });
    }
    if (input.mode === "encode") {
      const text = messageText(input.turnDigest.message);
      const suffix = text.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "") || "empty";
      return reply(request.id, {
        mode: "encode",
        writes: [{ id: "encoded-" + suffix, text: "encoded:" + text }],
        updates: [],
        forgets: []
      });
    }
    return reply(request.id, {
      mode: "consolidate",
      merged: [],
      insights: [{ id: "consolidated", text: "candidate-count:" + input.candidates.length }],
      forget: []
    });
  }
  if (request.method === "health") return reply(request.id, { healthy: true });
  if (request.method === "shutdown") {
    reply(request.id, { stopped: true });
    process.exit(0);
  }
});
`;

const controlMemorySource = String.raw`
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
function reply(id, result) {
  process.stdout.write(JSON.stringify({ id, ok: true, result }) + "\n");
}
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") return reply(request.id, { initialized: true });
  if (request.method === "invoke") {
    return reply(request.id, {
      memoryDeltas: [{ operation: "append", fragment: { id: "control-write", text: "must be granted" } }]
    });
  }
  if (request.method === "health") return reply(request.id, { healthy: true });
  if (request.method === "shutdown") {
    reply(request.id, { stopped: true });
    process.exit(0);
  }
});
`;

describe("S3/S4 runtime integration", () => {
	const roots: string[] = [];
	const cleanups: Array<() => void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) cleanups.pop()?.();
		await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	});

	async function temporaryRoot(prefix: string): Promise<{ root: string; paths: EvoPaths }> {
		const root = await mkdtemp(join(tmpdir(), prefix));
		roots.push(root);
		const paths = getEvoPaths(join(root, "evo"));
		await mkdir(paths.root, { recursive: true });
		return { root, paths };
	}

	it("writes candidate grants only when the candidate is activated by the runtime", async () => {
		const { paths } = await temporaryRoot("pi-evo-grant-activation-");
		const stable = await compilePolicy(paths, { schemaVersion: 1 }, null, "empty stable policy");
		const generation = await publishSelection(paths, {
			id: "candidate-generation",
			abi: "generation/v1",
			boundary: "turn",
			capabilities: ["infer"],
			source: generationRedoSource,
			grants: [
				{
					capability: "infer",
					maxCalls: 1,
					models: ["faux/faux-1"],
					maxInputTokens: 1_000,
					maxOutputTokens: 100,
					maxTotalTokens: 1_100,
					maxCostUsd: 1,
					maxOutputTokensPerCall: 100,
				},
			],
		});
		const candidate = await compilePolicy(
			paths,
			{ schemaVersion: 1, components: { generation } },
			stable.digest,
			"candidate generation policy",
		);
		const registry = new BundleRegistry(paths);
		const broker = new EvoCapabilityBroker({ paths });
		await registry.initialize(stable.digest);
		expect((await broker.getState()).components).toEqual([]);

		await registry.activateTrial({
			digest: candidate.digest,
			proposalId: "candidate-grants",
			plan: "activate candidate grants",
		});
		expect((await broker.getState()).components).toEqual([]);

		const harness = createHarness(paths.root);
		createPolicyRuntimeExtension({ root: paths.root, componentSandbox: false })(harness.api);
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		expect((await broker.getState()).components).toEqual([
			expect.objectContaining({
				id: generation.id,
				artifactDigest: generation.artifactDigest,
				grants: generation.grants,
				usage: [],
			}),
		]);
		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
	});

	it("authorizes direct memory and control paths only from persisted selection grants", async () => {
		const memoryFixture = await temporaryRoot("pi-evo-memory-grant-required-");
		const memory = await publishSelection(memoryFixture.paths, {
			id: "partially-granted-memory",
			abi: "memory/v1",
			boundary: "session",
			capabilities: ["memory-read", "memory-write"],
			grants: [{ capability: "memory-read", maxCalls: 100 }],
			source: memorySource,
		});
		const memoryBundle = await compilePolicy(
			memoryFixture.paths,
			{ schemaVersion: 1, components: { memory } },
			null,
			"memory missing write grant",
		);
		await new BundleRegistry(memoryFixture.paths).initialize(memoryBundle.digest);
		const memoryHarness = createHarness(memoryFixture.paths.root);
		createPolicyRuntimeExtension({ root: memoryFixture.paths.root, componentSandbox: false })(memoryHarness.api);
		await memoryHarness.emit("session_start", { type: "session_start", reason: "startup" });
		expect(memoryHarness.notifications).toEqual([
			expect.stringContaining("memory/v1 requires persisted memory-read and memory-write grants"),
		]);
		await expect(access(join(memoryFixture.paths.root, "component-memory"))).rejects.toMatchObject({
			code: "ENOENT",
		});

		const controlFixture = await temporaryRoot("pi-evo-control-grant-required-");
		const control = await publishSelection(controlFixture.paths, {
			id: "declaration-only-control",
			abi: "control/v1",
			boundary: "session",
			capabilities: ["memory-write"],
			grants: [],
			source: controlMemorySource,
		});
		const controlBundle = await compilePolicy(
			controlFixture.paths,
			{ schemaVersion: 1, components: { control } },
			null,
			"control declaration without grant",
		);
		await new BundleRegistry(controlFixture.paths).initialize(controlBundle.digest);
		const controlHarness = createHarness(controlFixture.paths.root);
		createPolicyRuntimeExtension({ root: controlFixture.paths.root, componentSandbox: false })(controlHarness.api);
		await controlHarness.emit("session_start", { type: "session_start", reason: "startup" });
		expect(
			await controlHarness.emit("prepare_next_turn", {
				type: "prepare_next_turn",
				turnIndex: 0,
				message: { role: "assistant", content: [{ type: "text", text: "turn" }], timestamp: 1 },
				toolResults: [],
			}),
		).toEqual([{ stop: true }]);
		expect(controlHarness.notifications).toEqual([expect.stringContaining("without a persisted memory-write grant")]);
		await expect(access(join(controlFixture.paths.root, "component-memory"))).rejects.toMatchObject({
			code: "ENOENT",
		});
		await controlHarness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
	});

	it("runs granted context retrieve and infer capabilities end-to-end", async () => {
		const { paths } = await temporaryRoot("pi-evo-context-capabilities-");
		const faux = registerFauxProvider();
		cleanups.push(faux.unregister);
		faux.setResponses([fauxAssistantMessage("context synthesis")]);
		const model = faux.getModel();
		const modelRoute = `${model.provider}/${model.id}`;
		const modelRegistry: HarnessRegistry = {
			getAll: () => [model],
			find: (provider, id) => (provider === model.provider && id === model.id ? model : undefined),
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "faux-key" }),
		};
		const context = await publishSelection(paths, {
			id: "retrieval-context",
			abi: "context/v1",
			boundary: "session",
			capabilities: ["retrieve", "infer"],
			grants: [
				{ capability: "retrieve", maxCalls: 1 },
				{
					capability: "infer",
					maxCalls: 1,
					models: [modelRoute],
					maxInputTokens: model.contextWindow,
					maxOutputTokens: 64,
					maxTotalTokens: model.contextWindow + 64,
					maxCostUsd: 1,
					maxOutputTokensPerCall: 64,
				},
			],
			source: contextCapabilitySource(modelRoute),
		});
		const bundle = await compilePolicy(
			paths,
			{ schemaVersion: 1, components: { context } },
			null,
			"context retrieve and infer",
		);
		await new BundleRegistry(paths).initialize(bundle.digest);
		const store = new EvoMemoryStore({
			paths,
			componentId: context.id,
			artifactDigest: context.artifactDigest,
		});
		const namespace = await store.initializeStable(bundle.digest);
		await namespace.append({
			id: "alpha-memory",
			text: "Project Alpha uses retrieval before inference.",
		});

		const harness = createHarness(paths.root, { modelRegistry });
		createPolicyRuntimeExtension({ root: paths.root, componentSandbox: false })(harness.api);
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		const messages = [{ role: "user", content: "Keep this context unchanged", timestamp: 1 }];
		expect(await harness.emit("context", { type: "context", messages })).toEqual([{ messages }]);
		expect(faux.state.callCount).toBe(1);

		const audit = (await readFile(join(paths.log, "capability-audit.jsonl"), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(audit).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "capability-request",
					decision: "allowed",
					request: expect.objectContaining({
						capability: "retrieve",
						payload: { query: "project alpha", limit: 1 },
					}),
				}),
				expect.objectContaining({
					type: "capability-request",
					decision: "allowed",
					request: expect.objectContaining({
						capability: "infer",
						payload: expect.objectContaining({
							model: modelRoute,
							prompt: "Use this retrieved memory: Project Alpha uses retrieval before inference.",
							maxOutputTokens: 64,
						}),
					}),
				}),
			]),
		);
		const capabilityState = await new EvoCapabilityBroker({ paths }).getState();
		expect(capabilityState.components).toContainEqual(
			expect.objectContaining({
				id: context.id,
				usage: expect.arrayContaining([
					expect.objectContaining({ capability: "retrieve", calls: 1 }),
					expect.objectContaining({ capability: "infer", calls: 1 }),
				]),
			}),
		);
		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
	});

	it("persists granted control memory deltas without rewriting the message", async () => {
		const { paths } = await temporaryRoot("pi-evo-control-memory-deltas-");
		const control = await publishSelection(paths, {
			id: "memory-writing-control",
			abi: "control/v1",
			boundary: "session",
			capabilities: ["memory-write"],
			grants: [{ capability: "memory-write", maxCalls: 1 }],
			source: controlMemorySource,
		});
		const bundle = await compilePolicy(
			paths,
			{ schemaVersion: 1, components: { control } },
			null,
			"control memory deltas",
		);
		await new BundleRegistry(paths).initialize(bundle.digest);

		const harness = createHarness(paths.root);
		createPolicyRuntimeExtension({ root: paths.root, componentSandbox: false })(harness.api);
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "host-owned message" }],
			timestamp: 1,
		};
		const originalMessage = JSON.parse(JSON.stringify(message));
		expect(
			await harness.emit("prepare_next_turn", {
				type: "prepare_next_turn",
				turnIndex: 0,
				message,
				toolResults: [],
			}),
		).toEqual([undefined]);
		expect(message).toEqual(originalMessage);

		const store = new EvoMemoryStore({
			paths,
			componentId: control.id,
			artifactDigest: control.artifactDigest,
		});
		expect((await store.openStable(bundle.digest).then((namespace) => namespace.read())).fragments).toContainEqual(
			expect.objectContaining({ id: "control-write", text: "must be granted" }),
		);
		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
	});

	it("honors one generation redo through a real AgentSession host seam", async () => {
		const { paths } = await temporaryRoot("pi-evo-generation-redo-");
		const generation = await publishSelection(paths, {
			id: "redo-generation",
			abi: "generation/v1",
			boundary: "turn",
			source: generationRedoSource,
		});
		const bundle = await compilePolicy(
			paths,
			{ schemaVersion: 1, components: { generation } },
			null,
			"generation redo policy",
		);
		await new BundleRegistry(paths).initialize(bundle.digest);

		const faux = registerFauxProvider();
		cleanups.push(faux.unregister);
		faux.setResponses([
			fauxAssistantMessage("draft response"),
			fauxAssistantMessage("final response"),
			fauxAssistantMessage("unexpected third response"),
		]);
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		const services = await createAgentSessionServices({
			cwd: paths.root,
			agentDir: paths.root,
			authStorage,
			resourceLoaderOptions: {
				extensionFactories: [createPolicyRuntimeExtension({ root: paths.root, componentSandbox: false })],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(paths.root),
			model: faux.getModel(),
			noTools: "all",
		});
		await session.bindExtensions({});
		await session.prompt("Produce the final answer");

		expect(faux.state.callCount).toBe(2);
		const assistantText = session.agent.state.messages
			.filter((message) => message.role === "assistant")
			.flatMap((message) => message.content)
			.filter((block) => block.type === "text")
			.map((block) => block.text);
		expect(assistantText).toEqual(["final response"]);
		session.dispose();
	});

	it("registers plural tools, invokes each, aborts one, and fails closed on host collisions", async () => {
		const { paths } = await temporaryRoot("pi-evo-plural-tools-");
		const alpha = await publishSelection(paths, {
			id: "alpha-tool",
			abi: "tool/v1",
			boundary: "session",
			source: toolSource("alpha"),
		});
		const beta = await publishSelection(paths, {
			id: "beta-tool",
			abi: "tool/v1",
			boundary: "session",
			source: toolSource("beta"),
		});
		const bundle = await compilePolicy(paths, { schemaVersion: 1, tools: [alpha, beta] }, null, "plural tools");
		await new BundleRegistry(paths).initialize(bundle.digest);

		const harness = createHarness(paths.root);
		createPolicyRuntimeExtension({ root: paths.root, componentSandbox: false })(harness.api);
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		expect(harness.getActiveTools()).toEqual(["read", "alpha-tool", "beta-tool"]);
		await expect(harness.getTool("alpha-tool").execute("alpha-call", { value: "one" })).resolves.toMatchObject({
			content: [{ type: "text", text: "alpha:one" }],
			details: { label: "alpha" },
		});
		await expect(harness.getTool("beta-tool").execute("beta-call", { value: "two" })).resolves.toMatchObject({
			content: [{ type: "text", text: "beta:two" }],
			details: { label: "beta" },
		});

		const abortController = new AbortController();
		const abortReason = new Error("stop waiting");
		const pending = harness.getTool("beta-tool").execute("beta-wait", { wait: true }, abortController.signal);
		abortController.abort(abortReason);
		const timeout = Symbol("tool abort timeout");
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
		const timeoutResult = new Promise<typeof timeout>((resolve) => {
			timeoutHandle = setTimeout(() => resolve(timeout), 1_000);
		});
		const outcome = await Promise.race([
			pending.then(
				(result) => result,
				(error: unknown) => error,
			),
			timeoutResult,
		]);
		if (timeoutHandle) clearTimeout(timeoutHandle);
		expect(outcome).toBe(abortReason);
		await expect(harness.getTool("beta-tool").execute("beta-after-abort", {})).rejects.toThrow(
			"Evo tool component is not active: beta-tool",
		);
		const alreadyAborted = new AbortController();
		const alreadyAbortedReason = new Error("cancel before tool invocation");
		alreadyAborted.abort(alreadyAbortedReason);
		await expect(
			harness.getTool("alpha-tool").execute("alpha-already-aborted", {}, alreadyAborted.signal),
		).rejects.toBe(alreadyAbortedReason);
		await expect(harness.getTool("alpha-tool").execute("alpha-after-abort", {})).rejects.toThrow(
			"Evo tool component is not active: alpha-tool",
		);
		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

		const collision = createHarness(paths.root, { hostToolNames: ["alpha-tool"] });
		createPolicyRuntimeExtension({ root: paths.root, componentSandbox: false })(collision.api);
		await collision.emit("session_start", { type: "session_start", reason: "startup" });
		expect(collision.getActiveTools()).toEqual([]);
		expect(collision.notifications).toEqual([
			expect.stringContaining("Evo tool name conflicts with an existing host tool: alpha-tool"),
		]);
	});

	it("aborts a nested capability when its tool execution is cancelled", async () => {
		const { paths } = await temporaryRoot("pi-evo-tool-nested-abort-");
		let markCapabilityStarted = (): void => {};
		const capabilityStarted = new Promise<void>((resolve) => {
			markCapabilityStarted = resolve;
		});
		let markCapabilityAborted = (): void => {};
		const capabilityAborted = new Promise<void>((resolve) => {
			markCapabilityAborted = resolve;
		});
		const blockedRead: EvoCapabilityService = {
			prepare(payload) {
				return { request: payload };
			},
			execute(_request, context) {
				markCapabilityStarted();
				return new Promise((_resolve, reject) => {
					const abort = (): void => {
						markCapabilityAborted();
						reject(
							context.signal.reason instanceof Error
								? context.signal.reason
								: new Error("Nested capability aborted"),
						);
					};
					context.signal.addEventListener("abort", abort, { once: true });
					if (context.signal.aborted) abort();
				});
			},
		};
		const tool = await publishSelection(paths, {
			id: "nested-abort-tool",
			abi: "tool/v1",
			boundary: "session",
			capabilities: ["read-file"],
			grants: [{ capability: "read-file", maxCalls: 1 }],
			source: nestedCapabilityToolSource,
		});
		const bundle = await compilePolicy(paths, { schemaVersion: 1, tools: [tool] }, null, "nested abort tool");
		await new BundleRegistry(paths).initialize(bundle.digest);

		const harness = createHarness(paths.root);
		createPolicyRuntimeExtension({
			root: paths.root,
			componentSandbox: false,
			capabilityServices: { "read-file": blockedRead },
		})(harness.api);
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		const controller = new AbortController();
		const reason = new Error("cancel nested capability tool");
		const pending = harness
			.getTool("nested-abort-tool")
			.execute("nested-abort-call", {}, controller.signal)
			.then(
				(result) => result,
				(error: unknown) => error,
			);
		await capabilityStarted;
		controller.abort(reason);
		await capabilityAborted;
		expect(await pending).toBe(reason);
		await expect(harness.getTool("nested-abort-tool").execute("after-abort", {})).rejects.toThrow(
			"Evo tool component is not active: nested-abort-tool",
		);
		let brokerSettled = false;
		for (let attempt = 0; attempt < 100; attempt += 1) {
			const state = await new EvoCapabilityBroker({ paths }).getState();
			if (state.operations.length === 0 && state.reservations.length === 0) {
				brokerSettled = true;
				break;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, 5));
		}
		expect(brokerSettled).toBe(true);
		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
	});

	it("registers plural workflows, invokes the default spawn-agent service, and rejects trigger collisions", async () => {
		const { paths } = await temporaryRoot("pi-evo-plural-workflows-");
		const faux = registerFauxProvider();
		cleanups.push(faux.unregister);
		faux.setResponses([fauxAssistantMessage("child review complete")]);
		const model = faux.getModel();
		const modelRegistry: HarnessRegistry = {
			getAll: () => [model],
			find: (provider, id) => (provider === model.provider && id === model.id ? model : undefined),
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "faux-key" }),
		};
		const echo = await publishSelection(paths, {
			id: "deep-review-workflow",
			abi: "workflow/v1",
			boundary: "invocation",
			source: workflowSource("deep-review"),
		});
		const spawnGrant: EvoCapabilityGrant = {
			capability: "spawn-agent",
			maxCalls: 1,
			models: [`${model.provider}/${model.id}`],
			maxInputTokens: model.contextWindow,
			maxOutputTokens: 64,
			maxTotalTokens: model.contextWindow + 64,
			maxCostUsd: 1,
			maxOutputTokensPerCall: 64,
			tools: [],
		};
		const spawn = await publishSelection(paths, {
			id: "spawn-review-workflow",
			abi: "workflow/v1",
			boundary: "invocation",
			capabilities: ["spawn-agent"],
			source: spawnAgentWorkflowSource,
			grants: [spawnGrant],
		});
		const workflows: EvoWorkflowSelection[] = [
			{ ...echo, trigger: "/deep-review" },
			{ ...spawn, trigger: "/spawn-review" },
		];
		const bundle = await compilePolicy(paths, { schemaVersion: 1, workflows }, null, "plural workflows");
		await new BundleRegistry(paths).initialize(bundle.digest);

		const harness = createHarness(paths.root, { modelRegistry });
		createPolicyRuntimeExtension({
			root: paths.root,
			componentSandbox: false,
			spawnAgentMaxTurns: 1,
		})(harness.api);
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.invokeCommand("deep-review", "src/runtime.ts");
		await harness.invokeCommand("spawn-review", "the capability broker");

		expect(harness.sentMessages).toHaveLength(2);
		expect(harness.sentMessages[0]).toMatchObject({
			customType: "evo.workflow-result",
			details: {
				id: "deep-review-workflow",
				trigger: "/deep-review",
				result: { label: "deep-review", args: { text: "src/runtime.ts" } },
			},
		});
		expect(harness.sentMessages[1]).toMatchObject({
			customType: "evo.workflow-result",
			details: {
				id: "spawn-review-workflow",
				trigger: "/spawn-review",
				result: {
					child: {
						schemaVersion: 1,
						status: "completed",
						model: { provider: model.provider, id: model.id },
						turns: 1,
					},
				},
			},
		});
		expect(faux.state.callCount).toBe(1);
		expect((await new EvoCapabilityBroker({ paths }).getState()).components).toContainEqual(
			expect.objectContaining({
				id: spawn.id,
				grants: [spawnGrant],
				usage: [expect.objectContaining({ capability: "spawn-agent", calls: 1 })],
			}),
		);
		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

		const collision = createHarness(paths.root, {
			hostCommandNames: ["deep-review"],
			modelRegistry,
		});
		createPolicyRuntimeExtension({ root: paths.root, componentSandbox: false })(collision.api);
		await collision.emit("session_start", { type: "session_start", reason: "startup" });
		expect(collision.getActiveTools()).toEqual([]);
		expect(collision.notifications).toEqual([
			expect.stringContaining("Evo workflow trigger conflicts with an existing command: /deep-review"),
		]);
	});

	it("runs the composed /deep-review template end to end with host defaults", async () => {
		const { paths } = await temporaryRoot("pi-evo-deep-review-e2e-");
		const faux = registerFauxProvider();
		cleanups.push(faux.unregister);
		faux.setResponses([
			fauxAssistantMessage('{"files":["src/alpha.ts"]}'),
			fauxAssistantMessage('{"findings":[{"summary":"off-by-one in loop","severity":"high"}]}'),
			fauxAssistantMessage('{"confirmed":true,"reason":"loop skips last element"}'),
		]);
		const model = faux.getModel();
		const modelRegistry: HarnessRegistry = {
			getAll: () => [model],
			find: (provider, id) => (provider === model.provider && id === model.id ? model : undefined),
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "faux-key" }),
		};
		const spawnGrant: EvoCapabilityGrant = {
			capability: "spawn-agent",
			maxCalls: 8,
			models: [`${model.provider}/${model.id}`],
			maxInputTokens: model.contextWindow * 4,
			maxOutputTokens: 64 * 8,
			maxTotalTokens: model.contextWindow * 4 + 64 * 8,
			maxCostUsd: 5,
			maxOutputTokensPerCall: 64,
			tools: [],
		};
		const selection = await publishSelection(paths, {
			id: "deep-review",
			abi: "workflow/v1",
			boundary: "invocation",
			capabilities: ["spawn-agent"],
			source: await composeDeepReviewEntrypoint(),
			grants: [spawnGrant],
		});
		const workflows: EvoWorkflowSelection[] = [{ ...selection, trigger: "/deep-review" }];
		const bundle = await compilePolicy(paths, { schemaVersion: 1, workflows }, null, "deep review template");
		await new BundleRegistry(paths).initialize(bundle.digest);

		const harness = createHarness(paths.root, { modelRegistry });
		createPolicyRuntimeExtension({
			root: paths.root,
			componentSandbox: false,
			spawnAgentMaxTurns: 1,
		})(harness.api);
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.invokeCommand("deep-review", "recent changes");

		expect(harness.sentMessages).toHaveLength(1);
		expect(harness.sentMessages[0]).toMatchObject({
			customType: "evo.workflow-result",
			details: {
				id: "deep-review",
				trigger: "/deep-review",
				result: {
					scope: "recent changes",
					findings: [
						{
							summary: "off-by-one in loop",
							severity: "high",
							file: "src/alpha.ts",
							reason: "loop skips last element",
						},
					],
				},
			},
		});
		expect(faux.state.callCount).toBe(3);
		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
	});

	it("runs memory recall, encode, and consolidate across trial rollback, promotion, and stable rollback", async () => {
		const { paths } = await temporaryRoot("pi-evo-memory-lifecycle-");
		const memory = await publishSelection(paths, {
			id: "lifecycle-memory",
			abi: "memory/v1",
			boundary: "session",
			source: memorySource,
		});
		const policy: BundlePolicy = { schemaVersion: 1, components: { memory } };
		const stable = await compilePolicy(paths, policy, null, "stable memory policy");
		const candidate = await compilePolicy(paths, policy, stable.digest, "candidate memory policy");
		const registry = new BundleRegistry(paths);
		const store = new EvoMemoryStore({
			paths,
			componentId: memory.id,
			artifactDigest: memory.artifactDigest,
		});
		await registry.initialize(stable.digest);

		const stableHarness = createHarness(paths.root);
		createPolicyRuntimeExtension({ root: paths.root, componentSandbox: false })(stableHarness.api);
		await stableHarness.emit("session_start", { type: "session_start", reason: "startup" });
		expect(
			await stableHarness.emit("before_agent_start", {
				type: "before_agent_start",
				prompt: "stable query",
				systemPrompt: "base",
				systemPromptOptions: {},
			}),
		).toEqual([{ systemPrompt: expect.stringContaining('"text":"query:stable query"') }]);
		await stableHarness.emit("prepare_next_turn", {
			type: "prepare_next_turn",
			turnIndex: 0,
			message: { role: "assistant", content: [{ type: "text", text: "stable" }], timestamp: 1 },
			toolResults: [],
		});
		await stableHarness.emit("agent_settled", { type: "agent_settled" });
		await stableHarness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		expect((await store.openStable(stable.digest).then((namespace) => namespace.read())).fragments).toMatchObject([
			{ id: "consolidated", text: "candidate-count:1" },
			{ id: "encoded-stable", text: "encoded:stable" },
		]);

		await registry.activateTrial({
			digest: candidate.digest,
			proposalId: "memory-candidate",
			plan: "exercise trial memory",
		});
		const trialHarness = createHarness(paths.root);
		createPolicyRuntimeExtension({ root: paths.root, componentSandbox: false })(trialHarness.api);
		await trialHarness.emit("session_start", { type: "session_start", reason: "startup" });
		await trialHarness.emit("prepare_next_turn", {
			type: "prepare_next_turn",
			turnIndex: 1,
			message: { role: "assistant", content: [{ type: "text", text: "trial" }], timestamp: 2 },
			toolResults: [],
		});
		await trialHarness.emit("agent_settled", { type: "agent_settled" });
		await trialHarness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		expect(
			(await store.openStable(stable.digest).then((namespace) => namespace.read())).fragments,
		).not.toContainEqual(expect.objectContaining({ id: "encoded-trial" }));
		expect((await store.openTrial(candidate.digest).then((namespace) => namespace.read())).fragments).toContainEqual(
			expect.objectContaining({ id: "encoded-trial" }),
		);

		await registry.rollback(undefined, "discard trial memory");
		await expect(store.openTrial(candidate.digest)).rejects.toThrow("Trial memory is not initialized");

		await registry.activateTrial({
			digest: candidate.digest,
			proposalId: "memory-candidate-retry",
			plan: "reactivate the same candidate digest",
		});
		const promotionHarness = createHarness(paths.root);
		createPolicyRuntimeExtension({ root: paths.root, componentSandbox: false })(promotionHarness.api);
		await promotionHarness.emit("session_start", { type: "session_start", reason: "startup" });
		expect(
			(await store.openTrial(candidate.digest).then((namespace) => namespace.read())).fragments,
		).not.toContainEqual(expect.objectContaining({ id: "encoded-trial" }));
		await promotionHarness.emit("prepare_next_turn", {
			type: "prepare_next_turn",
			turnIndex: 2,
			message: { role: "assistant", content: [{ type: "text", text: "promote" }], timestamp: 3 },
			toolResults: [],
		});
		await promotionHarness.emit("agent_settled", { type: "agent_settled" });
		await promotionHarness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		await registry.keepTrial("promote candidate memory");

		const keptHarness = createHarness(paths.root);
		createPolicyRuntimeExtension({ root: paths.root, componentSandbox: false })(keptHarness.api);
		await keptHarness.emit("session_start", { type: "session_start", reason: "startup" });
		await keptHarness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		expect((await store.openStable(candidate.digest).then((namespace) => namespace.read())).fragments).toContainEqual(
			expect.objectContaining({ id: "encoded-promote" }),
		);
		await expect(store.openTrial(candidate.digest)).rejects.toThrow("Trial memory is not initialized");

		await registry.rollback(undefined, "restore kept parent memory");
		const restored = await store.openStable(stable.digest).then((namespace) => namespace.read());
		expect(restored.fragments).toContainEqual(expect.objectContaining({ id: "encoded-stable" }));
		expect(restored.fragments).not.toContainEqual(expect.objectContaining({ id: "encoded-promote" }));

		await registry.activateTrial({
			digest: candidate.digest,
			proposalId: "memory-candidate-after-stable-rollback",
			plan: "reactivate after stable rollback",
		});
		const reactivatedHarness = createHarness(paths.root);
		createPolicyRuntimeExtension({ root: paths.root, componentSandbox: false })(reactivatedHarness.api);
		await reactivatedHarness.emit("session_start", { type: "session_start", reason: "startup" });
		const reactivated = await store.openTrial(candidate.digest).then((namespace) => namespace.read());
		expect(reactivated.fragments).toContainEqual(expect.objectContaining({ id: "encoded-stable" }));
		expect(reactivated.fragments).not.toContainEqual(expect.objectContaining({ id: "encoded-promote" }));
		await reactivatedHarness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
	});

	it("lazily promotes kept parent memory before preparing a child trial", async () => {
		const { paths } = await temporaryRoot("pi-evo-memory-forward-promotion-");
		const memory = await publishSelection(paths, {
			id: "forward-promotion-memory",
			abi: "memory/v1",
			boundary: "session",
			source: memorySource,
		});
		const policy: BundlePolicy = { schemaVersion: 1, components: { memory } };
		const ancestor = await compilePolicy(paths, policy, null, "forward ancestor");
		const parent = await compilePolicy(paths, policy, ancestor.digest, "forward parent");
		const child = await compilePolicy(paths, policy, parent.digest, "forward child");
		const registry = new BundleRegistry(paths);
		await registry.initialize(ancestor.digest);
		const store = new EvoMemoryStore({
			paths,
			componentId: memory.id,
			artifactDigest: memory.artifactDigest,
		});
		const ancestorNamespace = await store.initializeStable(ancestor.digest);
		await ancestorNamespace.append({ id: "ancestor", text: "forward ancestor state" });

		await registry.activateTrial({
			digest: parent.digest,
			proposalId: "forward-parent",
			plan: "create parent memory trial",
		});
		const parentHarness = createHarness(paths.root);
		createPolicyRuntimeExtension({ root: paths.root, componentSandbox: false })(parentHarness.api);
		await parentHarness.emit("session_start", { type: "session_start", reason: "startup" });
		await parentHarness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		const parentTrial = await store.openTrial(parent.digest);
		await parentTrial.append({ id: "parent", text: "kept parent trial state" });
		await registry.keepTrial("keep parent without a stable-parent session");
		await registry.activateTrial({
			digest: child.digest,
			proposalId: "forward-child",
			plan: "lazily promote parent before child memory",
		});

		const childHarness = createHarness(paths.root);
		createPolicyRuntimeExtension({ root: paths.root, componentSandbox: false })(childHarness.api);
		await childHarness.emit("session_start", { type: "session_start", reason: "startup" });
		const promotedParent = await store.openStable(parent.digest).then((namespace) => namespace.read());
		expect(promotedParent.fragments).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "ancestor" }),
				expect.objectContaining({ id: "parent" }),
			]),
		);
		await expect(store.openTrial(parent.digest)).rejects.toThrow("Trial memory is not initialized");
		expect((await store.openTrial(child.digest).then((namespace) => namespace.read())).fragments).toEqual(
			promotedParent.fragments,
		);
		expect(
			(await store.readAudit()).filter(
				(entry) => entry.operation === "promote" && entry.bundleDigest === parent.digest,
			),
		).toHaveLength(1);
		await childHarness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
	});

	it("inherits a skipped parent only through registry-verified ancestry", async () => {
		const { paths } = await temporaryRoot("pi-evo-memory-forward-inheritance-");
		const memory = await publishSelection(paths, {
			id: "forward-inheritance-memory",
			abi: "memory/v1",
			boundary: "session",
			source: memorySource,
		});
		const policy: BundlePolicy = { schemaVersion: 1, components: { memory } };
		const ancestor = await compilePolicy(paths, policy, null, "inheritance ancestor");
		const parent = await compilePolicy(paths, policy, ancestor.digest, "skipped parent");
		const child = await compilePolicy(paths, policy, parent.digest, "inheritance child");
		const registry = new BundleRegistry(paths);
		await registry.initialize(ancestor.digest);
		const store = new EvoMemoryStore({
			paths,
			componentId: memory.id,
			artifactDigest: memory.artifactDigest,
		});
		const stable = await store.initializeStable(ancestor.digest);
		await stable.append({ id: "inherited", text: "verified ancestor state" });
		await registry.activateTrial({
			digest: parent.digest,
			proposalId: "skipped-parent",
			plan: "keep without starting parent runtime",
		});
		await registry.keepTrial("keep skipped parent");
		await registry.activateTrial({
			digest: child.digest,
			proposalId: "inheritance-child",
			plan: "materialize verified parent ancestry",
		});

		const harness = createHarness(paths.root);
		createPolicyRuntimeExtension({ root: paths.root, componentSandbox: false })(harness.api);
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		expect((await store.openStable(parent.digest).then((namespace) => namespace.read())).fragments).toContainEqual(
			expect.objectContaining({ id: "inherited" }),
		);
		expect((await store.openTrial(child.digest).then((namespace) => namespace.read())).fragments).toContainEqual(
			expect.objectContaining({ id: "inherited" }),
		);
		await expect(store.openTrial(parent.digest)).rejects.toThrow("Trial memory is not initialized");
		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
	});

	it("rolls back intermediate-only namespaces and lets target-absent artifacts initialize on reintroduction", async () => {
		const { paths } = await temporaryRoot("pi-evo-memory-lineage-");
		const targetMemory = await publishSelection(paths, {
			id: "target-memory",
			abi: "memory/v1",
			boundary: "session",
			source: memorySource,
		});
		const intermediateMemory = await publishSelection(paths, {
			id: "intermediate-memory",
			abi: "context/v1",
			boundary: "session",
			capabilities: ["retrieve"],
			source: generationRedoSource,
		});
		const target = await compilePolicy(
			paths,
			{ schemaVersion: 1, components: { memory: targetMemory } },
			null,
			"lineage target",
		);
		const intermediate = await compilePolicy(
			paths,
			{ schemaVersion: 1, components: { memory: targetMemory, context: intermediateMemory } },
			target.digest,
			"lineage intermediate",
		);
		const source = await compilePolicy(paths, { schemaVersion: 1 }, intermediate.digest, "lineage source");
		const registry = new BundleRegistry(paths);
		await registry.initialize(target.digest);
		await registry.activateTrial({
			digest: intermediate.digest,
			proposalId: "lineage-intermediate",
			plan: "activate intermediate namespaces",
		});
		await registry.keepTrial("keep intermediate namespaces");
		await registry.activateTrial({
			digest: source.digest,
			proposalId: "lineage-source",
			plan: "remove memory artifacts in source",
		});
		await registry.keepTrial("keep source without memory artifacts");

		const targetStore = new EvoMemoryStore({
			paths,
			componentId: targetMemory.id,
			artifactDigest: targetMemory.artifactDigest,
		});
		const targetStable = await targetStore.initializeStable(target.digest);
		await targetStable.append({ id: "target-only", text: "target value" });
		const targetTrial = await targetStore.beginTrial({
			parentBundleDigest: target.digest,
			trialBundleDigest: intermediate.digest,
		});
		await targetTrial.append({ id: "intermediate-value", text: "intermediate value" });
		await targetStore.promoteTrial(intermediate.digest);

		const intermediateStore = new EvoMemoryStore({
			paths,
			componentId: intermediateMemory.id,
			artifactDigest: intermediateMemory.artifactDigest,
		});
		await intermediateStore.initializeStable(target.digest);
		const intermediateTrial = await intermediateStore.beginTrial({
			parentBundleDigest: target.digest,
			trialBundleDigest: intermediate.digest,
		});
		await intermediateTrial.append({ id: "introduced", text: "introduced in intermediate" });
		await intermediateStore.promoteTrial(intermediate.digest);

		await registry.rollback(target.digest, "restore full target lineage");
		const restoredTarget = await targetStore.openStable(target.digest).then((namespace) => namespace.read());
		expect(restoredTarget.fragments).toContainEqual(expect.objectContaining({ id: "target-only" }));
		expect(restoredTarget.fragments).not.toContainEqual(expect.objectContaining({ id: "intermediate-value" }));
		await expect(intermediateStore.openStable(target.digest)).rejects.toThrow(
			"Stable memory is not initialized for this bundle",
		);
		await expect(intermediateStore.openStable(intermediate.digest)).rejects.toThrow(
			"Stable memory is not initialized for this bundle",
		);

		await registry.activateTrial({
			digest: intermediate.digest,
			proposalId: "lineage-reintroduction",
			plan: "reintroduce the intermediate artifact",
		});
		const reintroducedParent = await intermediateStore.initializeStable(target.digest);
		expect((await reintroducedParent.read()).fragments).toEqual([]);
		const reintroducedTrial = await intermediateStore.beginTrial({
			parentBundleDigest: target.digest,
			trialBundleDigest: intermediate.digest,
		});
		expect((await reintroducedTrial.read()).fragments).toEqual([]);
	});

	it("recovers every promotion phase and backfills only audit-proven legacy checkpoints", async () => {
		const { paths } = await temporaryRoot("pi-evo-memory-promotion-recovery-");
		const parentDigest = "a".repeat(64);
		const candidateDigest = "b".repeat(64);
		const artifactDigest = "c".repeat(64);
		const store = new EvoMemoryStore({ paths, componentId: "promotion-memory", artifactDigest });
		const parent = await store.initializeStable(parentDigest);
		await parent.append({ id: "parent", text: "parent state" });
		const trial = await store.beginTrial({
			parentBundleDigest: parentDigest,
			trialBundleDigest: candidateDigest,
		});
		await trial.append({ id: "candidate", text: "candidate state" });
		const namespaceRoot = join(paths.root, "component-memory", "namespaces", "promotion-memory", artifactDigest);
		const stablePath = join(namespaceRoot, "stable.json");
		const trialPath = join(namespaceRoot, "trials", `${candidateDigest}.json`);
		const parentHistoryPath = join(namespaceRoot, "stable-history", `${parentDigest}.json`);
		const auditPath = join(namespaceRoot, "audit.jsonl");
		const trialPointer = await readFile(trialPath, "utf8");
		await mkdir(join(namespaceRoot, "stable-history"), { recursive: true });
		await writeFile(parentHistoryPath, await readFile(stablePath, "utf8"));
		await store.promoteTrial(candidateDigest);

		const auditWithoutPromote = (await readFile(auditPath, "utf8"))
			.trim()
			.split("\n")
			.filter((line) => (JSON.parse(line) as { operation: string }).operation !== "promote")
			.join("\n");
		await writeFile(auditPath, `${auditWithoutPromote}\n`);
		await writeFile(trialPath, trialPointer);
		await store.promoteTrial(candidateDigest);
		await store.promoteTrial(candidateDigest);
		expect((await store.readAudit()).filter((entry) => entry.operation === "promote")).toHaveLength(1);
		await expect(store.openTrial(candidateDigest)).rejects.toThrow("Trial memory is not initialized");
		expect((await store.openStable(candidateDigest).then((namespace) => namespace.read())).fragments).toContainEqual(
			expect.objectContaining({ id: "candidate" }),
		);

		await rm(parentHistoryPath);
		await store.preflightBundleRollback({
			rolledBackBundleDigests: [candidateDigest],
			targetBundleDigest: parentDigest,
			targetAncestorBundleDigests: [],
			targetSelected: true,
		});
		await store.rollbackBundles({
			rolledBackBundleDigests: [candidateDigest],
			targetBundleDigest: parentDigest,
			targetAncestorBundleDigests: [],
			targetSelected: true,
		});
		expect((await store.openStable(parentDigest).then((namespace) => namespace.read())).fragments).toContainEqual(
			expect.objectContaining({ id: "parent" }),
		);
		expect(await readFile(parentHistoryPath, "utf8")).toContain(parentDigest);

		const corruptArtifactDigest = "d".repeat(64);
		const corruptStore = new EvoMemoryStore({
			paths,
			componentId: "corrupt-legacy-memory",
			artifactDigest: corruptArtifactDigest,
		});
		const corruptParent = await corruptStore.initializeStable(parentDigest);
		await corruptParent.append({ id: "legacy-parent", text: "legacy parent state" });
		const corruptTrial = await corruptStore.beginTrial({
			parentBundleDigest: parentDigest,
			trialBundleDigest: candidateDigest,
		});
		await corruptTrial.append({ id: "legacy-candidate", text: "legacy candidate state" });
		await corruptStore.promoteTrial(candidateDigest);
		const corruptRoot = join(
			paths.root,
			"component-memory",
			"namespaces",
			"corrupt-legacy-memory",
			corruptArtifactDigest,
		);
		await rm(join(corruptRoot, "stable-history", `${parentDigest}.json`));
		const promoteAudit = (await corruptStore.readAudit()).find((entry) => entry.operation === "promote");
		if (!promoteAudit?.stateBefore) throw new Error("Promotion audit did not record its parent state");
		await rm(join(corruptRoot, "objects", "sha256", `${promoteAudit.stateBefore}.json`));
		await expect(
			corruptStore.preflightBundleRollback({
				rolledBackBundleDigests: [candidateDigest],
				targetBundleDigest: parentDigest,
				targetAncestorBundleDigests: [],
				targetSelected: true,
			}),
		).rejects.toThrow("does not exist");
		expect(
			(await corruptStore.openStable(candidateDigest).then((namespace) => namespace.read())).fragments,
		).toContainEqual(expect.objectContaining({ id: "legacy-candidate" }));
	});

	it("materializes lazy target memory and idempotently replays an interrupted rollback", async () => {
		const { paths } = await temporaryRoot("pi-evo-memory-target-materialization-");
		const trialMemory = await publishSelection(paths, {
			id: "lazy-target-memory",
			abi: "memory/v1",
			boundary: "session",
			source: memorySource,
		});
		const inheritedMemory = await publishSelection(paths, {
			id: "inherited-target-memory",
			abi: "context/v1",
			boundary: "session",
			capabilities: ["retrieve"],
			source: generationRedoSource,
		});
		const selectedPolicy: BundlePolicy = {
			schemaVersion: 1,
			components: { memory: trialMemory, context: inheritedMemory },
		};
		const ancestor = await compilePolicy(paths, selectedPolicy, null, "memory ancestor");
		const target = await compilePolicy(paths, selectedPolicy, ancestor.digest, "lazy memory target");
		const source = await compilePolicy(paths, { schemaVersion: 1 }, target.digest, "memory-free source");
		const registry = new BundleRegistry(paths);
		await registry.initialize(ancestor.digest);
		await registry.activateTrial({
			digest: target.digest,
			proposalId: "lazy-memory-target",
			plan: "keep target before its memory trial is promoted",
		});
		await registry.keepTrial("keep lazy memory target");
		await registry.activateTrial({
			digest: source.digest,
			proposalId: "memory-free-source",
			plan: "remove target memory before rolling back",
		});
		await registry.keepTrial("keep memory-free source");

		const trialStore = new EvoMemoryStore({
			paths,
			componentId: trialMemory.id,
			artifactDigest: trialMemory.artifactDigest,
		});
		const trialAncestor = await trialStore.initializeStable(ancestor.digest);
		await trialAncestor.append({ id: "ancestor", text: "ancestor state" });
		const lazyTarget = await trialStore.beginTrial({
			parentBundleDigest: ancestor.digest,
			trialBundleDigest: target.digest,
		});
		await lazyTarget.append({ id: "target", text: "unpromoted target state" });

		const inheritedStore = new EvoMemoryStore({
			paths,
			componentId: inheritedMemory.id,
			artifactDigest: inheritedMemory.artifactDigest,
		});
		const inheritedAncestor = await inheritedStore.initializeStable(ancestor.digest);
		await inheritedAncestor.append({ id: "inherited", text: "never-triggered target state" });

		const reason = "replay target memory materialization";
		const interrupted = new BundleRegistry(paths, {
			afterTransitionStep(step, action) {
				if (step === "memory-rolled-back" && action === "rollback") {
					throw new Error("simulated memory rollback interruption");
				}
			},
		});
		await expect(interrupted.rollback(target.digest, reason)).rejects.toThrow(
			"simulated memory rollback interruption",
		);
		expect((await readFile(paths.stable, "utf8")).trim()).toBe(source.digest);
		expect((await trialStore.openStable(target.digest).then((namespace) => namespace.read())).fragments).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "ancestor" }),
				expect.objectContaining({ id: "target" }),
			]),
		);
		expect(
			(await inheritedStore.openStable(target.digest).then((namespace) => namespace.read())).fragments,
		).toContainEqual(expect.objectContaining({ id: "inherited" }));

		expect(await new BundleRegistry(paths).rollback(target.digest, reason)).toEqual({
			from: source.digest,
			to: target.digest,
		});
		await expect(trialStore.openTrial(target.digest)).rejects.toThrow("Trial memory is not initialized");
		expect(
			(await trialStore.readAudit()).filter(
				(entry) => entry.operation === "promote" && entry.bundleDigest === target.digest,
			),
		).toHaveLength(1);
		expect((await inheritedStore.readAudit()).filter((entry) => entry.operation === "rollback")).toHaveLength(1);
		await expect(readFile(paths.transition, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("fails closed when a rollback target has unresolved trial audit without its pointer", async () => {
		const { paths } = await temporaryRoot("pi-evo-memory-unresolved-target-");
		const memory = await publishSelection(paths, {
			id: "unresolved-target-memory",
			abi: "memory/v1",
			boundary: "session",
			source: memorySource,
		});
		const policy: BundlePolicy = { schemaVersion: 1, components: { memory } };
		const ancestor = await compilePolicy(paths, policy, null, "unresolved ancestor");
		const target = await compilePolicy(paths, policy, ancestor.digest, "unresolved target");
		const source = await compilePolicy(paths, { schemaVersion: 1 }, target.digest, "unresolved source");
		const registry = new BundleRegistry(paths);
		await registry.initialize(ancestor.digest);
		await registry.activateTrial({
			digest: target.digest,
			proposalId: "unresolved-target",
			plan: "record target trial audit",
		});
		await registry.keepTrial("keep unresolved target");
		await registry.activateTrial({
			digest: source.digest,
			proposalId: "unresolved-source",
			plan: "remove target memory",
		});
		await registry.keepTrial("keep unresolved source");

		const store = new EvoMemoryStore({
			paths,
			componentId: memory.id,
			artifactDigest: memory.artifactDigest,
		});
		await store.initializeStable(ancestor.digest);
		await store.beginTrial({ parentBundleDigest: ancestor.digest, trialBundleDigest: target.digest });
		await rm(
			join(
				paths.root,
				"component-memory",
				"namespaces",
				memory.id,
				memory.artifactDigest,
				"trials",
				`${target.digest}.json`,
			),
		);

		await expect(registry.rollback(target.digest, "reject unresolved target memory")).rejects.toThrow(
			"Trial memory audit is unresolved for rollback target",
		);
		expect((await readFile(paths.stable, "utf8")).trim()).toBe(source.digest);
		expect((await store.openStable(ancestor.digest).then((namespace) => namespace.read())).fragments).toEqual([]);
	});

	it("linearizes runtime namespace preparation before concurrent rollback cleanup", async () => {
		const { paths } = await temporaryRoot("pi-evo-memory-race-");
		const memory = await publishSelection(paths, {
			id: "race-memory",
			abi: "memory/v1",
			boundary: "session",
			source: memorySource,
		});
		const policy: BundlePolicy = { schemaVersion: 1, components: { memory } };
		const stable = await compilePolicy(paths, policy, null, "race stable");
		const candidate = await compilePolicy(paths, policy, stable.digest, "race candidate");
		const registry = new BundleRegistry(paths);
		await registry.initialize(stable.digest);
		await registry.activateTrial({
			digest: candidate.digest,
			proposalId: "race-candidate",
			plan: "race namespace preparation with rollback",
		});
		const lockName = `memory-${sha256(`${memory.id}\0${memory.artifactDigest}`).slice(0, 32)}`;
		let releaseMemoryLock: (() => void) | undefined;
		let markMemoryLockHeld: (() => void) | undefined;
		const memoryLockHeld = new Promise<void>((resolve) => {
			markMemoryLockHeld = resolve;
		});
		const releaseGate = new Promise<void>((resolve) => {
			releaseMemoryLock = resolve;
		});
		const heldMemoryLock = withFileLock(paths, lockName, async () => {
			markMemoryLockHeld?.();
			await releaseGate;
		});
		await memoryLockHeld;

		const harness = createHarness(paths.root);
		createPolicyRuntimeExtension({ root: paths.root, componentSandbox: false })(harness.api);
		const starting = harness.emit("session_start", { type: "session_start", reason: "startup" });
		const registryLockPath = join(paths.locks, "registry.lock");
		let consecutiveRegistryLockChecks = 0;
		for (let attempt = 0; attempt < 200; attempt++) {
			try {
				await access(registryLockPath);
				consecutiveRegistryLockChecks += 1;
				if (consecutiveRegistryLockChecks === 3) break;
			} catch {
				consecutiveRegistryLockChecks = 0;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, 5));
		}
		expect(consecutiveRegistryLockChecks).toBe(3);
		let rollbackFinished = false;
		const rollingBack = registry.rollback(undefined, "race cleanup").then(() => {
			rollbackFinished = true;
		});
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
		expect(rollbackFinished).toBe(false);
		releaseMemoryLock?.();
		await Promise.all([heldMemoryLock, starting, rollingBack]);

		const store = new EvoMemoryStore({
			paths,
			componentId: memory.id,
			artifactDigest: memory.artifactDigest,
		});
		await expect(store.openTrial(candidate.digest)).rejects.toThrow("Trial memory is not initialized");
		expect(await registry.readStableDigest()).toBe(stable.digest);
		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
	});
});
