import { Buffer } from "node:buffer";
import { Agent, type AgentMessage, type AgentTool, type StreamFn } from "@ch1nyzzz/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	streamSimple,
} from "@ch1nyzzz/pi-ai/compat";
import type { ModelRegistry } from "@ch1nyzzz/pi-coding-agent";
import { canonicalJson } from "../../storage.ts";
import type { EvoCapabilityResourceUsage } from "./service.ts";
import type { EvoRawSpawnAgentHost, EvoSpawnAgentHostResult, EvoSpawnAgentRequest } from "./spawn-agent.ts";

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const DEFAULT_MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;

export type EvoSpawnAgentRunStatus = "completed" | "length" | "output-limit" | "turn-limit";

export interface EvoSpawnAgentRunResult {
	schemaVersion: 1;
	status: EvoSpawnAgentRunStatus;
	model: { provider: string; id: string };
	turns: number;
	stopReason: string;
	messages: unknown[];
}

export interface EvoModelRegistrySpawnAgentHostOptions {
	modelRegistry: Pick<ModelRegistry, "find" | "getApiKeyAndHeaders">;
	/** Trusted, pre-constructed tools. No extension or resource loader is consulted. */
	tools: readonly AgentTool[];
	/** Fixed host prompt. It is sent to the model but never returned to the component. */
	systemPrompt: string;
	/** Hard maximum number of provider turns in one spawned run. */
	maxTurns: number;
	/** Hard byte limit for the JSON transcript returned to the component. */
	maxTranscriptBytes?: number;
	/** Injectable provider stream for focused tests. Defaults to pi-ai streamSimple. */
	streamFn?: StreamFn;
}

interface RunBudget {
	remainingOutputTokens: number;
	startedTurns: number;
	stopStatus?: Extract<EvoSpawnAgentRunStatus, "output-limit" | "turn-limit">;
	usage: EvoCapabilityResourceUsage;
}

function positiveInteger(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) <= 0) {
		throw new Error(`${label} must be a positive safe integer`);
	}
	return value as number;
}

function nonNegativeNumber(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(`${label} must be a non-negative finite number`);
	}
	return value;
}

function checkedProduct(left: number, right: number, label: string): number {
	const product = left * right;
	if (!Number.isSafeInteger(product)) throw new Error(`${label} exceeds the safe integer range`);
	return product;
}

function checkedSum(left: number, right: number, label: string): number {
	const sum = left + right;
	if (!Number.isSafeInteger(sum)) throw new Error(`${label} exceeds the safe integer range`);
	return sum;
}

function modelRoute(route: string): { provider: string; id: string } | undefined {
	const slash = route.indexOf("/");
	if (slash <= 0 || slash === route.length - 1) return undefined;
	return { provider: route.slice(0, slash), id: route.slice(slash + 1) };
}

function maximumRates(model: Model<Api>): { input: number; output: number } {
	const rates = [model.cost, ...(model.cost.tiers ?? [])];
	return {
		input: Math.max(...rates.map((rate) => Math.max(rate.input * 2, rate.cacheWrite, rate.cacheRead))),
		output: Math.max(...rates.map((rate) => rate.output)),
	};
}

function reservationFor(model: Model<Api>, request: EvoSpawnAgentRequest, maxTurns: number) {
	const contextWindow = positiveInteger(model.contextWindow, "spawn-agent model.contextWindow");
	const modelMaxTokens = positiveInteger(model.maxTokens, "spawn-agent model.maxTokens");
	const maxOutputTokens = positiveInteger(request.maxOutputTokens, "spawn-agent request.maxOutputTokens");
	const maximumRunOutput = checkedProduct(modelMaxTokens, maxTurns, "spawn-agent maximum run output");
	if (maxOutputTokens > maximumRunOutput) {
		throw new Error("spawn-agent request.maxOutputTokens exceeds the host turn/model output bound");
	}
	const inputTokens = checkedProduct(contextWindow, maxTurns, "spawn-agent input reservation");
	const totalTokens = checkedSum(inputTokens, maxOutputTokens, "spawn-agent total reservation");
	const rates = maximumRates(model);
	return {
		inputTokens,
		outputTokens: maxOutputTokens,
		totalTokens,
		costUsd: (inputTokens * rates.input + maxOutputTokens * rates.output) / 1_000_000,
	};
}

