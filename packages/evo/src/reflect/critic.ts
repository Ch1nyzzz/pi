import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { EvoPaths } from "../paths.ts";
import { saveProposal } from "../proposal.ts";
import { atomicWriteFile } from "../storage.ts";
import type { Proposal } from "../types.ts";
import type { EvidenceCorpus } from "./evidence.ts";
import type { ModelRunner, ModelRunResult } from "./model-runner.ts";
import type { CounterfactualReplayResult } from "./replay.ts";

const CRITIC_PROMPT_URL = new URL("../prompts/critic.md", import.meta.url);

export interface RunCriticOptions {
	paths: EvoPaths;
	runner: ModelRunner;
	proposal: Proposal;
	corpus: EvidenceCorpus;
	replay?: CounterfactualReplayResult;
	cwd?: string;
	agentDir?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

export interface CriticReviewResult {
	proposal: Proposal;
	reviewMarkdown: string;
	run: ModelRunResult;
}

export async function runCritic(options: RunCriticOptions): Promise<CriticReviewResult> {
	const prompt = [
		"Review this proposal against the supplied primary evidence.",
		"",
		"<proposal>",
		JSON.stringify(options.proposal, undefined, "\t"),
		"</proposal>",
		"",
		`<evidence_corpus truncated="${String(options.corpus.truncated)}">`,
		options.corpus.text,
		"</evidence_corpus>",
		...(options.replay ? ["", "<counterfactual_replay>", options.replay.markdown, "</counterfactual_replay>"] : []),
	].join("\n");
	const run = await options.runner.run({
		cwd: options.cwd ?? process.cwd(),
		...(options.agentDir ? { agentDir: options.agentDir } : {}),
		systemPrompt: await readFile(CRITIC_PROMPT_URL, "utf8"),
		prompt,
		...(options.model ? { model: options.model } : {}),
		thinkingLevel: options.thinkingLevel ?? "low",
	});
	const reviewMarkdown = `${run.text.trim()}\n`;
	await atomicWriteFile(join(options.paths.proposals, options.proposal.id, "review.md"), reviewMarkdown);
	options.proposal.reviewFile = "review.md";
	await saveProposal(options.paths, options.proposal);
	return { proposal: options.proposal, reviewMarkdown, run };
}
