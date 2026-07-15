import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvoPaths } from "../paths.ts";
import { appendJsonLine, truncateIncompleteFinalLine, withFileLock } from "../storage.ts";
import type { ModelRunResult } from "./model-runner.ts";

export const MODEL_USAGE_PHASES = [
	"reflector",
	"research-plan",
	"builder",
	"evaluator",
	"adversarial-review",
	"report",
	"critic",
	"replay-old",
	"replay-candidate",
	"permit",
	"retrospective",
] as const;

export type ModelUsagePhase = (typeof MODEL_USAGE_PHASES)[number];

export interface ModelUsageTokens {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

export interface ModelUsageRecord {
	schemaVersion: 1;
	timestamp: string;
	phase: ModelUsagePhase;
	model: {
		provider: string;
		id: string;
	};
	sessionId: string;
	tokens: ModelUsageTokens;
	cost: number;
}

export interface ModelUsageTotals {
	runs: number;
	tokens: ModelUsageTokens;
	cost: number;
}

export interface ModelUsageSummary extends ModelUsageTotals {
	since: string;
	until: string;
	byPhase: Partial<Record<ModelUsagePhase, ModelUsageTotals>>;
}

export interface RecordModelUsageOptions {
	now?: () => Date;
}

export interface SummarizeModelUsageOptions {
	since: Date;
	until?: Date;
}

const MODEL_USAGE_PHASE_SET = new Set<ModelUsagePhase>(MODEL_USAGE_PHASES);

function journalPath(paths: EvoPaths): string {
	return join(paths.reports, "model-usage.jsonl");
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${label} must be a non-negative safe integer`);
	}
	return value;
}

function nonNegativeFiniteNumber(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(`${label} must be a non-negative finite number`);
	}
	return value;
}

function nonEmptyString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value || value.length > 500) {
		throw new Error(`${label} must be a non-empty string of at most 500 characters`);
	}
	return value;
}

function parseTokens(value: unknown, label: string): ModelUsageTokens {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	const record = value as Record<string, unknown>;
	return {
		input: nonNegativeSafeInteger(record.input, `${label}.input`),
		output: nonNegativeSafeInteger(record.output, `${label}.output`),
		cacheRead: nonNegativeSafeInteger(record.cacheRead, `${label}.cacheRead`),
		cacheWrite: nonNegativeSafeInteger(record.cacheWrite, `${label}.cacheWrite`),
		total: nonNegativeSafeInteger(record.total, `${label}.total`),
	};
}

function parseModelUsageRecord(value: unknown, line: number): ModelUsageRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`Model usage journal line ${line} must be an object`);
	}
	const record = value as Record<string, unknown>;
	if (record.schemaVersion !== 1) throw new Error(`Model usage journal line ${line} has an invalid schema version`);
	if (typeof record.timestamp !== "string" || !Number.isFinite(Date.parse(record.timestamp))) {
		throw new Error(`Model usage journal line ${line} has an invalid timestamp`);
	}
	if (typeof record.phase !== "string" || !MODEL_USAGE_PHASE_SET.has(record.phase as ModelUsagePhase)) {
		throw new Error(`Model usage journal line ${line} has an invalid phase`);
	}
	if (typeof record.model !== "object" || record.model === null || Array.isArray(record.model)) {
		throw new Error(`Model usage journal line ${line} has an invalid model`);
	}
	const model = record.model as Record<string, unknown>;
	return {
		schemaVersion: 1,
		timestamp: record.timestamp,
		phase: record.phase as ModelUsagePhase,
		model: {
			provider: nonEmptyString(model.provider, `Model usage journal line ${line} model.provider`),
			id: nonEmptyString(model.id, `Model usage journal line ${line} model.id`),
		},
		sessionId: nonEmptyString(record.sessionId, `Model usage journal line ${line} sessionId`),
		tokens: parseTokens(record.tokens, `Model usage journal line ${line} tokens`),
		cost: nonNegativeFiniteNumber(record.cost, `Model usage journal line ${line} cost`),
	};
}

async function readRecordsUnlocked(paths: EvoPaths): Promise<ModelUsageRecord[]> {
	await truncateIncompleteFinalLine(journalPath(paths));
	let content: string;
	try {
		content = await readFile(journalPath(paths), "utf8");
	} catch (error) {
		if (errorCode(error) === "ENOENT") return [];
		throw error;
	}
	if (!content) return [];
	if (!content.endsWith("\n")) throw new Error("Model usage journal has an incomplete final line");
	return content
		.slice(0, -1)
		.split("\n")
		.map((line, index) => {
			if (!line) throw new Error(`Model usage journal line ${index + 1} is empty`);
			let value: unknown;
			try {
				value = JSON.parse(line);
			} catch {
				throw new Error(`Model usage journal line ${index + 1} is invalid JSON`);
			}
			return parseModelUsageRecord(value, index + 1);
		});
}

export async function readModelUsageRecords(paths: EvoPaths): Promise<ModelUsageRecord[]> {
	return withFileLock(paths, "model-usage", () => readRecordsUnlocked(paths));
}

export async function recordModelUsage(
	paths: EvoPaths,
	phase: ModelUsagePhase,
	run: ModelRunResult,
	options: RecordModelUsageOptions = {},
): Promise<ModelUsageRecord> {
	if (!MODEL_USAGE_PHASE_SET.has(phase)) throw new Error(`Unsupported model usage phase: ${phase}`);
	const record = parseModelUsageRecord(
		{
			schemaVersion: 1,
			timestamp: (options.now?.() ?? new Date()).toISOString(),
			phase,
			model: run.model,
			sessionId: run.stats.sessionId,
			tokens: run.stats.tokens,
			cost: run.stats.cost,
		},
		1,
	);
	return withFileLock(paths, "model-usage", async () => {
		await readRecordsUnlocked(paths);
		await appendJsonLine(journalPath(paths), record);
		return record;
	});
}

function emptyTotals(): ModelUsageTotals {
	return {
		runs: 0,
		tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		cost: 0,
	};
}

function addRecord(totals: ModelUsageTotals, record: ModelUsageRecord): void {
	totals.runs += 1;
	totals.tokens.input += record.tokens.input;
	totals.tokens.output += record.tokens.output;
	totals.tokens.cacheRead += record.tokens.cacheRead;
	totals.tokens.cacheWrite += record.tokens.cacheWrite;
	totals.tokens.total += record.tokens.total;
	totals.cost += record.cost;
}

export async function summarizeModelUsage(
	paths: EvoPaths,
	options: SummarizeModelUsageOptions,
): Promise<ModelUsageSummary> {
	const until = options.until ?? new Date();
	const sinceMs = options.since.getTime();
	const untilMs = until.getTime();
	if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs) || sinceMs > untilMs) {
		throw new Error("Model usage summary window is invalid");
	}
	const summary: ModelUsageSummary = {
		...emptyTotals(),
		since: options.since.toISOString(),
		until: until.toISOString(),
		byPhase: {},
	};
	for (const record of await readModelUsageRecords(paths)) {
		const timestamp = Date.parse(record.timestamp);
		if (timestamp < sinceMs || timestamp > untilMs) continue;
		addRecord(summary, record);
		const phaseTotals = summary.byPhase[record.phase] ?? emptyTotals();
		addRecord(phaseTotals, record);
		summary.byPhase[record.phase] = phaseTotals;
	}
	return summary;
}

export function renderModelUsageSummary(summary: ModelUsageSummary): string {
	const rows = MODEL_USAGE_PHASES.flatMap((phase) => {
		const totals = summary.byPhase[phase];
		return totals
			? [
					`| ${phase} | ${totals.runs} | ${totals.tokens.input} | ${totals.tokens.output} | ${totals.tokens.cacheRead} | ${totals.tokens.cacheWrite} | ${totals.tokens.total} | $${totals.cost.toFixed(6)} |`,
				]
			: [];
	});
	return [
		"## Background model usage",
		"",
		`Window: ${summary.since} through ${summary.until}`,
		"",
		"| Phase | Runs | Input | Output | Cache read | Cache write | Total | Cost |",
		"|---|---:|---:|---:|---:|---:|---:|---:|",
		...rows,
		`| **Total** | **${summary.runs}** | **${summary.tokens.input}** | **${summary.tokens.output}** | **${summary.tokens.cacheRead}** | **${summary.tokens.cacheWrite}** | **${summary.tokens.total}** | **$${summary.cost.toFixed(6)}** |`,
		"",
	].join("\n");
}