function validateMessageUsage(message: AssistantMessage): EvoCapabilityResourceUsage {
	const usage = message.usage;
	const inputTokens = checkedSum(
		checkedSum(
			positiveOrZeroInteger(usage.input, "spawn-agent usage.input"),
			positiveOrZeroInteger(usage.cacheRead, "spawn-agent usage.cacheRead"),
			"spawn-agent usage input",
		),
		positiveOrZeroInteger(usage.cacheWrite, "spawn-agent usage.cacheWrite"),
		"spawn-agent usage input",
	);
	return {
		inputTokens,
		outputTokens: positiveOrZeroInteger(usage.output, "spawn-agent usage.output"),
		totalTokens: positiveOrZeroInteger(usage.totalTokens, "spawn-agent usage.totalTokens"),
		costUsd: nonNegativeNumber(usage.cost.total, "spawn-agent usage.cost.total"),
	};
}

function positiveOrZeroInteger(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new Error(`${label} must be a non-negative safe integer`);
	}
	return value as number;
}

function addUsage(target: EvoCapabilityResourceUsage, addition: EvoCapabilityResourceUsage): void {
	target.inputTokens = checkedSum(target.inputTokens, addition.inputTokens, "spawn-agent aggregate input usage");
	target.outputTokens = checkedSum(target.outputTokens, addition.outputTokens, "spawn-agent aggregate output usage");
	target.totalTokens = checkedSum(target.totalTokens, addition.totalTokens, "spawn-agent aggregate total usage");
	target.costUsd += addition.costUsd;
	if (!Number.isFinite(target.costUsd)) throw new Error("spawn-agent aggregate cost exceeds the finite range");
}

function failureMessage(model: Model<Api>, error: unknown, aborted: boolean): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: EMPTY_USAGE,
		stopReason: aborted ? "aborted" : "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

function awaitWithAbort<T>(pending: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return pending;
	let removeAbortListener = (): void => {};
	const aborted = new Promise<never>((_resolve, reject) => {
		const onAbort = (): void => reject(abortError(signal));
		signal.addEventListener("abort", onAbort, { once: true });
		removeAbortListener = (): void => signal.removeEventListener("abort", onAbort);
		if (signal.aborted) onAbort();
	});
	// Promise.race installs rejection handlers on both inputs. If abort wins,
	// a later auth-refresh rejection is therefore still observed.
	return Promise.race([pending, aborted]).finally(removeAbortListener);
}

function createBoundedStream(
	modelRegistry: Pick<ModelRegistry, "getApiKeyAndHeaders">,
	baseStreamFn: StreamFn,
	budget: RunBudget,
	maxTurns: number,
): StreamFn {
	return (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
		const outer = createAssistantMessageEventStream();
		void (async () => {
			try {
				if (options?.signal?.aborted) throw options.signal.reason ?? new Error("spawn-agent request aborted");
				if (budget.startedTurns >= maxTurns) throw new Error("spawn-agent turn budget is exhausted");
				if (budget.remainingOutputTokens <= 0) throw new Error("spawn-agent output budget is exhausted");
				budget.startedTurns += 1;
				const turnOutputLimit = Math.min(model.maxTokens, budget.remainingOutputTokens);
				const auth = await awaitWithAbort(modelRegistry.getApiKeyAndHeaders(model), options?.signal);
				if (options?.signal?.aborted) throw abortError(options.signal);
				if (!auth.ok) throw new Error(auth.error);
				const source = await baseStreamFn(model, context, {
					...options,
					maxTokens: turnOutputLimit,
					maxRetries: 0,
					maxRetryDelayMs: 0,
					apiKey: auth.apiKey,
					headers: auth.headers,
					env: auth.env,
				});
				for await (const event of source) {
					if (event.type === "done" || event.type === "error") {
						const message = event.type === "done" ? event.message : event.error;
						const usage = validateMessageUsage(message);
						addUsage(budget.usage, usage);
						budget.remainingOutputTokens -= usage.outputTokens;
						if (budget.remainingOutputTokens < 0 || usage.outputTokens > turnOutputLimit) {
							throw new Error("spawn-agent provider exceeded the hard output token limit");
						}
					}
					outer.push(event);
				}
			} catch (error) {
				const aborted = options?.signal?.aborted === true;
				const message = failureMessage(model, aborted ? options?.signal?.reason : error, aborted);
				outer.push({ type: "error", reason: aborted ? "aborted" : "error", error: message });
			}
		})();
		return outer;
	};
}

function requestedTools(request: EvoSpawnAgentRequest, available: ReadonlyMap<string, AgentTool>): AgentTool[] {
	if (request.tools.includes("agent")) throw new Error("spawn-agent child tools must not include agent");
	return request.tools.map((name) => {
		const tool = available.get(name);
		if (!tool) throw new Error(`spawn-agent tool is unavailable: ${name}`);
		return tool;
	});
}

