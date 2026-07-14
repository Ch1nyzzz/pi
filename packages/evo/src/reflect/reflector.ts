import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { loadCompiledBundle } from "../bundle/compile.ts";
import type { EvoPaths } from "../paths.ts";
import { type DraftProposal, parseReflectorOutput, stageProposal } from "../proposal.ts";
import { BundleRegistry } from "../registry/registry.ts";
import { atomicWriteFile } from "../storage.ts";
import type { Proposal } from "../types.ts";
import { runCritic } from "./critic.ts";
import { collectEvidenceCorpus, type EvidenceCorpus, validateDraftGrounding } from "./evidence.ts";
import type { ModelRunner, ModelRunResult } from "./model-runner.ts";
import { type CounterfactualReplayResult, runCounterfactualReplay } from "./replay.ts";

const REFLECTOR_PROMPT_URL = new URL("../prompts/reflector.md", import.meta.url);

export interface RunReflectorOptions {
	paths: EvoPaths;
	runner: ModelRunner;
	cwd?: string;
	agentDir?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	criticModel?: string;
	criticThinkingLevel?: ThinkingLevel;
	replayModel?: string;
	replayThinkingLevel?: ThinkingLevel;
	maxCorpusBytes?: number;
}

export interface ReflectorRunResult {
	observationsMarkdown: string;
	proposals: Proposal[];
	corpus: EvidenceCorpus;
	run: ModelRunResult;
}

export interface RunReportOptions {
	paths: EvoPaths;
	runner: ModelRunner;
	cwd?: string;
	agentDir?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	maxCorpusBytes?: number;
}

export interface ReportRunResult {
	observationsMarkdown: string;
	proposals: [];
	file: string;
	corpus: EvidenceCorpus;
	run: ModelRunResult;
}

function corpusPrompt(corpus: EvidenceCorpus, instruction: string): string {
	return [
		instruction,
		`Corpus bytes: ${corpus.bytes}/${corpus.maxBytes}; truncated: ${String(corpus.truncated)}.`,
		"",
		"<evidence_corpus>",
		corpus.text,
		"</evidence_corpus>",
	].join("\n");
}

export async function runReflector(options: RunReflectorOptions): Promise<ReflectorRunResult> {
	const registry = new BundleRegistry(options.paths);
	if (await registry.isPaused()) throw new Error("Evo-Pi is paused");
	const stableDigest = await registry.readStableDigest();
	if (!stableDigest) throw new Error("Evo-Pi registry is not initialized");
	const stableBundle = await loadCompiledBundle(options.paths, stableDigest);
	const reflectorModel = options.model ?? stableBundle.policy.modelRouting?.reflector;
	const criticModel = options.criticModel ?? stableBundle.policy.modelRouting?.critic;
	const replayModel = options.replayModel;
	const corpus = await collectEvidenceCorpus(options.paths, { maxBytes: options.maxCorpusBytes });
	const run = await options.runner.run({
		cwd: options.cwd ?? process.cwd(),
		...(options.agentDir ? { agentDir: options.agentDir } : {}),
		systemPrompt: await readFile(REFLECTOR_PROMPT_URL, "utf8"),
		prompt: corpusPrompt(corpus, "Reflect on this corpus and return the required grounded JSON object."),
		...(reflectorModel ? { model: reflectorModel } : {}),
		...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
	});
	const output = parseReflectorOutput(run.text);
	if (output.proposals.length > 2) throw new Error("Reflector returned more than two proposals");

	const groundedDrafts: DraftProposal[] = [];
	for (const draft of output.proposals) {
		groundedDrafts.push({ ...draft, evidence: await validateDraftGrounding(options.paths, draft) });
	}

	const proposals: Proposal[] = [];
	for (const draft of groundedDrafts) {
		let proposal = await stageProposal({
			paths: options.paths,
			parentDigest: stableDigest,
			draft,
			observationsMarkdown: output.observationsMarkdown,
		});
		let replay: CounterfactualReplayResult | undefined;
		if (proposal.tier === "T2" && proposal.kind === "data") {
			if (!proposal.replayScenarios[0]) {
				throw new Error(`T2 data proposal ${proposal.id} requires a replay scenario`);
			}
			replay = await runCounterfactualReplay({
				paths: options.paths,
				runner: options.runner,
				proposal,
				...(options.agentDir ? { agentDir: options.agentDir } : {}),
				...(replayModel ? { model: replayModel } : {}),
				...(options.replayThinkingLevel ? { thinkingLevel: options.replayThinkingLevel } : {}),
			});
		}
		if (proposal.tier === "T1" || proposal.tier === "T2") {
			proposal = (
				await runCritic({
					paths: options.paths,
					runner: options.runner,
					proposal,
					corpus,
					...(replay ? { replay } : {}),
					...(options.cwd ? { cwd: options.cwd } : {}),
					...(options.agentDir ? { agentDir: options.agentDir } : {}),
					...(criticModel ? { model: criticModel } : {}),
					...(options.criticThinkingLevel ? { thinkingLevel: options.criticThinkingLevel } : {}),
				})
			).proposal;
		}
		proposals.push(proposal);
	}
	return { observationsMarkdown: output.observationsMarkdown, proposals, corpus, run };
}

export async function runReport(options: RunReportOptions): Promise<ReportRunResult> {
	const registry = new BundleRegistry(options.paths);
	const stableDigest = await registry.readStableDigest();
	const stableBundle = stableDigest ? await loadCompiledBundle(options.paths, stableDigest) : undefined;
	const reflectorModel = options.model ?? stableBundle?.policy.modelRouting?.reflector;
	const corpus = await collectEvidenceCorpus(options.paths, { maxBytes: options.maxCorpusBytes });
	const rolePrompt = `${await readFile(REFLECTOR_PROMPT_URL, "utf8")}\n\nREPORT MODE: proposals must be an empty array. Write observationsMarkdown only; do not suggest or stage changes.`;
	const run = await options.runner.run({
		cwd: options.cwd ?? process.cwd(),
		...(options.agentDir ? { agentDir: options.agentDir } : {}),
		systemPrompt: rolePrompt,
		prompt: corpusPrompt(corpus, "Summarize the recorded work and recurring issues without proposing changes."),
		...(reflectorModel ? { model: reflectorModel } : {}),
		...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
	});
	const output = parseReflectorOutput(run.text);
	const observationsMarkdown = output.observationsMarkdown.trim();
	const file = join(
		options.paths.reports,
		`report-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.md`,
	);
	await atomicWriteFile(file, `${observationsMarkdown}\n`);
	return { observationsMarkdown, proposals: [], file, corpus, run };
}
