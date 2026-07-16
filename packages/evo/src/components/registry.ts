import { canonicalJson } from "../storage.ts";
import type { EvoComponentSelection } from "../types.ts";
import { assertEvoAbiId, assertEvoCapability, assertEvoComponentId } from "./manifest.ts";

export interface EvoAbiDefinition<TInput = unknown, TOutput = unknown, TConfig = unknown> {
	id: string;
	surface: string;
	activationBoundary: "turn" | "session" | "process" | "invocation";
	capabilityCeiling: readonly string[];
	validateConfig(value: unknown): TConfig;
	validateInput(value: unknown): TInput;
	validateOutput(value: unknown): TOutput;
}

function assertSurfaceId(value: string): void {
	assertEvoComponentId(value, "ABI surface");
}

export class EvoAbiRegistry {
	private readonly definitions = new Map<string, EvoAbiDefinition>();

	register(definition: EvoAbiDefinition): void {
		assertEvoAbiId(definition.id, "ABI id");
		assertSurfaceId(definition.surface);
		for (const capability of definition.capabilityCeiling) assertEvoCapability(capability);
		if (new Set(definition.capabilityCeiling).size !== definition.capabilityCeiling.length) {
			throw new Error(`ABI ${definition.id} capability ceiling contains duplicates`);
		}
		if (this.definitions.has(definition.id)) throw new Error(`ABI is already registered: ${definition.id}`);
		this.definitions.set(definition.id, {
			...definition,
			capabilityCeiling: [...definition.capabilityCeiling].sort(),
		});
	}

	get(id: string): EvoAbiDefinition | undefined {
		return this.definitions.get(id);
	}

	require(id: string): EvoAbiDefinition {
		const definition = this.get(id);
		if (!definition) throw new Error(`Unknown Evo component ABI: ${id}`);
		return definition;
	}

	list(): EvoAbiDefinition[] {
		return [...this.definitions.values()].sort((left, right) => left.id.localeCompare(right.id));
	}

