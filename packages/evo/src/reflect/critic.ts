import { readFile } from "node:fs/promises";
import type { ThinkingLevel } from "@ch1nyzzz/pi-agent-core";
import type { EvoPaths } from "../paths.ts";
import { attachProposalArtifact, proposalApproval } from "../proposal.ts";
import type { Proposal } from "../types.ts";
import type { EvidenceCorpus } from "./evidence.ts";
import type { ModelRunner, ModelRunResult } from "./model-runner.ts";
import type { CounterfactualReplayResult } from "./replay.ts";
import { recordModelUsage } from "./usage.ts";

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
	signal?: AbortSignal;
}

export interface CriticReviewResult {
	proposal: Proposal;
	reviewMarkdown: string;
	run: ModelRunResult;
}

export async function runCritic(options: RunCriticOptions): Promise<CriticReviewResult> {
	const prompt = [
		"Review this proposal against the supplied primary evidence.",
		...(options.replay?.mode === "code-patch-hypothesis"
			? [
					"",
					"The code replay candidate is a hypothetical model prediction conditioned on the patch. No candidate code, runtime, or tool was loaded or executed; do not report it as observed patched-agent behavior.",
				]
			: []),
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
		...(options.signal ? { signal: options.signal } : {}),
	});
	await recordModelUsage(options.paths, "critic", run);
	const reviewMarkdown = `${run.text.trim()}\n`;
	const proposal = await attachProposalArtifact({
		paths: options.paths,
		proposalId: options.proposal.id,
		expected: proposalApproval(options.proposal),
		kind: "review",
		content: reviewMarkdown,
		allowedStatuses: ["pending", "deferred"],
	});
	return { proposal, reviewMarkdown, run };
}
