import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@ch1nyzzz/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { compileBundle } from "../src/bundle/compile.ts";
import { createPolicyRuntimeExtension } from "../src/bundle/runtime.ts";
import { publishEvoComponentArtifact } from "../src/components/artifact.ts";
import { getEvoPaths } from "../src/paths.ts";
import { BundleRegistry } from "../src/registry/registry.ts";
import type { BundlePolicy, EvoComponentActivationBoundary, EvoComponentSelection } from "../src/types.ts";

type EventHandler = (event: Record<string, unknown>, context: ExtensionContext) => unknown;

interface HarnessModel {
	provider: string;
	id: string;
}

function createHarness(root: string) {
	const handlers = new Map<string, EventHandler[]>();
	const notifications: string[] = [];
	const models = [
		{ provider: "test", id: "initial" },
		{ provider: "test", id: "next" },
	];
	let model = models[0];
	let thinkingLevel = "low";
	const api = {
		on(event: string, handler: EventHandler) {
			const existing = handlers.get(event) ?? [];
			existing.push(handler);
			handlers.set(event, existing);
		},
		appendEntry() {},
		getActiveTools: () => ["read"],
		setActiveTools() {},
		getThinkingLevel: () => thinkingLevel,
		setThinkingLevel: (value: string) => {
			thinkingLevel = value;
		},
		setModel: async (value: HarnessModel) => {
			model = value;
			return true;
		},
	} as unknown as ExtensionAPI;
	const context = {
		cwd: root,
		hasUI: false,
		sessionManager: {
			getSessionId: () => "s2-runtime",
			getSessionFile: () => join(root, "session.jsonl"),
			getEntries: () => [],
		},
		get model() {
			return model;
		},
		modelRegistry: {
			getAll: () => models,
			find: (provider: string, id: string) =>
				models.find((candidate) => candidate.provider === provider && candidate.id === id),
		},
		getContextUsage: () => ({ tokens: 120, contextWindow: 1_000, percent: 12 }),
		ui: { notify: (message: string) => notifications.push(message) },
	} as unknown as ExtensionContext;
	return {
		api,
		notifications,
		getModel: () => model,
		getThinkingLevel: () => thinkingLevel,
		async emit(event: string, value: Record<string, unknown>): Promise<unknown[]> {
			const results: unknown[] = [];
			for (const handler of handlers.get(event) ?? []) results.push(await handler(value, context));
			return results;
		},
	};
}

const componentSource = String.raw`
import { createInterface } from "node:readline";
let abi;
let guardBeforeCalls = 0;
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  let result = {};
  if (request.method === "initialize") {
    abi = request.payload.abi;
    result = { initialized: true };
  } else if (request.method === "invoke") {
    const input = request.payload;
    if (abi === "compaction/v1") {
      result = {
        summary: "component-summary",
        firstKeptEntryId: input.firstKeptEntryId,
        metrics: { durationMs: 1 }
      };
    } else if (abi === "context/v1" && input.mode === "checkpoint") {
      result = {
        summary: "context-checkpoint-summary",
        firstKeptEntryId: input.firstKeptEntryId,
        metrics: { inputTokens: 12, outputTokens: 3 }
      };
    } else if (abi === "context/v1") {
      result = {
        messages: input.messages.map((message, index) =>
          index === 0 ? { ...message, content: "context-view" } : message
        )
      };
    } else if (abi === "guard/v1" && input.mode === "before") {
      guardBeforeCalls += 1;
      result = {
        mode: "before",
        args: { ...input.args, rewritten: true },
        block: input.toolName === "danger",
        reason: input.toolName === "danger" ? "blocked by guard" : undefined
      };
    } else if (abi === "guard/v1") {
      result = {
        mode: "after",
        content: [{ type: "text", text: "guarded-result" }],
        details: { guarded: true, beforeCalls: guardBeforeCalls },
        isError: false,
        terminate: true
      };
    } else if (abi === "instructions/v1") {
      result = { systemPrompt: input.systemPrompt + "\ncomponent-instructions" };
    } else if (abi === "generation/v1") {
      result = {
        message: {
          ...input.message,
          content: [{ type: "text", text: "generation-rewrite" }]
        },
        stopReason: "length"
      };
    } else if (abi === "control/v1") {
      result = { stop: true, model: "test/next", reasoning: "high" };
    }
  } else if (request.method === "health") {
    result = { healthy: true };
  } else if (request.method === "shutdown") {
    result = { stopped: true };
  }
  process.stdout.write(JSON.stringify({ id: request.id, ok: true, result }) + "\n");
  if (request.method === "shutdown") process.exit(0);
});
`;

const SURFACES: ReadonlyArray<{
	surface: string;
	abi: string;
	boundary: EvoComponentActivationBoundary;
}> = [
	{ surface: "compaction", abi: "compaction/v1", boundary: "session" },
	{ surface: "context", abi: "context/v1", boundary: "session" },
	{ surface: "guard", abi: "guard/v1", boundary: "session" },
	{ surface: "instructions", abi: "instructions/v1", boundary: "turn" },
	{ surface: "generation", abi: "generation/v1", boundary: "turn" },
	{ surface: "control", abi: "control/v1", boundary: "session" },
];

