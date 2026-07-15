import { canonicalJson } from "../storage.ts";
import type { EvoComponentSelection } from "../types.ts";
import { assertEvoAbiId, assertEvoCapability, assertEvoComponentId } from "./manifest.ts";

export interface EvoAbiDefinition<TInput = unknown, TOutput = unknown, TConfig = unknown> {
	id: string;
	surface: string;
	activationBoundary: "turn" | "session" | "process";
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

export function createDefaultEvoAbiRegistry(): EvoAbiRegistry {
	const registry = new EvoAbiRegistry();
	registry.register(COMPACTION_V1_ABI);
	return registry;
}
