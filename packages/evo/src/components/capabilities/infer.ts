import { Buffer } from "node:buffer";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, ThinkingLevel } from "@ch1nyzzz/pi-ai";
import { completeSimple } from "@ch1nyzzz/pi-ai/compat";
import type { ModelRegistry } from "@ch1nyzzz/pi-coding-agent";
import { canonicalJson } from "../../storage.ts";
import type {
	EvoCapabilityExecutionResult,
	EvoCapabilityService,
	EvoCapabilityServiceContext,
	EvoPreparedCapabilityRequest,
} from "./service.ts";

const THINKING_LEVELS = new Set<ThinkingLevel>(["minimal", "low", "medium", "high", "xhigh", "max"]);
const PROMPT_PROTOCOL_TOKEN_ALLOWANCE = 1_024;

export interface EvoInferRequest {
	model: string;
	systemPrompt?: string;
	prompt: string;
	maxOutputTokens: number;
	reasoning?: ThinkingLevel;
}

export interface EvoRawInferHost {
	resolveModel(route: string): Model<Api> | undefined;
	completeSimple(
		model: Model<Api>,
		context: Context,
		options: Pick<SimpleStreamOptions, "maxTokens" | "reasoning" | "signal">,
	): Promise<AssistantMessage>;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
	const allowedKeys = new Set(allowed);
	for (const key of Object.keys(record)) {
		if (!allowedKeys.has(key)) throw new Error(`${label} has unknown key: ${key}`);
	}
}

function parseInferRequest(value: unknown): EvoInferRequest {
	const request = asRecord(value, "infer request");
	rejectUnknownKeys(request, ["model", "systemPrompt", "prompt", "maxOutputTokens", "reasoning"], "infer request");
	if (
		typeof request.model !== "string" ||
		!request.model.includes("/") ||
		request.model.startsWith("/") ||
		request.model.endsWith("/") ||
		request.model.length > 300 ||
		/\s/.test(request.model)
	) {
		throw new Error("infer request.model must be a provider/model route");
	}
	if (request.systemPrompt !== undefined && typeof request.systemPrompt !== "string") {
		throw new Error("infer request.systemPrompt must be a string");
	}
	if (typeof request.prompt !== "string" || !request.prompt) {
		throw new Error("infer request.prompt must be a non-empty string");
	}
	if (!Number.isSafeInteger(request.maxOutputTokens) || (request.maxOutputTokens as number) <= 0) {
		throw new Error("infer request.maxOutputTokens must be a positive safe integer");
	}
	if (request.reasoning !== undefined && !THINKING_LEVELS.has(request.reasoning as ThinkingLevel)) {
		throw new Error("infer request.reasoning is invalid");
	}
	return {
		model: request.model,
		...(request.systemPrompt === undefined ? {} : { systemPrompt: request.systemPrompt }),
		prompt: request.prompt,
		maxOutputTokens: request.maxOutputTokens as number,
		...(request.reasoning === undefined ? {} : { reasoning: request.reasoning as ThinkingLevel }),
	};
}

function maximumRates(model: Model<Api>): { input: number; output: number } {
	const rates = [model.cost, ...(model.cost.tiers ?? [])];
	return {
		input: Math.max(...rates.map((rate) => Math.max(rate.input * 2, rate.cacheWrite, rate.cacheRead))),
		output: Math.max(...rates.map((rate) => rate.output)),
	};
}

function reservationFor(model: Model<Api>, request: EvoInferRequest) {
	const promptBytes =
		Buffer.byteLength(request.systemPrompt ?? "", "utf8") + Buffer.byteLength(request.prompt, "utf8");
	const inputTokens = promptBytes + PROMPT_PROTOCOL_TOKEN_ALLOWANCE;
	if (request.maxOutputTokens > model.maxTokens) {
		throw new Error(`infer request.maxOutputTokens exceeds model limit ${model.maxTokens}`);
	}
	if (inputTokens + request.maxOutputTokens > model.contextWindow) {
		throw new Error("infer request exceeds the model context window under the conservative token bound");
	}
	const rates = maximumRates(model);
	return {
		inputTokens,
		outputTokens: request.maxOutputTokens,
		totalTokens: inputTokens + request.maxOutputTokens,
		costUsd: (inputTokens * rates.input + request.maxOutputTokens * rates.output) / 1_000_000,
	};
}

function usageFrom(message: AssistantMessage) {
	const usage = message.usage;
	const values = [usage.input, usage.output, usage.totalTokens, usage.cost.total];
	if (values.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
		throw new Error("infer host returned invalid usage");
	}
	return {
		inputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
		outputTokens: usage.output,
		totalTokens: usage.totalTokens,
		costUsd: usage.cost.total,
	};
}

export function createModelRegistryInferHost(
	modelRegistry: Pick<ModelRegistry, "find" | "getApiKeyAndHeaders">,
): EvoRawInferHost {
	return {
		resolveModel(route) {
			const slash = route.indexOf("/");
			return slash <= 0 ? undefined : modelRegistry.find(route.slice(0, slash), route.slice(slash + 1));
		},
		async completeSimple(model, context, options) {
			const signal = options.signal;
			if (signal?.aborted) {
				throw signal.reason instanceof Error ? signal.reason : new Error("Infer request aborted");
			}
			const pendingAuth = modelRegistry.getApiKeyAndHeaders(model);
			let removeAbortListener = (): void => {};
			const aborted = new Promise<never>((_resolve, reject) => {
				if (!signal) return;
				const onAbort = (): void => {
					reject(signal.reason instanceof Error ? signal.reason : new Error("Infer request aborted"));
				};
				signal.addEventListener("abort", onAbort, { once: true });
				removeAbortListener = (): void => signal.removeEventListener("abort", onAbort);
				if (signal.aborted) onAbort();
			});
			const auth = await Promise.race([pendingAuth, aborted]).finally(removeAbortListener);
			if (!auth.ok) throw new Error(auth.error);
			return completeSimple(model, context, {
				...options,
				apiKey: auth.apiKey,
				headers: auth.headers,
				env: auth.env,
			});
		},
	};
}

export function createInferCapabilityService(host: EvoRawInferHost): EvoCapabilityService {
	return {
		prepare(payload: unknown): EvoPreparedCapabilityRequest {
			const request = parseInferRequest(payload);
			const model = host.resolveModel(request.model);
			if (!model) throw new Error(`infer model is unavailable: ${request.model}`);
			return {
				request,
				reservation: reservationFor(model, request),
				authorization: { model: request.model, maxOutputTokens: request.maxOutputTokens },
			};
		},
		async execute(value: unknown, context: EvoCapabilityServiceContext): Promise<EvoCapabilityExecutionResult> {
			const request = parseInferRequest(value);
			const model = host.resolveModel(request.model);
			if (!model) throw new Error(`infer model became unavailable: ${request.model}`);
			const message = await host.completeSimple(
				model,
				{
					...(request.systemPrompt === undefined ? {} : { systemPrompt: request.systemPrompt }),
					messages: [{ role: "user", content: request.prompt, timestamp: Date.now() }],
				},
				{
					maxTokens: request.maxOutputTokens,
					signal: context.signal,
					...(request.reasoning === undefined ? {} : { reasoning: request.reasoning }),
				},
			);
			const result = JSON.parse(
				canonicalJson({
					model: `${message.provider}/${message.model}`,
					content: message.content,
					stopReason: message.stopReason,
					...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
					usage: message.usage,
				}),
			) as unknown;
			return { result, usage: usageFrom(message) };
		},
	};
}