async function compileS2Bundle(root: string, includeLegacyCompaction = true): Promise<string> {
	const paths = getEvoPaths(root);
	const components: Record<string, EvoComponentSelection> = {};
	for (const definition of SURFACES) {
		if (!includeLegacyCompaction && definition.surface === "compaction") continue;
		const artifact = await publishEvoComponentArtifact(paths, {
			id: `fixture-${definition.surface}`,
			version: "1.0.0",
			abi: definition.abi,
			activationBoundary: definition.boundary,
			capabilities: [],
			entrypointContent: componentSource,
		});
		components[definition.surface] = {
			id: artifact.manifest.id,
			abi: artifact.manifest.abi,
			artifactDigest: artifact.manifest.artifactDigest,
			config: {},
		};
	}
	const source = await mkdtemp(join(root, "s2-bundle-"));
	const policy: BundlePolicy = { schemaVersion: 1, components };
	await writeFile(join(source, "policy.json"), `${JSON.stringify(policy, undefined, "\t")}\n`);
	const bundle = await compileBundle({
		paths,
		sourceDirectory: source,
		parentDigest: null,
		summary: "S2 components with no declared capabilities or grants",
	});
	await new BundleRegistry(paths).initialize(bundle.digest);
	return bundle.digest;
}

describe("S2 policy runtime", () => {
	const roots: string[] = [];

	afterEach(async () => {
		await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	});

	it("wires all S2 surfaces without granted capabilities and preserves compaction behavior", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-evo-s2-runtime-"));
		roots.push(root);
		await mkdir(root, { recursive: true });
		await compileS2Bundle(root);
		const harness = createHarness(root);
		await createPolicyRuntimeExtension({ root, componentSandbox: false })(harness.api);
		await harness.emit("session_start", { type: "session_start", reason: "startup" });

		const context = await harness.emit("context", {
			type: "context",
			messages: [{ role: "user", content: "original", timestamp: 1 }],
		});
		expect(context).toEqual([{ messages: [{ role: "user", content: "context-view", timestamp: 1 }] }]);

		const toolInput: Record<string, unknown> = { value: "original" };
		const toolCall = await harness.emit("tool_call", {
			type: "tool_call",
			toolCallId: "call-1",
			toolName: "read",
			input: toolInput,
		});
		expect(toolInput).toEqual({ value: "original", rewritten: true });
		expect(toolCall).toEqual([{ block: false }]);
		expect(
			await harness.emit("tool_call", {
				type: "tool_call",
				toolCallId: "call-2",
				toolName: "danger",
				input: {},
			}),
		).toEqual([{ block: true, reason: "blocked by guard" }]);

		expect(
			await harness.emit("tool_result", {
				type: "tool_result",
				toolCallId: "call-1",
				toolName: "read",
				input: toolInput,
				content: [{ type: "text", text: "raw" }],
				details: {},
				isError: false,
			}),
		).toEqual([
			{
				content: [{ type: "text", text: "guarded-result" }],
				details: { guarded: true, beforeCalls: 2 },
				isError: false,
				terminate: true,
			},
		]);

		const instructions = await harness.emit("before_agent_start", {
			type: "before_agent_start",
			systemPrompt: "base",
			systemPromptOptions: {},
		});
		expect(instructions).toEqual([{ systemPrompt: expect.stringContaining("component-instructions") }]);

		const assistant = {
			role: "assistant",
			content: [{ type: "text", text: "raw" }],
			api: "test-api",
			provider: "test",
			model: "initial",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		};
		expect(await harness.emit("message_end", { type: "message_end", message: assistant })).toEqual([
			{
				message: {
					...assistant,
					content: [{ type: "text", text: "generation-rewrite" }],
					stopReason: "length",
				},
			},
		]);

		const compact = await harness.emit("session_before_compact", {
			type: "session_before_compact",
			reason: "threshold",
			preparation: {
				messagesToSummarize: [{ role: "user", content: "hello", timestamp: 1 }],
				turnPrefixMessages: [],
				firstKeptEntryId: "entry-2",
				tokensBefore: 400,
			},
		});
		expect(compact).toEqual([
			{
				compaction: expect.objectContaining({
					summary: "component-summary",
					firstKeptEntryId: "entry-2",
					tokensBefore: 400,
				}),
			},
		]);

		expect(
			await harness.emit("prepare_next_turn", {
				type: "prepare_next_turn",
				turnIndex: 0,
				message: assistant,
				toolResults: [],
			}),
		).toEqual([{ stop: true }]);
		expect(harness.getModel()).toEqual({ provider: "test", id: "next" });
		expect(harness.getThinkingLevel()).toBe("high");
		expect(harness.notifications).toEqual([]);

		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
	});

	it("uses context/v1 checkpoint mode when no legacy compaction component is selected", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-evo-context-checkpoint-"));
		roots.push(root);
		await compileS2Bundle(root, false);
		const harness = createHarness(root);
		await createPolicyRuntimeExtension({ root, componentSandbox: false })(harness.api);
		await harness.emit("session_start", { type: "session_start", reason: "startup" });

		const compact = await harness.emit("session_before_compact", {
			type: "session_before_compact",
			reason: "threshold",
			preparation: {
				messagesToSummarize: [{ role: "user", content: "hello", timestamp: 1 }],
				turnPrefixMessages: [],
				firstKeptEntryId: "entry-2",
				tokensBefore: 400,
			},
		});
		expect(compact).toEqual([
			{
				compaction: expect.objectContaining({
					summary: "context-checkpoint-summary",
					firstKeptEntryId: "entry-2",
					tokensBefore: 400,
					details: expect.objectContaining({ abi: "context/v1" }),
				}),
			},
		]);
		expect(harness.notifications).toEqual([]);

		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
	});
});
