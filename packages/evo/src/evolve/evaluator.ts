import type { ThinkingLevel } from "@ch1nyzzz/pi-agent-core";
import { StringEnum } from "@ch1nyzzz/pi-ai";
import { Type } from "typebox";
import type { EvoPaths } from "../paths.ts";
import { attachProposalArtifact, proposalApproval } from "../proposal.ts";
import type { EvidenceCorpus } from "../reflect/evidence.ts";
import type { ModelRunner, ModelRunResult, ModelRunSubmission } from "../reflect/model-runner.ts";
import type { CounterfactualReplayResult } from "../reflect/replay.ts";
import { recordModelUsage } from "../reflect/usage.ts";
import type { EvolutionResearchPlan, Proposal } from "../types.ts";
import { readEvolutionWorkflow } from "./config.ts";
import type { MaterializedCorpus } from "./research-corpus.ts";

/** Read-only tool baseline for any role that receives the corpus index. */
const EVIDENCE_READER_TOOLS = ["read", "grep", "find", "ls"] as const;

const EVALUATION_VERDICTS = ["verified", "needs-evidence", "unsupported", "invalid"] as const;

export type EvolutionEvaluationVerdict = (typeof EVALUATION_VERDICTS)[number];

interface VerdictSubmission {
	verdict: EvolutionEvaluationVerdict;
	summary: string;
	findings: Array<{ title: string; detail: string }>;
}

/**
 * The verdict travels through a schema-validated tool call, never through text the
 * orchestrator would have to parse. Values outside the enum are unrepresentable.
 */
const VERDICT_SUBMISSION: Omit<ModelRunSubmission, "description"> = {
	toolName: "submit_verdict",
	parameters: Type.Object({
		verdict: StringEnum(EVALUATION_VERDICTS),
		summary: Type.String({ minLength: 1, maxLength: 4_000 }),
		findings: Type.Array(
			Type.Object({
				title: Type.String({ minLength: 1, maxLength: 200 }),
				detail: Type.String({ minLength: 1, maxLength: 4_000 }),
			}),
			{ maxItems: 20 },
		),
	}),
};

export interface EvolutionEvaluationResult {
	proposal: Proposal;
	verdict: EvolutionEvaluationVerdict;
	evaluation: ModelRunResult;
	adversarialReview: ModelRunResult;
	markdown: string;
}

function submittedVerdict(run: ModelRunResult): VerdictSubmission {
	return run.submission as VerdictSubmission;
}

function worst(left: EvolutionEvaluationVerdict, right: EvolutionEvaluationVerdict): EvolutionEvaluationVerdict {
	const rank: Record<EvolutionEvaluationVerdict, number> = {
		verified: 0,
		"needs-evidence": 1,
		unsupported: 2,
		invalid: 3,
	};
	return rank[left] >= rank[right] ? left : right;
}

function renderPassMarkdown(run: ModelRunResult): string {
	const { verdict, summary, findings } = submittedVerdict(run);
	return [
		`Verdict: ${verdict}`,
		"",
		summary.trim(),
		...(findings.length > 0 ? ["", ...findings.map((finding) => `- **${finding.title}**: ${finding.detail}`)] : []),
		...(run.text.trim() ? ["", run.text.trim()] : []),
	].join("\n");
}