	validateSelection(surface: string, selection: EvoComponentSelection): unknown {
		const definition = this.require(selection.abi);
		if (definition.surface !== surface) {
			throw new Error(`ABI ${definition.id} belongs to surface ${definition.surface}, not ${surface}`);
		}
		const config = definition.validateConfig(selection.config ?? {});
		// Force config to be JSON data now, before it reaches a component process.
		canonicalJson(config);
		return config;
	}
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function jsonValue(value: unknown, label: string): unknown {
	try {
		return JSON.parse(canonicalJson(value)) as unknown;
	} catch (error) {
		throw new Error(`${label} must be JSON serializable`, { cause: error });
	}
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
	const allowedKeys = new Set(allowed);
	for (const key of Object.keys(record)) {
		if (!allowedKeys.has(key)) throw new Error(`${label} has unknown key: ${key}`);
	}
}

function validateEmptyConfig(value: unknown, label: string): Record<string, never> {
	const config = asRecord(jsonValue(value, label), label);
	rejectUnknownKeys(config, [], label);
	return {};
}

function requireNonEmptyString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string`);
	return value;
}

function requireJsonRecordArray(value: unknown, label: string): Record<string, unknown>[] {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
	return value.map((entry, index) => asRecord(entry, `${label}[${index}]`));
}

function requireStringArray(value: unknown, label: string): string[] {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
	return value.map((entry, index) => requireNonEmptyString(entry, `${label}[${index}]`));
}

export interface CompactionV1Input {
	conversation: string;
	previousSummary?: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	reason: "manual" | "threshold" | "overflow";
	customInstructions?: string;
}

export interface CompactionV1Output {
	summary: string;
	firstKeptEntryId: string;
	details?: unknown;
	metrics?: {
		durationMs?: number;
		inputTokens?: number;
		outputTokens?: number;
	};
}

export interface CompactionV1Config {
	maxSummaryTokens?: number;
	style?: "structured" | "narrative";
}

export const COMPACTION_V1_ABI: EvoAbiDefinition<CompactionV1Input, CompactionV1Output, CompactionV1Config> = {
	id: "compaction/v1",
	surface: "compaction",
	activationBoundary: "session",
	capabilityCeiling: [],
	validateConfig(value) {
		const config = asRecord(jsonValue(value, "compaction/v1 config"), "compaction/v1 config");
		for (const key of Object.keys(config)) {
			if (key !== "maxSummaryTokens" && key !== "style") {
				throw new Error(`compaction/v1 config has unknown key: ${key}`);
			}
		}
		if (
			config.maxSummaryTokens !== undefined &&
			(!Number.isSafeInteger(config.maxSummaryTokens) ||
				(config.maxSummaryTokens as number) <= 0 ||
				(config.maxSummaryTokens as number) > 32_768)
		) {
			throw new Error("compaction/v1 config.maxSummaryTokens must be an integer from 1 to 32768");
		}
		if (config.style !== undefined && config.style !== "structured" && config.style !== "narrative") {
			throw new Error("compaction/v1 config.style is invalid");
		}
		return {
			...(config.maxSummaryTokens === undefined ? {} : { maxSummaryTokens: config.maxSummaryTokens as number }),
			...(config.style === undefined ? {} : { style: config.style as "structured" | "narrative" }),
		};
	},
	validateInput(value) {
		const input = asRecord(value, "compaction/v1 input");
		if (
			typeof input.conversation !== "string" ||
			typeof input.firstKeptEntryId !== "string" ||
			!input.firstKeptEntryId ||
			typeof input.tokensBefore !== "number" ||
			!Number.isFinite(input.tokensBefore) ||
			input.tokensBefore < 0 ||
			(input.reason !== "manual" && input.reason !== "threshold" && input.reason !== "overflow") ||
			(input.previousSummary !== undefined && typeof input.previousSummary !== "string") ||
			(input.customInstructions !== undefined && typeof input.customInstructions !== "string")
		) {
			throw new Error("compaction/v1 input is invalid");
		}
		return input as unknown as CompactionV1Input;
	},
	validateOutput(value) {
		const output = asRecord(value, "compaction/v1 output");
		if (
			typeof output.summary !== "string" ||
			!output.summary.trim() ||
			typeof output.firstKeptEntryId !== "string" ||
			!output.firstKeptEntryId
		) {
			throw new Error("compaction/v1 output must contain a summary and firstKeptEntryId");
		}
		if (output.details !== undefined) jsonValue(output.details, "compaction/v1 details");
		if (output.metrics !== undefined) {
			const metrics = asRecord(output.metrics, "compaction/v1 metrics");
			for (const key of ["durationMs", "inputTokens", "outputTokens"] as const) {
				const metric = metrics[key];
				if (metric !== undefined && (typeof metric !== "number" || !Number.isFinite(metric) || metric < 0)) {
					throw new Error(`compaction/v1 metrics.${key} must be non-negative`);
				}
			}
		}
		return output as unknown as CompactionV1Output;
	},
};

// context/v1 — the conversation-history axis. Two modes discriminated by `mode`:
// `transform` (ephemeral view recomputed each turn) and `checkpoint` (durable
// summary, byte-compatible with compaction/v1's contract). Empty ceiling for
// prune/redact/summarize; retrieve/infer are added later for RAG and abstractive
// summaries. See docs/host-abis.md.

export interface ContextV1TransformInput {
	mode: "transform";
	messages: unknown[];
	tokenEstimate?: number;
	contextWindow?: number;
	model?: string;
	reason: "turn";
}

export interface ContextV1CheckpointInput {
	mode: "checkpoint";
	conversation: string;
	previousSummary?: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	reason: "manual" | "threshold" | "overflow";
	customInstructions?: string;
}

export type ContextV1Input = ContextV1TransformInput | ContextV1CheckpointInput;

export interface ContextV1TransformOutput {
	messages: unknown[];
}

export interface ContextV1CheckpointOutput {
	summary: string;
	firstKeptEntryId: string;
	details?: unknown;
	metrics?: {
		durationMs?: number;
		inputTokens?: number;
		outputTokens?: number;
	};
}

export type ContextV1Output = ContextV1TransformOutput | ContextV1CheckpointOutput;

export interface ContextV1Config {
	maxSummaryTokens?: number;
	style?: "structured" | "narrative";
}

function assertJsonMessageArray(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
	for (const [index, entry] of value.entries()) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			throw new Error(`${label}[${index}] must be a message object`);
		}
	}
	jsonValue(value, label);
	return value;
}

function requireFiniteNumber(value: unknown, label: string, minimum = Number.NEGATIVE_INFINITY): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
		throw new Error(`${label} must be a finite number${minimum === 0 ? " greater than or equal to zero" : ""}`);
	}
	return value;
}

function assertTextContent(value: unknown, label: string): void {
	const content = asRecord(value, label);
	rejectUnknownKeys(content, ["type", "text", "textSignature"], label);
	if (content.type !== "text" || typeof content.text !== "string") {
		throw new Error(`${label} must be text content`);
	}
	if (content.textSignature !== undefined && typeof content.textSignature !== "string") {
		throw new Error(`${label}.textSignature must be a string`);
	}
}

function assertImageContent(value: unknown, label: string): void {
	const content = asRecord(value, label);
	rejectUnknownKeys(content, ["type", "data", "mimeType"], label);
	if (
		content.type !== "image" ||
		typeof content.data !== "string" ||
		typeof content.mimeType !== "string" ||
		!content.mimeType
	) {
		throw new Error(`${label} must be image content`);
	}
}

function assertThinkingContent(value: unknown, label: string): void {
	const content = asRecord(value, label);
	rejectUnknownKeys(content, ["type", "thinking", "thinkingSignature", "redacted"], label);
	if (content.type !== "thinking" || typeof content.thinking !== "string") {
		throw new Error(`${label} must be thinking content`);
	}
	if (content.thinkingSignature !== undefined && typeof content.thinkingSignature !== "string") {
		throw new Error(`${label}.thinkingSignature must be a string`);
	}
	if (content.redacted !== undefined && typeof content.redacted !== "boolean") {
		throw new Error(`${label}.redacted must be boolean`);
	}
}

function assertToolCallContent(value: unknown, label: string): void {
	const content = asRecord(value, label);
	rejectUnknownKeys(content, ["type", "id", "name", "arguments", "thoughtSignature"], label);
	if (
		content.type !== "toolCall" ||
		typeof content.id !== "string" ||
		!content.id ||
		typeof content.name !== "string" ||
		!content.name
	) {
		throw new Error(`${label} must be tool-call content`);
	}
	asRecord(content.arguments, `${label}.arguments`);
	if (content.thoughtSignature !== undefined && typeof content.thoughtSignature !== "string") {
		throw new Error(`${label}.thoughtSignature must be a string`);
	}
}

function assertUserContent(value: unknown, label: string): void {
	if (typeof value === "string") return;
	if (!Array.isArray(value)) throw new Error(`${label} must be a string or content array`);
	for (const [index, content] of value.entries()) {
		const type = asRecord(content, `${label}[${index}]`).type;
		if (type === "text") assertTextContent(content, `${label}[${index}]`);
		else if (type === "image") assertImageContent(content, `${label}[${index}]`);
		else throw new Error(`${label}[${index}] must be text or image content`);
	}
}

function assertAssistantContent(value: unknown, label: string, allowToolCalls: boolean): void {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
	for (const [index, content] of value.entries()) {
		const contentLabel = `${label}[${index}]`;
		const type = asRecord(content, contentLabel).type;
		if (type === "text") assertTextContent(content, contentLabel);
		else if (type === "thinking") assertThinkingContent(content, contentLabel);
		else if (type === "toolCall" && allowToolCalls) assertToolCallContent(content, contentLabel);
		else {
			throw new Error(`${contentLabel} must be text or thinking content${allowToolCalls ? ", or a tool call" : ""}`);
		}
	}
}

function assertToolResultContent(value: unknown, label: string): void {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
	for (const [index, content] of value.entries()) {
		const contentLabel = `${label}[${index}]`;
		const type = asRecord(content, contentLabel).type;
		if (type === "text") assertTextContent(content, contentLabel);
		else if (type === "image") assertImageContent(content, contentLabel);
		else throw new Error(`${contentLabel} must be text or image content`);
	}
}

function assertUsage(value: unknown, label: string): void {
	const usage = asRecord(value, label);
	rejectUnknownKeys(
		usage,
		["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "reasoning", "totalTokens", "cost"],
		label,
	);
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
		requireFiniteNumber(usage[key], `${label}.${key}`, 0);
	}
	for (const key of ["cacheWrite1h", "reasoning"] as const) {
		if (usage[key] !== undefined) requireFiniteNumber(usage[key], `${label}.${key}`, 0);
	}
	const cost = asRecord(usage.cost, `${label}.cost`);
	rejectUnknownKeys(cost, ["input", "output", "cacheRead", "cacheWrite", "total"], `${label}.cost`);
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
		requireFiniteNumber(cost[key], `${label}.cost.${key}`, 0);
	}
}

function assertDiagnostics(value: unknown, label: string): void {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
	for (const [index, diagnosticValue] of value.entries()) {
		const diagnosticLabel = `${label}[${index}]`;
		const diagnostic = asRecord(diagnosticValue, diagnosticLabel);
		rejectUnknownKeys(diagnostic, ["type", "timestamp", "error", "details"], diagnosticLabel);
		requireNonEmptyString(diagnostic.type, `${diagnosticLabel}.type`);
		assertTimestamp(diagnostic.timestamp, `${diagnosticLabel}.timestamp`);
		if (diagnostic.error !== undefined) {
			const errorLabel = `${diagnosticLabel}.error`;
			const error = asRecord(diagnostic.error, errorLabel);
			rejectUnknownKeys(error, ["name", "message", "stack", "code"], errorLabel);
			if (typeof error.message !== "string") throw new Error(`${errorLabel}.message must be a string`);
			for (const key of ["name", "stack"] as const) {
				if (error[key] !== undefined && typeof error[key] !== "string") {
					throw new Error(`${errorLabel}.${key} must be a string`);
				}
			}
			if (
				error.code !== undefined &&
				typeof error.code !== "string" &&
				(typeof error.code !== "number" || !Number.isFinite(error.code))
			) {
				throw new Error(`${errorLabel}.code must be a string or finite number`);
			}
		}
		if (diagnostic.details !== undefined) asRecord(diagnostic.details, `${diagnosticLabel}.details`);
	}
}

const STOP_REASONS = new Set(["stop", "length", "toolUse", "error", "aborted"]);

function assertTimestamp(value: unknown, label: string): void {
	requireFiniteNumber(value, label, 0);
}

function assertAgentMessage(value: unknown, label: string): void {
	const message = asRecord(value, label);
	switch (message.role) {
		case "user":
			rejectUnknownKeys(message, ["role", "content", "timestamp"], label);
			assertUserContent(message.content, `${label}.content`);
			assertTimestamp(message.timestamp, `${label}.timestamp`);
			return;
		case "assistant":
			rejectUnknownKeys(
				message,
				[
					"role",
					"content",
					"api",
					"provider",
					"model",
					"responseModel",
					"responseId",
					"diagnostics",
					"usage",
					"stopReason",
					"errorMessage",
					"timestamp",
				],
				label,
			);
			assertAssistantContent(message.content, `${label}.content`, true);
			for (const key of ["api", "provider", "model"] as const) {
				requireNonEmptyString(message[key], `${label}.${key}`);
			}
			for (const key of ["responseModel", "responseId", "errorMessage"] as const) {
				if (message[key] !== undefined && typeof message[key] !== "string") {
					throw new Error(`${label}.${key} must be a string`);
				}
			}
			if (message.diagnostics !== undefined) assertDiagnostics(message.diagnostics, `${label}.diagnostics`);
			assertUsage(message.usage, `${label}.usage`);
			if (typeof message.stopReason !== "string" || !STOP_REASONS.has(message.stopReason)) {
				throw new Error(`${label}.stopReason is invalid`);
			}
			assertTimestamp(message.timestamp, `${label}.timestamp`);
			return;
		case "toolResult":
			rejectUnknownKeys(
				message,
				["role", "toolCallId", "toolName", "content", "details", "addedToolNames", "isError", "timestamp"],
				label,
			);
			requireNonEmptyString(message.toolCallId, `${label}.toolCallId`);
			requireNonEmptyString(message.toolName, `${label}.toolName`);
			assertToolResultContent(message.content, `${label}.content`);
			if (message.details !== undefined) jsonValue(message.details, `${label}.details`);
			if (message.addedToolNames !== undefined) {
				requireStringArray(message.addedToolNames, `${label}.addedToolNames`);
			}
			if (typeof message.isError !== "boolean") throw new Error(`${label}.isError must be boolean`);
			assertTimestamp(message.timestamp, `${label}.timestamp`);
			return;
		case "bashExecution":
			rejectUnknownKeys(
				message,
				[
					"role",
					"command",
					"output",
					"exitCode",
					"cancelled",
					"truncated",
					"fullOutputPath",
					"timestamp",
					"excludeFromContext",
				],
				label,
			);
			for (const key of ["command", "output"] as const) {
				if (typeof message[key] !== "string") throw new Error(`${label}.${key} must be a string`);
			}
			if (message.exitCode !== undefined) requireFiniteNumber(message.exitCode, `${label}.exitCode`);
			if (message.fullOutputPath !== undefined && typeof message.fullOutputPath !== "string") {
				throw new Error(`${label}.fullOutputPath must be a string`);
			}
			for (const key of ["cancelled", "truncated"] as const) {
				if (typeof message[key] !== "boolean") throw new Error(`${label}.${key} must be boolean`);
			}
			if (message.excludeFromContext !== undefined && typeof message.excludeFromContext !== "boolean") {
				throw new Error(`${label}.excludeFromContext must be boolean`);
			}
			assertTimestamp(message.timestamp, `${label}.timestamp`);
			return;
		case "custom":
			rejectUnknownKeys(message, ["role", "customType", "content", "display", "details", "timestamp"], label);
			requireNonEmptyString(message.customType, `${label}.customType`);
			assertUserContent(message.content, `${label}.content`);
			if (typeof message.display !== "boolean") throw new Error(`${label}.display must be boolean`);
			if (message.details !== undefined) jsonValue(message.details, `${label}.details`);
			assertTimestamp(message.timestamp, `${label}.timestamp`);
			return;
		case "branchSummary":
			rejectUnknownKeys(message, ["role", "summary", "fromId", "timestamp"], label);
			requireNonEmptyString(message.summary, `${label}.summary`);
			requireNonEmptyString(message.fromId, `${label}.fromId`);
			assertTimestamp(message.timestamp, `${label}.timestamp`);
			return;
		case "compactionSummary":
			rejectUnknownKeys(message, ["role", "summary", "tokensBefore", "timestamp"], label);
			requireNonEmptyString(message.summary, `${label}.summary`);
			requireFiniteNumber(message.tokensBefore, `${label}.tokensBefore`, 0);
			assertTimestamp(message.timestamp, `${label}.timestamp`);
			return;
		default:
			throw new Error(`${label}.role is unsupported`);
	}
}

function assertAgentMessageArray(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
	for (const [index, message] of value.entries()) {
		assertAgentMessage(message, `${label}[${index}]`);
	}
	return value;
}

export const CONTEXT_V1_ABI: EvoAbiDefinition<ContextV1Input, ContextV1Output, ContextV1Config> = {
	id: "context/v1",
	surface: "context",
	activationBoundary: "session",
	capabilityCeiling: ["infer", "retrieve"],
	validateConfig(value) {
		const config = asRecord(jsonValue(value, "context/v1 config"), "context/v1 config");
		for (const key of Object.keys(config)) {
			if (key !== "maxSummaryTokens" && key !== "style") {
				throw new Error(`context/v1 config has unknown key: ${key}`);
			}
		}
		if (
			config.maxSummaryTokens !== undefined &&
			(!Number.isSafeInteger(config.maxSummaryTokens) ||
				(config.maxSummaryTokens as number) <= 0 ||
				(config.maxSummaryTokens as number) > 32_768)
		) {
			throw new Error("context/v1 config.maxSummaryTokens must be an integer from 1 to 32768");
		}
		if (config.style !== undefined && config.style !== "structured" && config.style !== "narrative") {
			throw new Error("context/v1 config.style is invalid");
		}
		return {
			...(config.maxSummaryTokens === undefined ? {} : { maxSummaryTokens: config.maxSummaryTokens as number }),
			...(config.style === undefined ? {} : { style: config.style as "structured" | "narrative" }),
		};
	},
	validateInput(value) {
		const input = asRecord(value, "context/v1 input");
		if (input.mode === "transform") {
			assertJsonMessageArray(input.messages, "context/v1 transform input.messages");
			if (input.reason !== "turn") throw new Error("context/v1 transform input.reason must be 'turn'");
			for (const key of ["tokenEstimate", "contextWindow"] as const) {
				const metric = input[key];
				if (metric !== undefined && (typeof metric !== "number" || !Number.isFinite(metric) || metric < 0)) {
					throw new Error(`context/v1 transform input.${key} must be a non-negative number`);
				}
			}
			if (input.model !== undefined && typeof input.model !== "string") {
				throw new Error("context/v1 transform input.model must be a string");
			}
			return input as unknown as ContextV1Input;
		}
		if (input.mode === "checkpoint") {
			if (
				typeof input.conversation !== "string" ||
				typeof input.firstKeptEntryId !== "string" ||
				!input.firstKeptEntryId ||
				typeof input.tokensBefore !== "number" ||
				!Number.isFinite(input.tokensBefore) ||
				input.tokensBefore < 0 ||
				(input.reason !== "manual" && input.reason !== "threshold" && input.reason !== "overflow") ||
				(input.previousSummary !== undefined && typeof input.previousSummary !== "string") ||
				(input.customInstructions !== undefined && typeof input.customInstructions !== "string")
			) {
				throw new Error("context/v1 checkpoint input is invalid");
			}
			return input as unknown as ContextV1Input;
		}
		throw new Error("context/v1 input.mode must be 'transform' or 'checkpoint'");
	},
	validateOutput(value) {
		const output = asRecord(jsonValue(value, "context/v1 output"), "context/v1 output");
		if (Array.isArray(output.messages)) {
			assertAgentMessageArray(output.messages, "context/v1 transform output.messages");
			return output as unknown as ContextV1Output;
		}
		if (typeof output.summary === "string") {
			if (!output.summary.trim() || typeof output.firstKeptEntryId !== "string" || !output.firstKeptEntryId) {
				throw new Error("context/v1 checkpoint output must contain a summary and firstKeptEntryId");
			}
			if (output.details !== undefined) jsonValue(output.details, "context/v1 details");
			if (output.metrics !== undefined) {
				const metrics = asRecord(output.metrics, "context/v1 metrics");
				for (const key of ["durationMs", "inputTokens", "outputTokens"] as const) {
					const metric = metrics[key];
					if (metric !== undefined && (typeof metric !== "number" || !Number.isFinite(metric) || metric < 0)) {
						throw new Error(`context/v1 metrics.${key} must be non-negative`);
					}
				}
			}
			return output as unknown as ContextV1Output;
		}
		throw new Error("context/v1 output must contain messages (transform) or a summary (checkpoint)");
	},
};

export interface GuardV1BeforeInput {
	mode: "before";
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
}

export interface GuardV1AfterInput {
	mode: "after";
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	content: unknown[];
	details?: unknown;
	isError: boolean;
}

export type GuardV1Input = GuardV1BeforeInput | GuardV1AfterInput;

export interface GuardV1BeforeOutput {
	mode: "before";
	block?: boolean;
	reason?: string;
	args?: Record<string, unknown>;
}

export interface GuardV1AfterOutput {
	mode: "after";
	content?: unknown[];
	details?: unknown;
	isError?: boolean;
	terminate?: boolean;
}

export type GuardV1Output = GuardV1BeforeOutput | GuardV1AfterOutput;

export const GUARD_V1_ABI: EvoAbiDefinition<GuardV1Input, GuardV1Output, Record<string, never>> = {
	id: "guard/v1",
	surface: "guard",
	activationBoundary: "session",
	capabilityCeiling: [],
	validateConfig(value) {
		return validateEmptyConfig(value, "guard/v1 config");
	},
	validateInput(value) {
		const input = asRecord(jsonValue(value, "guard/v1 input"), "guard/v1 input");
		requireNonEmptyString(input.toolCallId, "guard/v1 input.toolCallId");
		requireNonEmptyString(input.toolName, "guard/v1 input.toolName");
		asRecord(input.args, "guard/v1 input.args");
		if (input.mode === "before") {
			rejectUnknownKeys(input, ["mode", "toolCallId", "toolName", "args"], "guard/v1 before input");
			return input as unknown as GuardV1BeforeInput;
		}
		if (input.mode === "after") {
			rejectUnknownKeys(
				input,
				["mode", "toolCallId", "toolName", "args", "content", "details", "isError"],
				"guard/v1 after input",
			);
			assertJsonMessageArray(input.content, "guard/v1 after input.content");
			if (input.details !== undefined) jsonValue(input.details, "guard/v1 after input.details");
			if (typeof input.isError !== "boolean") throw new Error("guard/v1 after input.isError must be boolean");
			return input as unknown as GuardV1AfterInput;
		}
		throw new Error("guard/v1 input.mode must be 'before' or 'after'");
	},
	validateOutput(value) {
		const output = asRecord(jsonValue(value, "guard/v1 output"), "guard/v1 output");
		if (output.mode === "before") {
			rejectUnknownKeys(output, ["mode", "block", "reason", "args"], "guard/v1 before output");
			if (output.block !== undefined && typeof output.block !== "boolean") {
				throw new Error("guard/v1 before output.block must be boolean");
			}
			if (output.reason !== undefined && typeof output.reason !== "string") {
				throw new Error("guard/v1 before output.reason must be a string");
			}
			if (output.args !== undefined) asRecord(output.args, "guard/v1 before output.args");
			return output as unknown as GuardV1BeforeOutput;
		}
		if (output.mode === "after") {
			rejectUnknownKeys(output, ["mode", "content", "details", "isError", "terminate"], "guard/v1 after output");
			if (output.content !== undefined) assertToolResultContent(output.content, "guard/v1 after output.content");
			if (output.details !== undefined) jsonValue(output.details, "guard/v1 after output.details");
			for (const key of ["isError", "terminate"] as const) {
				if (output[key] !== undefined && typeof output[key] !== "boolean") {
					throw new Error(`guard/v1 after output.${key} must be boolean`);
				}
			}
			return output as unknown as GuardV1AfterOutput;
		}
		throw new Error("guard/v1 output.mode must be 'before' or 'after'");
	},
};

export interface InstructionsV1Input {
	systemPrompt: string;
	options: Record<string, unknown>;
}

export interface InstructionsV1Section {
	name?: string;
	content: string;
}

export type InstructionsV1Output = { systemPrompt: string } | { sections: InstructionsV1Section[] };

export const INSTRUCTIONS_V1_ABI: EvoAbiDefinition<InstructionsV1Input, InstructionsV1Output, Record<string, never>> = {
	id: "instructions/v1",
	surface: "instructions",
	activationBoundary: "turn",
	capabilityCeiling: ["read-file"],
	validateConfig(value) {
		return validateEmptyConfig(value, "instructions/v1 config");
	},
	validateInput(value) {
		const input = asRecord(jsonValue(value, "instructions/v1 input"), "instructions/v1 input");
		rejectUnknownKeys(input, ["systemPrompt", "options"], "instructions/v1 input");
		if (typeof input.systemPrompt !== "string") {
			throw new Error("instructions/v1 input.systemPrompt must be a string");
		}
		asRecord(input.options, "instructions/v1 input.options");
		return input as unknown as InstructionsV1Input;
	},
	validateOutput(value) {
		const output = asRecord(jsonValue(value, "instructions/v1 output"), "instructions/v1 output");
		const hasPrompt = Object.hasOwn(output, "systemPrompt");
		const hasSections = Object.hasOwn(output, "sections");
		if (hasPrompt === hasSections) {
			throw new Error("instructions/v1 output must contain exactly one of systemPrompt or sections");
		}
		if (hasPrompt) {
			rejectUnknownKeys(output, ["systemPrompt"], "instructions/v1 output");
			if (typeof output.systemPrompt !== "string") {
				throw new Error("instructions/v1 output.systemPrompt must be a string");
			}
			return { systemPrompt: output.systemPrompt };
		}
		rejectUnknownKeys(output, ["sections"], "instructions/v1 output");
		if (!Array.isArray(output.sections) || output.sections.length === 0) {
			throw new Error("instructions/v1 output.sections must be a non-empty array");
		}
		const sections = output.sections.map((value, index) => {
			const section = asRecord(value, `instructions/v1 output.sections[${index}]`);
			rejectUnknownKeys(section, ["name", "content"], `instructions/v1 output.sections[${index}]`);
			if (section.name !== undefined && typeof section.name !== "string") {
				throw new Error(`instructions/v1 output.sections[${index}].name must be a string`);
			}
			if (typeof section.content !== "string") {
				throw new Error(`instructions/v1 output.sections[${index}].content must be a string`);
			}
			return {
				...(section.name === undefined ? {} : { name: section.name }),
				content: section.content,
			};
		});
		return { sections };
	},
};

export interface GenerationV1Input {
	message: Record<string, unknown>;
}

export interface GenerationV1Output {
	message?: Record<string, unknown>;
	redo?: boolean;
	stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted";
}

export const GENERATION_V1_ABI: EvoAbiDefinition<GenerationV1Input, GenerationV1Output, Record<string, never>> = {
	id: "generation/v1",
	surface: "generation",
	activationBoundary: "turn",
	capabilityCeiling: ["infer"],
	validateConfig(value) {
		return validateEmptyConfig(value, "generation/v1 config");
	},
	validateInput(value) {
		const input = asRecord(jsonValue(value, "generation/v1 input"), "generation/v1 input");
		rejectUnknownKeys(input, ["message"], "generation/v1 input");
		asRecord(input.message, "generation/v1 input.message");
		return input as unknown as GenerationV1Input;
	},
	validateOutput(value) {
		const output = asRecord(jsonValue(value, "generation/v1 output"), "generation/v1 output");
		rejectUnknownKeys(output, ["message", "redo", "stopReason"], "generation/v1 output");
		if (!Object.hasOwn(output, "message") && !Object.hasOwn(output, "redo") && !Object.hasOwn(output, "stopReason")) {
			throw new Error("generation/v1 output must contain message, redo, or stopReason");
		}
		if (output.message !== undefined) {
			const message = asRecord(output.message, "generation/v1 output.message");
			if (message.role !== "assistant") throw new Error("generation/v1 output.message.role must be assistant");
			assertAssistantContent(message.content, "generation/v1 output.message.content", false);
		}
		if (output.redo !== undefined && typeof output.redo !== "boolean") {
			throw new Error("generation/v1 output.redo must be boolean");
		}
		if (
			output.stopReason !== undefined &&
			(typeof output.stopReason !== "string" || !STOP_REASONS.has(output.stopReason))
		) {
			throw new Error("generation/v1 output.stopReason is invalid");
		}
		return output as unknown as GenerationV1Output;
	},
};

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export interface ControlV1Usage {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

export interface ControlV1Input {
	turnIndex: number;
	message: Record<string, unknown>;
	toolResults: Record<string, unknown>[];
	usage?: ControlV1Usage;
	model?: string;
	reasoning?: string;
}

export interface ControlV1Output {
	stop?: boolean;
	model?: string;
	reasoning?: string;
	memoryDeltas?: Record<string, unknown>[];
}

export const CONTROL_V1_ABI: EvoAbiDefinition<ControlV1Input, ControlV1Output, Record<string, never>> = {
	id: "control/v1",
	surface: "control",
	activationBoundary: "session",
	capabilityCeiling: ["memory-write"],
	validateConfig(value) {
		return validateEmptyConfig(value, "control/v1 config");
	},
	validateInput(value) {
		const input = asRecord(jsonValue(value, "control/v1 input"), "control/v1 input");
		rejectUnknownKeys(
			input,
			["turnIndex", "message", "toolResults", "usage", "model", "reasoning"],
			"control/v1 input",
		);
		if (!Number.isSafeInteger(input.turnIndex) || (input.turnIndex as number) < 0) {
			throw new Error("control/v1 input.turnIndex must be a non-negative safe integer");
		}
		asRecord(input.message, "control/v1 input.message");
		assertJsonMessageArray(input.toolResults, "control/v1 input.toolResults");
		if (input.usage !== undefined) {
			const usage = asRecord(input.usage, "control/v1 input.usage");
			rejectUnknownKeys(usage, ["tokens", "contextWindow", "percent"], "control/v1 input.usage");
			if (usage.tokens !== null && (typeof usage.tokens !== "number" || !Number.isFinite(usage.tokens))) {
				throw new Error("control/v1 input.usage.tokens must be a finite number or null");
			}
			if (
				typeof usage.contextWindow !== "number" ||
				!Number.isFinite(usage.contextWindow) ||
				usage.contextWindow < 0
			) {
				throw new Error("control/v1 input.usage.contextWindow must be a non-negative number");
			}
			if (usage.percent !== null && (typeof usage.percent !== "number" || !Number.isFinite(usage.percent))) {
				throw new Error("control/v1 input.usage.percent must be a finite number or null");
			}
		}
		if (input.model !== undefined) requireNonEmptyString(input.model, "control/v1 input.model");
		if (input.reasoning !== undefined && !THINKING_LEVELS.has(input.reasoning as string)) {
			throw new Error("control/v1 input.reasoning is invalid");
		}
		return input as unknown as ControlV1Input;
	},
	validateOutput(value) {
		const output = asRecord(jsonValue(value, "control/v1 output"), "control/v1 output");
		rejectUnknownKeys(output, ["stop", "model", "reasoning", "memoryDeltas"], "control/v1 output");
		if (
			!Object.hasOwn(output, "stop") &&
			!Object.hasOwn(output, "model") &&
			!Object.hasOwn(output, "reasoning") &&
			!Object.hasOwn(output, "memoryDeltas")
		) {
			throw new Error("control/v1 output must contain stop, model, reasoning, or memoryDeltas");
		}
		if (output.stop !== undefined && typeof output.stop !== "boolean") {
			throw new Error("control/v1 output.stop must be boolean");
		}
		if (output.model !== undefined) requireNonEmptyString(output.model, "control/v1 output.model");
		if (output.reasoning !== undefined && !THINKING_LEVELS.has(output.reasoning as string)) {
			throw new Error("control/v1 output.reasoning is invalid");
		}
		if (output.memoryDeltas !== undefined) {
			requireJsonRecordArray(output.memoryDeltas, "control/v1 output.memoryDeltas");
		}
		return output as unknown as ControlV1Output;
	},
};

export interface ToolV1Input {
	params: Record<string, unknown>;
}

export type ToolV1Content =
	| {
			type: "text";
			text: string;
			textSignature?: string;
	  }
	| {
			type: "image";
			data: string;
			mimeType: string;
	  };

export interface ToolV1Output {
	content: ToolV1Content[];
	details: unknown;
	addedToolNames?: string[];
	terminate?: boolean;
}

function validateToolV1Content(value: unknown, index: number): ToolV1Content {
	const label = `tool/v1 output.content[${index}]`;
	const content = asRecord(value, label);
	if (content.type === "text") {
		rejectUnknownKeys(content, ["type", "text", "textSignature"], label);
		if (typeof content.text !== "string") throw new Error(`${label}.text must be a string`);
		if (content.textSignature !== undefined && typeof content.textSignature !== "string") {
			throw new Error(`${label}.textSignature must be a string`);
		}
		return content as unknown as ToolV1Content;
	}
	if (content.type === "image") {
		rejectUnknownKeys(content, ["type", "data", "mimeType"], label);
		requireNonEmptyString(content.data, `${label}.data`);
		requireNonEmptyString(content.mimeType, `${label}.mimeType`);
		return content as unknown as ToolV1Content;
	}
	throw new Error(`${label}.type must be 'text' or 'image'`);
}

export const TOOL_V1_ABI: EvoAbiDefinition<ToolV1Input, ToolV1Output, Record<string, never>> = {
	id: "tool/v1",
	surface: "tool",
	activationBoundary: "session",
	capabilityCeiling: ["exec", "http-fetch", "infer", "list-dir", "read-file", "write-file"],
	validateConfig(value) {
		return validateEmptyConfig(value, "tool/v1 config");
	},
	validateInput(value) {
		const input = asRecord(jsonValue(value, "tool/v1 input"), "tool/v1 input");
		rejectUnknownKeys(input, ["params"], "tool/v1 input");
		asRecord(input.params, "tool/v1 input.params");
		return input as unknown as ToolV1Input;
	},
	validateOutput(value) {
		const output = asRecord(jsonValue(value, "tool/v1 output"), "tool/v1 output");
		rejectUnknownKeys(output, ["content", "details", "addedToolNames", "terminate"], "tool/v1 output");
		if (!Array.isArray(output.content)) throw new Error("tool/v1 output.content must be an array");
		output.content.forEach(validateToolV1Content);
		if (!Object.hasOwn(output, "details")) throw new Error("tool/v1 output.details is required");
		jsonValue(output.details, "tool/v1 output.details");
		if (output.addedToolNames !== undefined) {
			requireStringArray(output.addedToolNames, "tool/v1 output.addedToolNames");
		}
		if (output.terminate !== undefined && typeof output.terminate !== "boolean") {
			throw new Error("tool/v1 output.terminate must be boolean");
		}
		return output as unknown as ToolV1Output;
	},
};

export interface MemoryV1RecallInput {
	mode: "recall";
	query: string;
}

export interface MemoryV1EncodeInput {
	mode: "encode";
	turnDigest: Record<string, unknown>;
}

export interface MemoryV1ConsolidateInput {
	mode: "consolidate";
	candidates: Record<string, unknown>[];
}

export type MemoryV1Input = MemoryV1RecallInput | MemoryV1EncodeInput | MemoryV1ConsolidateInput;

export interface MemoryV1RecallOutput {
	mode: "recall";
	fragments: Record<string, unknown>[];
}

export interface MemoryV1EncodeOutput {
	mode: "encode";
	writes: Record<string, unknown>[];
	updates: Record<string, unknown>[];
	forgets: string[];
}

export interface MemoryV1ConsolidateOutput {
	mode: "consolidate";
	merged: Record<string, unknown>[];
	insights: Record<string, unknown>[];
	forget: string[];
}

export type MemoryV1Output = MemoryV1RecallOutput | MemoryV1EncodeOutput | MemoryV1ConsolidateOutput;

export const MEMORY_V1_ABI: EvoAbiDefinition<MemoryV1Input, MemoryV1Output, Record<string, never>> = {
	id: "memory/v1",
	surface: "memory",
	activationBoundary: "session",
	capabilityCeiling: ["infer", "memory-read", "memory-write", "retrieve"],
	validateConfig(value) {
		return validateEmptyConfig(value, "memory/v1 config");
	},
	validateInput(value) {
		const input = asRecord(jsonValue(value, "memory/v1 input"), "memory/v1 input");
		if (input.mode === "recall") {
			rejectUnknownKeys(input, ["mode", "query"], "memory/v1 recall input");
			requireNonEmptyString(input.query, "memory/v1 recall input.query");
			return input as unknown as MemoryV1RecallInput;
		}
		if (input.mode === "encode") {
			rejectUnknownKeys(input, ["mode", "turnDigest"], "memory/v1 encode input");
			asRecord(input.turnDigest, "memory/v1 encode input.turnDigest");
			return input as unknown as MemoryV1EncodeInput;
		}
		if (input.mode === "consolidate") {
			rejectUnknownKeys(input, ["mode", "candidates"], "memory/v1 consolidate input");
			requireJsonRecordArray(input.candidates, "memory/v1 consolidate input.candidates");
			return input as unknown as MemoryV1ConsolidateInput;
		}
		throw new Error("memory/v1 input.mode must be 'recall', 'encode', or 'consolidate'");
	},
	validateOutput(value) {
		const output = asRecord(jsonValue(value, "memory/v1 output"), "memory/v1 output");
		if (output.mode === "recall") {
			rejectUnknownKeys(output, ["mode", "fragments"], "memory/v1 recall output");
			requireJsonRecordArray(output.fragments, "memory/v1 recall output.fragments");
			return output as unknown as MemoryV1RecallOutput;
		}
		if (output.mode === "encode") {
			rejectUnknownKeys(output, ["mode", "writes", "updates", "forgets"], "memory/v1 encode output");
			requireJsonRecordArray(output.writes, "memory/v1 encode output.writes");
			requireJsonRecordArray(output.updates, "memory/v1 encode output.updates");
			requireStringArray(output.forgets, "memory/v1 encode output.forgets");
			return output as unknown as MemoryV1EncodeOutput;
		}
		if (output.mode === "consolidate") {
			rejectUnknownKeys(output, ["mode", "merged", "insights", "forget"], "memory/v1 consolidate output");
			requireJsonRecordArray(output.merged, "memory/v1 consolidate output.merged");
			requireJsonRecordArray(output.insights, "memory/v1 consolidate output.insights");
			requireStringArray(output.forget, "memory/v1 consolidate output.forget");
			return output as unknown as MemoryV1ConsolidateOutput;
		}
		throw new Error("memory/v1 output.mode must be 'recall', 'encode', or 'consolidate'");
	},
};

export interface WorkflowV1Host {
	/** Default provider/model route for spawned child agents. */
	model?: string;
	/** Tool names the spawn-agent grant allows. */
	tools?: string[];
	/** Per-call output token ceiling from the spawn-agent grant. */
	maxOutputTokensPerCall?: number;
}

export interface WorkflowV1Input {
	trigger: string;
	args: Record<string, unknown>;
	host?: WorkflowV1Host;
}

export interface WorkflowV1Output {
	result: unknown;
}

export const WORKFLOW_V1_ABI: EvoAbiDefinition<WorkflowV1Input, WorkflowV1Output, Record<string, never>> = {
	id: "workflow/v1",
	surface: "workflow",
	activationBoundary: "invocation",
	capabilityCeiling: ["memory-read", "memory-write", "spawn-agent"],
	validateConfig(value) {
		return validateEmptyConfig(value, "workflow/v1 config");
	},
	validateInput(value) {
		const input = asRecord(jsonValue(value, "workflow/v1 input"), "workflow/v1 input");
		rejectUnknownKeys(input, ["trigger", "args", "host"], "workflow/v1 input");
		requireNonEmptyString(input.trigger, "workflow/v1 input.trigger");
		asRecord(input.args, "workflow/v1 input.args");
		if (input.host !== undefined) {
			const host = asRecord(input.host, "workflow/v1 input.host");
			rejectUnknownKeys(host, ["model", "tools", "maxOutputTokensPerCall"], "workflow/v1 input.host");
			if (host.model !== undefined) requireNonEmptyString(host.model, "workflow/v1 input.host.model");
			if (host.tools !== undefined) requireStringArray(host.tools, "workflow/v1 input.host.tools");
			if (host.maxOutputTokensPerCall !== undefined) {
				if (!Number.isSafeInteger(host.maxOutputTokensPerCall) || (host.maxOutputTokensPerCall as number) <= 0) {
					throw new Error("workflow/v1 input.host.maxOutputTokensPerCall must be a positive safe integer");
				}
			}
		}
		return input as unknown as WorkflowV1Input;
	},
	validateOutput(value) {
		const output = asRecord(jsonValue(value, "workflow/v1 output"), "workflow/v1 output");
		rejectUnknownKeys(output, ["result"], "workflow/v1 output");
		if (!Object.hasOwn(output, "result")) throw new Error("workflow/v1 output.result is required");
		return { result: jsonValue(output.result, "workflow/v1 output.result") };
	},
};

export function createDefaultEvoAbiRegistry(): EvoAbiRegistry {
	const registry = new EvoAbiRegistry();
	registry.register(COMPACTION_V1_ABI);
	registry.register(CONTEXT_V1_ABI);
	registry.register(GUARD_V1_ABI);
	registry.register(INSTRUCTIONS_V1_ABI);
	registry.register(GENERATION_V1_ABI);
	registry.register(CONTROL_V1_ABI);
	registry.register(TOOL_V1_ABI);
	registry.register(MEMORY_V1_ABI);
	registry.register(WORKFLOW_V1_ABI);
	return registry;
}