function lastAssistantMessage(messages: readonly AgentMessage[]): AssistantMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role === "assistant") return message as AssistantMessage;
	}
	return undefined;
}

function jsonMessages(messages: readonly AgentMessage[], maxBytes: number): unknown[] {
	const json = canonicalJson(messages);
	if (Buffer.byteLength(json, "utf8") > maxBytes) {
		throw new Error("spawn-agent transcript exceeds the configured byte limit");
	}
	const value = JSON.parse(json) as unknown;
	if (!Array.isArray(value)) throw new Error("spawn-agent transcript did not serialize to an array");
	return value;
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("spawn-agent request aborted");
}

export function createModelRegistrySpawnAgentHost(
	options: EvoModelRegistrySpawnAgentHostOptions,
): EvoRawSpawnAgentHost<Model<Api>> {
	const maxTurns = positiveInteger(options.maxTurns, "spawn-agent host maxTurns");
	const maxTranscriptBytes =
		options.maxTranscriptBytes === undefined
			? DEFAULT_MAX_TRANSCRIPT_BYTES
			: positiveInteger(options.maxTranscriptBytes, "spawn-agent host maxTranscriptBytes");
	if (!options.systemPrompt) throw new Error("spawn-agent host systemPrompt must be non-empty");
	const toolMap = new Map<string, AgentTool>();
	for (const tool of options.tools) {
		if (!tool.name) throw new Error("spawn-agent host tool name must be non-empty");
		if (toolMap.has(tool.name)) throw new Error(`spawn-agent host has duplicate tool: ${tool.name}`);
		toolMap.set(tool.name, tool);
	}
	const baseStreamFn = options.streamFn ?? streamSimple;

	return {
		resolveModel(route) {
			const parsed = modelRoute(route);
			return parsed ? options.modelRegistry.find(parsed.provider, parsed.id) : undefined;
		},
		estimateReservation(model, request) {
			return reservationFor(model, request, maxTurns);
		},
		async runAgent(model, request, runOptions): Promise<EvoSpawnAgentHostResult> {
			if (runOptions.signal.aborted) throw abortError(runOptions.signal);
			const tools = requestedTools(request, toolMap);
			reservationFor(model, request, maxTurns);
			const budget: RunBudget = {
				remainingOutputTokens: request.maxOutputTokens,
				startedTurns: 0,
				usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
			};
			const agent = new Agent({
				initialState: {
					systemPrompt: options.systemPrompt,
					model,
					thinkingLevel: request.reasoning ?? "off",
					tools,
				},
				streamFn: createBoundedStream(options.modelRegistry, baseStreamFn, budget, maxTurns),
				toolExecution: "sequential",
				prepareNextTurnWithContext(context) {
					const hasToolCalls =
						context.message.role === "assistant" &&
						context.message.content.some((content) => content.type === "toolCall");
					if (!hasToolCalls) return undefined;
					if (budget.remainingOutputTokens <= 0) {
						budget.stopStatus = "output-limit";
						return { stop: true };
					}
					if (budget.startedTurns >= maxTurns) {
						budget.stopStatus = "turn-limit";
						return { stop: true };
					}
					return undefined;
				},
			});
			const abort = (): void => agent.abort();
			runOptions.signal.addEventListener("abort", abort, { once: true });
			try {
				await agent.prompt(request.prompt);
				if (runOptions.signal.aborted) throw abortError(runOptions.signal);
				const finalMessage = lastAssistantMessage(agent.state.messages);
				if (!finalMessage) throw new Error("spawn-agent run completed without an assistant message");
				if (finalMessage.stopReason === "error" || finalMessage.stopReason === "aborted") {
					throw new Error(finalMessage.errorMessage ?? `spawn-agent run ended with ${finalMessage.stopReason}`);
				}
				const status: EvoSpawnAgentRunStatus =
					budget.stopStatus ?? (finalMessage.stopReason === "length" ? "length" : "completed");
				return {
					result: {
						schemaVersion: 1,
						status,
						model: { provider: model.provider, id: model.id },
						turns: budget.startedTurns,
						stopReason: finalMessage.stopReason,
						messages: jsonMessages(agent.state.messages, maxTranscriptBytes),
					} satisfies EvoSpawnAgentRunResult,
					usage: budget.usage,
				};
			} finally {
				runOptions.signal.removeEventListener("abort", abort);
			}
		},
	};
}