export async function runEvolutionEvaluator(options: {
	paths: EvoPaths;
	plan: EvolutionResearchPlan;
	proposal: Proposal;
	corpus: Pick<EvidenceCorpus, "text" | "truncated">;
	/** On-disk corpus tree; when present the prompt carries only its index. */
	materializedCorpus?: MaterializedCorpus;
	replay?: CounterfactualReplayResult;
	/**
	 * Recommended (non-required) evidence profiles the harness deferred to an
	 * explicit user decision. Their absence bounds claims but is not a defect.
	 */
	deferredProfiles?: readonly string[];
	runner: ModelRunner;
	cwd: string;
	agentDir?: string;
	model: string;
	thinkingLevel?: ThinkingLevel;
	activePreferences?: string;
	/**
	 * Proposal review artifacts are immutable per revision; re-evaluations (evidence
	 * resumption) keep their markdown in the run directory instead. Default true.
	 */
	attachArtifact?: boolean;
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
		...(options.materializedCorpus
			? [
					`<evidence_corpus_index truncated="${String(options.corpus.truncated)}">`,
					options.materializedCorpus.indexText,
					"</evidence_corpus_index>",
				]
			: [
					`<evidence_corpus truncated="${String(options.corpus.truncated)}">`,
					options.corpus.text,
					"</evidence_corpus>",
				]),
		...(options.replay ? ["", "<paired_replay>", options.replay.markdown, "</paired_replay>"] : []),
		...(options.deferredProfiles && options.deferredProfiles.length > 0
			? [
					"",
					"<deferred_recommended_evidence>",
					`The frozen plan marks these evidence profiles as recommended, not required: ${options.deferredProfiles.join(", ")}. The harness deferred their execution to an explicit user decision that happens after this evaluation. Their absence is not a candidate or experiment defect and must not lower the verdict on its own; state instead which claims remain unproven without them.`,
					"</deferred_recommended_evidence>",
				]
			: []),
	].join("\n");
	const common = {
		cwd: options.cwd,
		...(options.agentDir ? { agentDir: options.agentDir } : {}),
		model: options.model,
		thinkingLevel: options.thinkingLevel ?? ("xhigh" as const),
		// Index mode requires read access so the evaluator can verify cited evidence itself.
		...(options.materializedCorpus ? { tools: [...EVIDENCE_READER_TOOLS] } : {}),
		...(options.signal ? { signal: options.signal } : {}),
	};
	const evaluation = await options.runner.run({
		...common,
		systemPrompt:
			"You are Evo-Pi's independent Evaluator. Evaluate the candidate only against the frozen experiment and supplied primary evidence. You cannot modify or activate it.",
		prompt: [
			"Assess deterministic validation, the frozen evidenceStrategy, the stated metrics and minimum effects, replay limitations, evidence sufficiency, compliance with active user preferences, and whether shadow or Canary execution is required. Treat a required evidence profile as unexecuted unless a supplied artifact demonstrates that exact execution boundary. Active preferences are evaluation criteria, never permission to weaken release or safety checks. A valid candidate that still requires replay, shadow, canary, provider, or minimum-sample evidence is needs-evidence, not unsupported. Use unsupported only when sufficient executed comparative evidence disproves the frozen thresholds; use invalid for a broken candidate or experiment. A content-addressed component is represented by a data proposal selecting its targetAbi artifact, which is not a kind mismatch. Do not claim unexecuted behavior. Deliver your assessment by calling the submit_verdict tool exactly once.",
			"",
			evidence,
		].join("\n"),
		submission: {
			...VERDICT_SUBMISSION,
			description: "Deliver the final evaluation verdict with a summary and concrete findings.",
		},
	});
	await recordModelUsage(options.paths, "evaluator", evaluation);
	const adversarialReview = await options.runner.run({
		...common,
		systemPrompt:
			"You are Evo-Pi's adversarial evaluation pass in a fresh context. Try to falsify the candidate's apparent benefit. You cannot modify or activate it.",
		prompt: [
			"Look for tailored tests, baseline mismatch, changed task mix, overfitting, hidden regressions, new capability or complexity, unjustified not-applicable evidence classifications, invalid research citations, and overclaims from generate-only replay. Missing required future trial evidence is needs-evidence; reserve unsupported for sufficient negative evidence and invalid for a broken candidate or experiment. Deliver your assessment by calling the submit_verdict tool exactly once.",
			"",
			evidence,
		].join("\n"),
		submission: {
			...VERDICT_SUBMISSION,
			description: "Deliver the adversarial review verdict with a summary and concrete findings.",
		},
	});
	await recordModelUsage(options.paths, "adversarial-review", adversarialReview);
	const finalVerdict = worst(submittedVerdict(evaluation).verdict, submittedVerdict(adversarialReview).verdict);
	const markdown = [
		"# Evolution evaluation",
		"",
		"## Evaluation",
		"",
		renderPassMarkdown(evaluation),
		"",
		"## Adversarial review",
		"",
		renderPassMarkdown(adversarialReview),
		"",
		`## Combined verdict: ${finalVerdict}`,
		"",
	].join("\n");
	const proposal =
		options.attachArtifact === false
			? options.proposal
			: await attachProposalArtifact({
					paths: options.paths,
					proposalId: options.proposal.id,
					expected: proposalApproval(options.proposal),
					kind: "review",
					content: markdown,
					allowedStatuses: ["pending", "deferred"],
				});
	return { proposal, verdict: finalVerdict, evaluation, adversarialReview, markdown };
}
