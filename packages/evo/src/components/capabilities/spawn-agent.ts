import type { ThinkingLevel } from "@ch1nyzzz/pi-ai";
import { canonicalJson } from "../../storage.ts";
import type {
	EvoCapabilityExecutionResult,
	EvoCapabilityResourceUsage,
	EvoCapabilityService,
	EvoCapabilityServiceContext,
	EvoPreparedCapabilityRequest,
} from "./service.ts";

const THINKING_LEVELS = new Set<ThinkingLevel>(["minimal", "low", "medium", "high", "xhigh", "max"]);
const MAX_TOOLS = 256;
const MAX_TOOL_NAME_LENGTH = 300;

export interface EvoSpawnAgentRequest {
	model: string;
	prompt: string;
	maxOutputTokens: number;
	tools: string[];
	reasoning?: ThinkingLevel;
}

export interface EvoSpawnAgentHostResult {
	/** Complete JSON-safe run result. The broker persists this value in its audit log. */
	result: unknown;
	/** Aggregate usage across every model turn in the spawned run. */
	usage: EvoCapabilityResourceUsage;
}

export interface EvoSpawnAgentHostRunOptions {
	signal: AbortSignal;
}

/**
 * Trusted host adapter for creating one isolated child-agent run.
 *
 * TModel is an opaque host-only resolved-model handle. It is never serialized or
 * returned to the sandbox. The adapter must not place credentials in `result`,
 * must disable Evo/extensions in the child, and must expose only `request.tools`.
 */
export interface EvoRawSpawnAgentHost<TModel = unknown> {
	resolveModel(route: string): TModel | undefined;
	/**
	 * Return a deterministic conservative bound for the entire multi-turn run,
	 * including host prompt/tool-schema overhead and the host's fixed turn limit.
	 */
	estimateReservation(model: TModel, request: EvoSpawnAgentRequest): EvoCapabilityResourceUsage;
	/** Enforce maxOutputTokens as an aggregate run limit and honor options.signal. */
	runAgent(
		model: TModel,
		request: EvoSpawnAgentRequest,
		options: EvoSpawnAgentHostRunOptions,
	): Promise<EvoSpawnAgentHostResult>;
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

function parseModelRoute(value: unknown): string {
	if (
		typeof value !== "string" ||
		!value.includes("/") ||
		value.startsWith("/") ||
		value.endsWith("/") ||
		value.length > 300 ||
		/\s/.test(value)
	) {
		throw new Error("spawn-agent request.model must be a provider/model route");
	}
	return value;
}

function parseTools(value: unknown): string[] {
	if (!Array.isArray(value)) throw new Error("spawn-agent request.tools must be an array");
	if (value.length > MAX_TOOLS) throw new Error(`spawn-agent request.tools must contain at most ${MAX_TOOLS} tools`);
	if (
		value.some(
			(tool) =>
				typeof tool !== "string" || tool.length === 0 || tool.length > MAX_TOOL_NAME_LENGTH || tool.includes("\0"),
		)
	) {
		throw new Error("spawn-agent request.tools must contain bounded non-empty tool names");
	}
	const tools = value as string[];
	if (new Set(tools).size !== tools.length) throw new Error("spawn-agent request.tools must not contain duplicates");
	return [...tools].sort();
}

function parseSpawnAgentRequest(value: unknown): EvoSpawnAgentRequest {
	const request = asRecord(value, "spawn-agent request");
	rejectUnknownKeys(request, ["model", "prompt", "reasoning", "maxOutputTokens", "tools"], "spawn-agent request");
	const model = parseModelRoute(request.model);
	if (typeof request.prompt !== "string" || !request.prompt) {
		throw new Error("spawn-agent request.prompt must be a non-empty string");
	}
	if (!Number.isSafeInteger(request.maxOutputTokens) || (request.maxOutputTokens as number) <= 0) {
		throw new Error("spawn-agent request.maxOutputTokens must be a positive safe integer");
	}
	if (request.reasoning !== undefined && !THINKING_LEVELS.has(request.reasoning as ThinkingLevel)) {
		throw new Error("spawn-agent request.reasoning is invalid");
	}
	return {
		model,
		prompt: request.prompt,
		maxOutputTokens: request.maxOutputTokens as number,
		tools: parseTools(request.tools),
		...(request.reasoning === undefined ? {} : { reasoning: request.reasoning as ThinkingLevel }),
	};
}

function nonNegativeInteger(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new Error(`${label} must be a non-negative safe integer`);
	}
	return value as number;
}

