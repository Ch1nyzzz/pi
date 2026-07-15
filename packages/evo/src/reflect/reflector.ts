import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ThinkingLevel } from "@ch1nyzzz/pi-agent-core";
import { loadCompiledBundle } from "../bundle/compile.ts";
import type { EvoPaths } from "../paths.ts";
import { parseReflectorOutput } from "../proposal.ts";
import { BundleRegistry } from "../registry/registry.ts";
import { atomicWriteFile } from "../storage.ts";
import type { EvidenceReference } from "../types.ts";
import {
	collectEvidenceCorpus,
	type EvidenceCorpus,
	readEvidenceReviewCursor,
	validateEvidenceReferences,
} from "./evidence.ts";
import type { ModelRunner, ModelRunResult } from "./model-runner.ts";
import { recordModelUsage, renderModelUsageSummary, summarizeModelUsage } from "./usage.ts";

const REFLECTOR_PROMPT_URL = new URL("../prompts/reflector.md", import.meta.url);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface RunReportOptions {
	paths: EvoPaths;
	runner: ModelRunner;
	cwd?: string;
	agentDir?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	maxCorpusBytes?: number;
	window?: "since-last-improve" | "full";
}

export interface ReportRunResult {
	observationsMarkdown: string;
	observationEvidence: EvidenceReference[];
	proposals: [];
	file: string;
	corpus: EvidenceCorpus;
	run: ModelRunResult;
}

function corpusPrompt(corpus: EvidenceCorpus, instruction: string): string {
	return [
		instruction,
		`Corpus bytes: ${corpus.bytes}/${corpus.maxBytes}; truncated: ${String(corpus.truncated)}.`,
		`Evidence window: ${corpus.mode === "incremental" ? "new inbox and session evidence since the last successful review, plus current bundle and history context" : "full available evidence"}.`,
		"",
		"<evidence_corpus>",
		corpus.text,
		"</evidence_corpus>",
	].join("\n");
}

async function groundObservationEvidence(
	paths: EvoPaths,
	corpus: EvidenceCorpus,
	references: readonly EvidenceReference[],
): Promise<EvidenceReference[]> {
	if (corpus.sessionIds.length > 0 && references.length === 0) {
		throw new Error("Reflector observations must cite recorded session evidence");
	}
	return validateEvidenceReferences(paths, references);
}

async function writeObservationsFile(options: {
	paths: EvoPaths;
	prefix: "observations" | "report";
	observationsMarkdown: string;
	observationEvidence: readonly EvidenceReference[];
	corpus: EvidenceCorpus;
}): Promise<string> {
	const file = join(
		options.paths.reports,
		`${options.prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.md`,
	);
	await atomicWriteFile(
		file,
		[
			options.observationsMarkdown.trim(),
			"",
			"## Evidence",
			"",
			...(options.observationEvidence.length > 0
				? options.observationEvidence.map((reference) => `- ${reference.sessionId}:${reference.sequence}`)
				: ["- No recorded session evidence was available."]),
			"",
			"## Evidence corpus",
			"",
			`- Digest: ${options.corpus.evidenceDigest}`,
			`- Mode: ${options.corpus.mode}`,
			`- Truncated: ${String(options.corpus.truncated)}`,
			"",
		].join("\n"),
	);
	return file;
}

export async function runReport(options: RunReportOptions): Promise<ReportRunResult> {
	const registry = new BundleRegistry(options.paths);
	const stableDigest = await registry.readStableDigest();
	const stableBundle = stableDigest ? await loadCompiledBundle(options.paths, stableDigest) : undefined;
	const reflectorModel = options.model ?? stableBundle?.policy.modelRouting?.reflector;
	// Reports default to the evidence recorded since the last successful improve
	// run (the review cursor is read but never advanced), so the report window
	// matches the configured reflection cadence instead of all recorded history.
	const window = options.window ?? "since-last-improve";
	const reviewCursor = window === "since-last-improve" ? await readEvidenceReviewCursor(options.paths) : undefined;
	const corpus = await collectEvidenceCorpus(options.paths, {
		maxBytes: options.maxCorpusBytes,
		mode: window === "since-last-improve" ? "incremental" : "full",
		...(reviewCursor ? { reviewCursor } : {}),
	});
	const rolePrompt = `${await readFile(REFLECTOR_PROMPT_URL, "utf8")}\n\nREPORT MODE: proposals must be an empty array. Write observationsMarkdown plus its observationEvidence citations; do not suggest or stage changes.`;
	const run = await options.runner.run({
		cwd: options.cwd ?? process.cwd(),
		...(options.agentDir ? { agentDir: options.agentDir } : {}),
		systemPrompt: rolePrompt,
		prompt: corpusPrompt(corpus, "Summarize the recorded work and recurring issues without proposing changes."),
		...(reflectorModel ? { model: reflectorModel } : {}),
		...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
	});
	await recordModelUsage(options.paths, "report", run);
	const output = parseReflectorOutput(run.text);
	const observationEvidence = await groundObservationEvidence(options.paths, corpus, output.observationEvidence);
	const now = new Date();
	const usage = await summarizeModelUsage(options.paths, {
		since: new Date(now.getTime() - WEEK_MS),
		until: now,
	});
	const observationsMarkdown = [output.observationsMarkdown.trim(), "", renderModelUsageSummary(usage).trim()].join(
		"\n",
	);
	const file = await writeObservationsFile({
		paths: options.paths,
		prefix: "report",
		observationsMarkdown,
		observationEvidence,
		corpus,
	});
	return { observationsMarkdown, observationEvidence, proposals: [], file, corpus, run };
}
