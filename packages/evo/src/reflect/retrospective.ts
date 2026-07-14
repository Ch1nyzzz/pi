import { readFile } from "node:fs/promises";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { loadCompiledBundle } from "../bundle/compile.ts";
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

export interface RetrospectiveRunResult {
	proposal: Proposal;
	trial: TrialState;
	corpus: EvidenceCorpus;
	retrospectiveMarkdown: string;
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
			});
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
				if (retrospective.evidence?.digest === corpus.evidenceDigest) {
					return { proposal, trial, corpus, retrospectiveMarkdown, reused: true };
				}
			}

			const evidenceCutoff = corpus.nextReviewCursor.updatedAt;
			const prompt = [
				"Prepare the trial retrospective from the proposal and recorded corpus.",
				`Treat records with bundleDigest ${trial.parent} as the pre-trial baseline and records with bundleDigest ${trial.digest} at or after ${trial.startedAt} as trial/post evidence.`,
				"Do not treat records from other bundle digests as candidate effects.",
				`Evidence snapshot digest: ${corpus.evidenceDigest}; cutoff: ${evidenceCutoff}.`,
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
			});
			await recordModelUsage(options.paths, "retrospective", run);
			const retrospectiveMarkdown = [
				`<!-- evo-pi evidence-digest=${corpus.evidenceDigest} evidence-cutoff=${evidenceCutoff} -->`,
				run.text.trim(),
				"",
			].join("\n");
			const storedProposal = await attachRetrospectiveArtifact({
				paths: options.paths,
				proposalId: proposal.id,
				expected: proposalApproval(proposal),
				content: retrospectiveMarkdown,
				evidenceDigest: corpus.evidenceDigest,
				evidenceCutoff,
			});
			return { proposal: storedProposal, trial, corpus, retrospectiveMarkdown, reused: false, run };
		},
		{ timeoutMs: 5 * 60_000, staleAfterMs: 4 * 60 * 60_000 },
	);
}