function nonNegativeNumber(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(`${label} must be a non-negative finite number`);
	}
	return value;
}

function parseResourceUsage(value: unknown, label: string): EvoCapabilityResourceUsage {
	const usage = asRecord(value, label);
	rejectUnknownKeys(usage, ["inputTokens", "outputTokens", "totalTokens", "costUsd"], label);
	const parsed = {
		inputTokens: nonNegativeInteger(usage.inputTokens, `${label}.inputTokens`),
		outputTokens: nonNegativeInteger(usage.outputTokens, `${label}.outputTokens`),
		totalTokens: nonNegativeInteger(usage.totalTokens, `${label}.totalTokens`),
		costUsd: nonNegativeNumber(usage.costUsd, `${label}.costUsd`),
	};
	if (parsed.totalTokens < parsed.inputTokens || parsed.totalTokens < parsed.outputTokens) {
		throw new Error(`${label}.totalTokens must cover each token sub-total`);
	}
	return parsed;
}

function validateReservation(
	value: EvoCapabilityResourceUsage,
	request: EvoSpawnAgentRequest,
): EvoCapabilityResourceUsage {
	const reservation = parseResourceUsage(value, "spawn-agent reservation");
	if (reservation.inputTokens === 0) {
		throw new Error("spawn-agent reservation.inputTokens must cover the non-empty prompt");
	}
	if (reservation.outputTokens < request.maxOutputTokens) {
		throw new Error("spawn-agent reservation.outputTokens must cover request.maxOutputTokens");
	}
	return reservation;
}

function assertWithinReservation(usage: EvoCapabilityResourceUsage, reservation: EvoCapabilityResourceUsage): void {
	for (const key of ["inputTokens", "outputTokens", "totalTokens", "costUsd"] as const) {
		if (usage[key] > reservation[key]) {
			throw new Error(`spawn-agent host usage exceeded reserved ${key}`);
		}
	}
}

function normalizeHostResult(value: EvoSpawnAgentHostResult): EvoSpawnAgentHostResult {
	const response = asRecord(value as unknown, "spawn-agent host result");
	rejectUnknownKeys(response, ["result", "usage"], "spawn-agent host result");
	if (!Object.hasOwn(response, "result")) throw new Error("spawn-agent host result.result is required");
	if (!Object.hasOwn(response, "usage")) throw new Error("spawn-agent host result.usage is required");
	return {
		result: JSON.parse(canonicalJson(response.result)) as unknown,
		usage: parseResourceUsage(response.usage, "spawn-agent usage"),
	};
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("spawn-agent request aborted");
}

export function createSpawnAgentCapabilityService<TModel>(host: EvoRawSpawnAgentHost<TModel>): EvoCapabilityService {
	return {
		prepare(payload: unknown): EvoPreparedCapabilityRequest {
			const request = parseSpawnAgentRequest(payload);
			const model = host.resolveModel(request.model);
			if (model === undefined) throw new Error(`spawn-agent model is unavailable: ${request.model}`);
			const reservation = validateReservation(host.estimateReservation(model, request), request);
			return {
				request,
				reservation,
				authorization: {
					model: request.model,
					maxOutputTokens: request.maxOutputTokens,
					tools: request.tools,
				},
			};
		},
		async execute(value: unknown, context: EvoCapabilityServiceContext): Promise<EvoCapabilityExecutionResult> {
			const request = parseSpawnAgentRequest(value);
			const model = host.resolveModel(request.model);
			if (model === undefined) throw new Error(`spawn-agent model became unavailable: ${request.model}`);
			if (context.signal.aborted) throw abortError(context.signal);
			const reservation = validateReservation(host.estimateReservation(model, request), request);
			const response = normalizeHostResult(await host.runAgent(model, request, { signal: context.signal }));
			assertWithinReservation(response.usage, reservation);
			return response;
		},
	};
}
