import type { AgentTool, StreamFn } from "@ch1nyzzz/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@ch1nyzzz/pi-ai/compat";
import type { ModelRegistry } from "@ch1nyzzz/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { EvoSpawnAgentRequest } from "../src/components/capabilities/spawn-agent.ts";
import {
	createModelRegistrySpawnAgentHost,
	type EvoModelRegistrySpawnAgentHostOptions,
} from "../src/components/capabilities/spawn-agent-host.ts";

const model = {
	id: "test",
	name: "Test",
	api: "faux",
	provider: "faux",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
	contextWindow: 100,
	maxTokens: 100,
} as const satisfies Model<Api>;

const request: EvoSpawnAgentRequest = {
	model: "faux/test",
	prompt: "Inspect the source and return a complete report.",
	reasoning: "high",
	maxOutputTokens: 10,
	tools: ["read"],
};
const toolParameters = Type.Object({ path: Type.String() });

function usage(input: number, output: number, cacheRead: number, cacheWrite: number, cost: number) {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

function assistant(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
	messageUsage = usage(1, 1, 0, 0, 0.01),
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "faux",
		provider: "faux",
		model: "test",
		usage: messageUsage,
		stopReason,
		timestamp: 1,
	};
}

function scriptedStream(
	messages: readonly AssistantMessage[],
	calls: Array<{ context: Context; options: SimpleStreamOptions | undefined }>,
): StreamFn {
	let index = 0;
	return (_receivedModel, context, options) => {
		const message = messages[index];
		if (!message) throw new Error("Unexpected provider turn");
		index += 1;
		calls.push({ context, options });
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				stream.push({ type: "error", reason: message.stopReason, error: message });
				return;
			}
			stream.push({
				type: "done",
				reason: message.stopReason === "length" || message.stopReason === "toolUse" ? message.stopReason : "stop",
				message,
			});
		});
		return stream;
	};
}

function registry(authCalls: Model<Api>[]): Pick<ModelRegistry, "find" | "getApiKeyAndHeaders"> {
	return {
		find(provider, id) {
			return provider === "faux" && id === "test" ? model : undefined;
		},
		async getApiKeyAndHeaders(receivedModel) {
			authCalls.push(receivedModel);
			return {
				ok: true,
				apiKey: "secret-api-key",
				headers: { Authorization: "Bearer secret-header" },
				env: { SECRET_PROVIDER_ENV: "secret-env" },
			};
		},
	};
}

function tool(name: string, executions: string[]): AgentTool<typeof toolParameters> {
	return {
		name,
		label: name,
		description: `${name} a file`,
		parameters: toolParameters,
		async execute(_toolCallId, params, signal) {
			if (signal?.aborted) throw new Error("tool aborted");
			executions.push(`${name}:${params.path}`);
			return { content: [{ type: "text", text: "source" }], details: { path: params.path } };
		},
	};
}

function hostOptions(
	streamFn: StreamFn,
	tools: readonly AgentTool[],
	modelRegistry: Pick<ModelRegistry, "find" | "getApiKeyAndHeaders">,
	maxTurns = 3,
): EvoModelRegistrySpawnAgentHostOptions {
	return {
		modelRegistry,
		tools,
		systemPrompt: "You are an isolated child agent.",
		maxTurns,
		streamFn,
	};
}

