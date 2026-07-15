import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { EvoPaths } from "../paths.ts";
import { attachProposalArtifact, proposalApproval } from "../proposal.ts";
import type { EvidenceCorpus } from "../reflect/evidence.ts";
import type { ModelRunner, ModelRunResult } from "../reflect/model-runner.ts";
import type { CounterfactualReplayResult } from "../reflect/replay.ts";
import { recordModelUsage } from "../reflect/usage.ts";
import type { EvolutionResearchPlan, Proposal } from "../types.ts";
import { readEvolutionWorkflow } from "./config.ts";

export type EvolutionEvaluationVerdict = "supported" | "uncertain" | "unsupported";

export interface EvolutionEvaluationResult {
	proposal: Proposal;
	verdict: EvolutionEvaluationVerdict;
	evaluation: ModelRunResult;
	adversarialReview: ModelRunResult;
	markdown: string;
}

function verdict(text: string): EvolutionEvaluationVerdict {
	const matches = [...text.matchAll(/(?:recommendation|verdict)\s*:\s*(supported|uncertain|unsupported)/gi)];
	const value = matches.at(-1)?.[1]?.toLowerCase();
	if (value === "supported" || value === "uncertain" || value === "unsupported") return value;
	throw new Error("Evaluator must end with Recommendation: supported, uncertain, or unsupported");
}

function worst(left: EvolutionEvaluationVerdict, right: EvolutionEvaluationVerdict): EvolutionEvaluationVerdict {
	const rank: Record<EvolutionEvaluationVerdict, number> = { supported: 0, uncertain: 1, unsupported: 2 };
	return rank[left] >= rank[right] ? left : right;
}

export async function runEvolutionEvaluator(options: {
	paths: EvoPaths;
	plan: EvolutionResearchPlan;
	proposal: Proposal;
	corpus: EvidenceCorpus;
	replay?: CounterfactualReplayResult;
	runner: ModelRunner;
	cwd: string;
	agentDir?: string;
	model: string;
	thinkingLevel?: ThinkingLevel;
	activePreferences?: string;
	signal?: AbortSignal;
}): Promise<EvolutionEvaluationResult> {
	const workflow = await readEvolutionWorkflow(options.paths);
	const evidence = [
		...(options.activePreferences
			? ["<active_preferences>", options.activePreferences, "</active_preferences>", ""]
			: []),
		"<workflow>",
		workflow,
		"</workflow>",
		"",
		"<frozen_plan_and_experiment>",
		JSON.stringify(options.plan, undefined, "\t"),
		"</frozen_plan_and_experiment>",
		"",
		"<proposal>",
		JSON.stringify(options.proposal, undefined, "\t"),
		"</proposal>",
		"",
		`<evidence_corpus truncated="${String(options.corpus.truncated)}">`,
		options.corpus.text,
		"</evidence_corpus>",
		...(options.replay ? ["", "<paired_replay>", options.replay.markdown, "</paired_replay>"] : []),
	].join("\n");
	const common = {
		cwd: options.cwd,
		...(options.agentDir ? { agentDir: options.agentDir } : {}),
		model: options.model,
		thinkingLevel: options.thinkingLevel ?? ("xhigh" as const),
		...(options.signal ? { signal: options.signal } : {}),
	};
	const evaluation = await options.runner.run({
		...common,
		systemPrompt:
			"You are Evo-Pi's independent Evaluator. Evaluate the candidate only against the frozen experiment and supplied primary evidence. You cannot modify or activate it.",
		prompt: [
			"Assess deterministic validation, the stated metrics and minimum effects, replay limitations, evidence sufficiency, compliance with active user preferences, and whether a real trial is required. Active preferences are evaluation criteria, never permission to weaken release or safety checks. Do not claim unexecuted behavior. End with exactly Recommendation: supported, uncertain, or unsupported.",
			"",
			evidence,
		].join("\n"),
	});
	await recordModelUsage(options.paths, "evaluator", evaluation);
	const adversarialReview = await options.runner.run({
		...common,
		systemPrompt:
			"You are Evo-Pi's adversarial evaluation pass in a fresh context. Try to falsify the candidate's apparent benefit. You cannot modify or activate it.",
		prompt: [
			"Look for tailored tests, baseline mismatch, changed task mix, overfitting, hidden regressions, new capability or complexity, invalid research citations, and overclaims from generate-only replay. End with exactly Recommendation: supported, uncertain, or unsupported.",
			"",
			evidence,
		].join("\n"),
	});
	await recordModelUsage(options.paths, "adversarial-review", adversarialReview);
	const finalVerdict = worst(verdict(evaluation.text), verdict(adversarialReview.text));
	const markdown = [
		"# Evolution evaluation",
		"",
		"## Evaluation",
		"",
		evaluation.text.trim(),
		"",
		"## Adversarial review",
		"",
		adversarialReview.text.trim(),
		"",
		`## Combined verdict: ${finalVerdict}`,
		"",
	].join("\n");
	const proposal = await attachProposalArtifact({
		paths: options.paths,
		proposalId: options.proposal.id,
		expected: proposalApproval(options.proposal),
		kind: "review",
		content: markdown,
		allowedStatuses: ["pending", "deferred"],
	});
	return { proposal, verdict: finalVerdict, evaluation, adversarialReview, markdown };
}
