import { readFile } from "node:fs/promises";
import type { ThinkingLevel } from "@ch1nyzzz/pi-agent-core";
import { StringEnum } from "@ch1nyzzz/pi-ai";
import { Type } from "typebox";
import { loadCompiledBundle } from "../bundle/compile.ts";
import { storeTrialComparison, type TrialComparison, trialEvidenceDigest } from "../comparison.ts";
import type { EvoPaths } from "../paths.ts";
import { attachRetrospectiveArtifact, loadProposal, proposalApproval } from "../proposal.ts";
import { readEvaluationArtifact } from "../proposal-artifacts.ts";
import { BundleRegistry } from "../registry/registry.ts";
import { withFileLock } from "../storage.ts";
import type { Proposal, TrialState } from "../types.ts";
import { collectEvidenceCorpus, type EvidenceCorpus } from "./evidence.ts";
import type { ModelRunner, ModelRunResult } from "./model-runner.ts";
import { recordModelUsage } from "./usage.ts";

const RETROSPECTIVE_PROMPT_URL = new URL("../prompts/retrospective.md", import.meta.url);

export interface RunRetrospectiveOptions {
	paths: EvoPaths;
	runner: ModelRunner;
	cwd?: string;
	agentDir?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	maxCorpusBytes?: number;
}

export type TrialRecommendation = "keep" | "rollback" | "extend";

function parseTrialRecommendation(markdown: string): TrialRecommendation | undefined {
	const matches = [...markdown.matchAll(/^Recommendation:\s*(keep|rollback|extend)\s*$/gim)];
	const value = matches.at(-1)?.[1]?.toLowerCase();
	return value === "keep" || value === "rollback" || value === "extend" ? value : undefined;
}

export interface RetrospectiveRunResult {
	proposal: Proposal;
	trial: TrialState;
	corpus: EvidenceCorpus;
	comparison: TrialComparison;
	retrospectiveMarkdown: string;
	recommendation?: TrialRecommendation;
	reused: boolean;
	run?: ModelRunResult;
}

export async function runRetrospective(options: RunRetrospectiveOptions): Promise<RetrospectiveRunResult> {
	const registry = new BundleRegistry(options.paths);
	const initialTrial = await registry.readTrial();
	if (!initialTrial) throw new Error("No Evo-Pi trial is active");
	return withFileLock(
		options.paths,
		`retrospective-run-${initialTrial.proposalId}`,
		async () => {
			const trial = await registry.readTrial();
			if (!trial || trial.proposalId !== initialTrial.proposalId) {
				throw new Error("The active Evo-Pi trial changed before retrospective generation");
			}
			const proposal = await loadProposal(options.paths, trial.proposalId);
			const trialBundle = await loadCompiledBundle(options.paths, trial.digest);
			const reflectorModel = options.model ?? trialBundle.policy.modelRouting?.reflector;
			const corpus = await collectEvidenceCorpus(options.paths, {
				maxBytes: options.maxCorpusBytes,
				mode: "full",
				completedSessionsOnly: true,
			});
			const storedComparison = await storeTrialComparison(options.paths, proposal, trial);
			const comparison = storedComparison.comparison;
			const evidenceDigest = trialEvidenceDigest(corpus.evidenceDigest, comparison.evidenceDigest);
			if (
				proposal.status !== "trialing" ||
				proposal.candidateDigest !== trial.digest ||
				proposal.parentBundleDigest !== trial.parent
			) {
				throw new Error("Active trial does not match its proposal lifecycle state");
			}
			const retrospective = proposal.artifacts.retrospective;
			if (retrospective) {
				const retrospectiveMarkdown = await readEvaluationArtifact({
					paths: options.paths,
					proposalId: proposal.id,
					revision: proposal.revision,
					diffDigest: proposal.diffDigest,
					kind: "retrospective",
					reference: retrospective,
				});
				if (retrospective.evidence?.digest === evidenceDigest) {
					return {
						proposal: storedComparison.proposal,
						trial,
						corpus,
						comparison,
						retrospectiveMarkdown,
						...(parseTrialRecommendation(retrospectiveMarkdown)
							? { recommendation: parseTrialRecommendation(retrospectiveMarkdown) }
							: {}),
						reused: true,
					};
				}
			}

			const evidenceCutoff = comparison.generatedAt;
			const prompt = [
				"Prepare the trial retrospective from the proposal, automatic comparison, and recorded corpus.",
				`Treat records with bundleDigest ${trial.parent} as the pre-trial baseline and records with bundleDigest ${trial.digest} at or after ${trial.startedAt} as trial/post evidence.`,
				"Do not treat records from other bundle digests as candidate effects.",
				`Evidence snapshot digest: ${evidenceDigest}; cutoff: ${evidenceCutoff}.`,
				"",
				"<automatic_comparison>",
				JSON.stringify(comparison, undefined, "\t"),
				"</automatic_comparison>",
				"",
				"<trial>",
				JSON.stringify(trial, undefined, "\t"),
				"</trial>",
				"",
				"<proposal>",
				JSON.stringify(proposal, undefined, "\t"),
				"</proposal>",
				"",
				`<pre_and_post_corpus truncated="${String(corpus.truncated)}">`,
				corpus.text,
				"</pre_and_post_corpus>",
			].join("\n");
			const run = await options.runner.run({
				cwd: options.cwd ?? process.cwd(),
				...(options.agentDir ? { agentDir: options.agentDir } : {}),
				systemPrompt: await readFile(RETROSPECTIVE_PROMPT_URL, "utf8"),
				prompt,
				...(reflectorModel ? { model: reflectorModel } : {}),
				...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
				submission: {
					toolName: "submit_retrospective",
					description: "Deliver the trial retrospective and the bounded recommendation.",
					parameters: Type.Object({
						recommendation: StringEnum(["keep", "rollback", "extend"] as const),
						retrospectiveMarkdown: Type.String({ minLength: 1 }),
					}),
				},
			});
			await recordModelUsage(options.paths, "retrospective", run);
			const submitted = run.submission as { recommendation: TrialRecommendation; retrospectiveMarkdown: string };
			// The stored artifact keeps the canonical Recommendation line so reuse reads
			// (parseTrialRecommendation) round-trip the submitted value exactly.
			const retrospectiveMarkdown = [
				`<!-- evo-pi evidence-digest=${evidenceDigest} comparison-digest=${comparison.evidenceDigest} evidence-cutoff=${evidenceCutoff} -->`,
				submitted.retrospectiveMarkdown.trim(),
				"",
				`Recommendation: ${submitted.recommendation}`,
				"",
			].join("\n");
			const storedProposal = await attachRetrospectiveArtifact({
				paths: options.paths,
				proposalId: proposal.id,
				expected: proposalApproval(proposal),
				content: retrospectiveMarkdown,
				evidenceDigest,
				evidenceCutoff,
			});
			return {
				proposal: storedProposal,
				trial,
				corpus,
				comparison,
				retrospectiveMarkdown,
				recommendation: submitted.recommendation,
				reused: false,
				run,
			};
		},
		{ timeoutMs: 5 * 60_000, staleAfterMs: 4 * 60 * 60_000 },
	);
}