describe("model-registry spawn-agent host", () => {
	it("runs an independent explicit-tool loop, resolves auth per turn, and returns the full safe transcript", async () => {
		const providerCalls: Array<{ context: Context; options: SimpleStreamOptions | undefined }> = [];
		const authCalls: Model<Api>[] = [];
		const executions: string[] = [];
		const responses = [
			assistant(
				[{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/main.ts" } }],
				"toolUse",
				usage(10, 3, 1, 0, 0.01),
			),
			assistant([{ type: "text", text: "complete report" }], "stop", usage(20, 4, 0, 2, 0.02)),
		];
		const host = createModelRegistrySpawnAgentHost(
			hostOptions(
				scriptedStream(responses, providerCalls),
				[tool("read", executions), tool("hidden", executions)],
				registry(authCalls),
			),
		);
		const resolved = host.resolveModel("faux/test");
		if (!resolved) throw new Error("Expected faux/test model");

		expect(host.estimateReservation(resolved, request)).toEqual({
			inputTokens: 300,
			outputTokens: 10,
			totalTokens: 310,
			costUsd: 0.00062,
		});
		const response = await host.runAgent(resolved, request, { signal: new AbortController().signal });

		expect(response.usage).toEqual({ inputTokens: 33, outputTokens: 7, totalTokens: 40, costUsd: 0.03 });
		expect(response.result).toMatchObject({
			schemaVersion: 1,
			status: "completed",
			model: { provider: "faux", id: "test" },
			turns: 2,
			stopReason: "stop",
			messages: [
				{ role: "user" },
				{ role: "assistant", stopReason: "toolUse" },
				{ role: "toolResult", toolName: "read", content: [{ type: "text", text: "source" }] },
				{ role: "assistant", stopReason: "stop" },
			],
		});
		expect(executions).toEqual(["read:src/main.ts"]);
		expect(authCalls).toEqual([model, model]);
		expect(providerCalls.map((call) => call.context.tools?.map((candidate) => candidate.name))).toEqual([
			["read"],
			["read"],
		]);
		expect(providerCalls.map((call) => call.options?.maxTokens)).toEqual([10, 7]);
		expect(providerCalls.map((call) => call.options?.maxRetries)).toEqual([0, 0]);
		expect(providerCalls[0]?.options).toMatchObject({
			apiKey: "secret-api-key",
			headers: { Authorization: "Bearer secret-header" },
			env: { SECRET_PROVIDER_ENV: "secret-env" },
		});
		const serialized = JSON.stringify(response);
		expect(serialized).not.toContain("secret-api-key");
		expect(serialized).not.toContain("secret-header");
		expect(serialized).not.toContain("secret-env");
	});

	it("stops after hard turn and aggregate output limits without starting another provider turn", async () => {
		const turnCalls: Array<{ context: Context; options: SimpleStreamOptions | undefined }> = [];
		const turnExecutions: string[] = [];
		const authCalls: Model<Api>[] = [];
		const turnHost = createModelRegistrySpawnAgentHost(
			hostOptions(
				scriptedStream(
					[
						assistant(
							[{ type: "toolCall", id: "call-turn", name: "read", arguments: { path: "turn.ts" } }],
							"toolUse",
							usage(5, 2, 0, 0, 0.01),
						),
					],
					turnCalls,
				),
				[tool("read", turnExecutions)],
				registry(authCalls),
				1,
			),
		);
		const resolved = turnHost.resolveModel("faux/test");
		if (!resolved) throw new Error("Expected faux/test model");
		const turnResult = await turnHost.runAgent(resolved, request, { signal: new AbortController().signal });
		expect(turnResult.result).toMatchObject({ status: "turn-limit", turns: 1 });
		expect(turnCalls).toHaveLength(1);
		expect(turnExecutions).toEqual(["read:turn.ts"]);

		const outputCalls: Array<{ context: Context; options: SimpleStreamOptions | undefined }> = [];
		const outputExecutions: string[] = [];
		const outputHost = createModelRegistrySpawnAgentHost(
			hostOptions(
				scriptedStream(
					[
						assistant(
							[{ type: "toolCall", id: "call-output", name: "read", arguments: { path: "output.ts" } }],
							"toolUse",
							usage(5, 10, 0, 0, 0.01),
						),
					],
					outputCalls,
				),
				[tool("read", outputExecutions)],
				registry([]),
			),
		);
		const outputResolved = outputHost.resolveModel("faux/test");
		if (!outputResolved) throw new Error("Expected faux/test model");
		const outputResult = await outputHost.runAgent(outputResolved, request, {
			signal: new AbortController().signal,
		});
		expect(outputResult.result).toMatchObject({ status: "output-limit", turns: 1 });
		expect(outputCalls).toHaveLength(1);
		expect(outputExecutions).toEqual(["read:output.ts"]);
	});

	it("rejects a transcript that exceeds the configured byte limit", async () => {
		const providerCalls: Array<{ context: Context; options: SimpleStreamOptions | undefined }> = [];
		const host = createModelRegistrySpawnAgentHost({
			...hostOptions(
				scriptedStream([assistant([{ type: "text", text: "x".repeat(1_000) }], "stop")], providerCalls),
				[],
				registry([]),
			),
			maxTranscriptBytes: 256,
		});
		const resolved = host.resolveModel("faux/test");
		if (!resolved) throw new Error("Expected faux/test model");
		await expect(
			host.runAgent(resolved, { ...request, tools: [] }, { signal: new AbortController().signal }),
		).rejects.toThrow("transcript exceeds");
		expect(providerCalls).toHaveLength(1);
	});

	it("rejects unavailable and recursive tools before resolving credentials", async () => {
		const authCalls: Model<Api>[] = [];
		const providerCalls: Array<{ context: Context; options: SimpleStreamOptions | undefined }> = [];
		const host = createModelRegistrySpawnAgentHost(
			hostOptions(
				scriptedStream([assistant([{ type: "text", text: "unused" }], "stop")], providerCalls),
				[],
				registry(authCalls),
			),
		);
		const resolved = host.resolveModel("faux/test");
		if (!resolved) throw new Error("Expected faux/test model");

		await expect(host.runAgent(resolved, request, { signal: new AbortController().signal })).rejects.toThrow(
			"tool is unavailable: read",
		);
		await expect(
			host.runAgent(resolved, { ...request, tools: ["agent"] }, { signal: new AbortController().signal }),
		).rejects.toThrow("must not include agent");
		expect(authCalls).toEqual([]);
		expect(providerCalls).toEqual([]);
	});

	it("propagates AbortSignal through the independent Agent and provider stream", async () => {
		let receivedSignal: AbortSignal | undefined;
		const waitingStream: StreamFn = (receivedModel, _context, options) => {
			receivedSignal = options?.signal;
			const stream = createAssistantMessageEventStream();
			options?.signal?.addEventListener(
				"abort",
				() => {
					stream.push({
						type: "error",
						reason: "aborted",
						error: {
							...assistant([], "aborted", usage(0, 0, 0, 0, 0)),
							api: receivedModel.api,
							provider: receivedModel.provider,
							model: receivedModel.id,
						},
					});
				},
				{ once: true },
			);
			return stream;
		};
		const host = createModelRegistrySpawnAgentHost(hostOptions(waitingStream, [], registry([])));
		const resolved = host.resolveModel("faux/test");
		if (!resolved) throw new Error("Expected faux/test model");
		const controller = new AbortController();
		const reason = new Error("cancel child");
		const running = host.runAgent(resolved, { ...request, tools: [] }, { signal: controller.signal });
		while (!receivedSignal) await Promise.resolve();
		controller.abort(reason);

		await expect(running).rejects.toBe(reason);
		expect(receivedSignal?.aborted).toBe(true);
	});

	it("aborts immediately while auth refresh is pending and observes a later auth rejection", async () => {
		let markAuthStarted = (): void => {};
		const authStarted = new Promise<void>((resolve) => {
			markAuthStarted = resolve;
		});
		let rejectAuth: ((error: Error) => void) | undefined;
		const pendingAuth = new Promise<never>((_resolve, reject) => {
			rejectAuth = reject;
		});
		const waitingRegistry: Pick<ModelRegistry, "find" | "getApiKeyAndHeaders"> = {
			find(provider, id) {
				return provider === "faux" && id === "test" ? model : undefined;
			},
			getApiKeyAndHeaders() {
				markAuthStarted();
				return pendingAuth;
			},
		};
		let providerCalls = 0;
		const providerStream: StreamFn = () => {
			providerCalls += 1;
			return createAssistantMessageEventStream();
		};
		const executions: string[] = [];
		const host = createModelRegistrySpawnAgentHost(
			hostOptions(providerStream, [tool("read", executions)], waitingRegistry),
		);
		const resolved = host.resolveModel("faux/test");
		if (!resolved) throw new Error("Expected faux/test model");
		const controller = new AbortController();
		const reason = new Error("cancel during auth refresh");
		const running = host.runAgent(resolved, request, { signal: controller.signal });
		await authStarted;
		controller.abort(reason);

		const timeout = Symbol("abort timeout");
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
		const timeoutResult = new Promise<typeof timeout>((resolve) => {
			timeoutHandle = setTimeout(() => resolve(timeout), 250);
		});
		const outcome = await Promise.race([
			running.then(
				(result) => result,
				(error: unknown) => error,
			),
			timeoutResult,
		]);
		if (timeoutHandle) clearTimeout(timeoutHandle);
		expect(outcome).toBe(reason);
		expect(providerCalls).toBe(0);
		expect(executions).toEqual([]);

		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown): void => {
			unhandled.push(error);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			if (!rejectAuth) throw new Error("Auth rejection hook was not initialized");
			rejectAuth(new Error("late auth refresh failure"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});
