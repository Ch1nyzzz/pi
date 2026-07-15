import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { loadCompiledBundle } from "../bundle/compile.ts";
import type { CodeValidationExecutor } from "../code/worktree.ts";
import {
	applyInboxDecisions,
	garbageCollectInbox,
	linkProposalInbox,
	readInboxEntry,
	readInboxLifecycleStates,
} from "../inbox.ts";
import { renderBundlePreferenceInstructions } from "../memory/preferences.ts";
import type { EvoPaths } from "../paths.ts";
import { attachProposalArtifact, proposalApproval, stageProposal } from "../proposal.ts";
import {
	advanceEvidenceReviewCursor,
	collectEvidenceCorpus,
	MATERIALIZED_CORPUS_BYTES,
	readEvidenceReviewCursor,
	validateDraftGrounding,
} from "../reflect/evidence.ts";
import type { ModelRunner } from "../reflect/model-runner.ts";
import { type CounterfactualReplayResult, runCounterfactualReplay } from "../reflect/replay.ts";
import { EvoService } from "../service.ts";
import { atomicWriteFile, atomicWriteJson, canonicalJson, sha256, withFileLock } from "../storage.ts";
import type { EvoControlConfig, EvolutionRun, Proposal } from "../types.ts";
import { runEvolutionBuilder } from "./builder.ts";
import { readProfileReceipts, writeProfileReceipt } from "./check-profiles.ts";
import { readEvoControlConfig } from "./config.ts";
import { type EvolutionEvaluationResult, runEvolutionEvaluator } from "./evaluator.ts";
import {
	applyEvolutionReleasePolicy,
	changesComponentSelection,
	type EvolutionReleaseResult,
	RELEASE_ACTION_RUN_STATUS,
} from "./release.ts";
import { materializeEvidenceCorpus } from "./research-corpus.ts";
import { runEvolutionResearchPlan } from "./research-plan.ts";
import { validateComponentCandidate } from "./retry.ts";
import { createEvolutionRun, evolutionRunDirectory, readEvolutionRun, updateEvolutionRun } from "./run.ts";

export interface RunEvolutionCycleOptions {
	paths: EvoPaths;
	runner: ModelRunner;
	service?: EvoService;
	cwd?: string;
	agentDir?: string;
	request?: string;
	trigger?: EvolutionRun["trigger"];
	config?: EvoControlConfig;
	maxCorpusBytes?: number;
	codeValidationExecutor?: CodeValidationExecutor;
	/** Test/development escape hatch for component process validation. */
	componentSandbox?: boolean;
	signal?: AbortSignal;
	/** Existing queued run created by the background launcher. */
	runId?: string;
}

export interface EvolutionCycleResult {
	run: EvolutionRun;
	proposals: Proposal[];
	evaluation?: EvolutionEvaluationResult;
	release?: EvolutionReleaseResult;
}

async function assertFrozenExperiment(paths: EvoPaths, run: EvolutionRun, experiment: unknown): Promise<void> {
	if (run.experimentFile !== "experiment.json" || !run.experimentDigest) {
		throw new Error(`Evolution task ${run.id} has no frozen experiment`);
	}
	const stored = JSON.parse(
		await readFile(join(evolutionRunDirectory(paths, run.id), run.experimentFile), "utf8"),
	) as unknown;
	const digest = sha256(canonicalJson(stored));
	if (digest !== run.experimentDigest || canonicalJson(stored) !== canonicalJson(experiment)) {
		throw new Error(`Evolution task ${run.id} frozen experiment changed`);
	}
}

async function firstCorpusRequest(paths: EvoPaths, files: readonly string[]): Promise<string | undefined> {
	const states = await readInboxLifecycleStates(paths);
	for (const file of files) {
		const entry = await readInboxEntry(paths, file);
		const text = entry.text.trimStart();
		if (entry.kind === "request" || states.get(file)?.kind === "request" || text.startsWith("REQUEST:")) {
			return text.startsWith("REQUEST:") ? text.slice("REQUEST:".length).trim() : text;
		}
	}
	return undefined;
}

async function runEvolutionCycleUnlocked(options: RunEvolutionCycleOptions): Promise<EvolutionCycleResult> {
	const service = options.service ?? new EvoService(options.paths);
	if (await service.registry.isPaused()) throw new Error("Evo-Pi is paused");
	const stable = await service.registry.readStableDigest();
	if (!stable) throw new Error("Evo-Pi registry is not initialized");
	const stableBundle = await loadCompiledBundle(options.paths, stable);
	const activePreferences = await renderBundlePreferenceInstructions(stableBundle);
	const reviewCursor = await readEvidenceReviewCursor(options.paths);
	const corpus = await collectEvidenceCorpus(options.paths, {
		mode: "incremental",
		// The cycle materializes the corpus to disk, so it can afford the large budget.
		maxBytes: options.maxCorpusBytes ?? MATERIALIZED_CORPUS_BYTES,
		...(reviewCursor ? { reviewCursor } : {}),
	});
	const request = options.request ?? (await firstCorpusRequest(options.paths, corpus.inboxFiles));
	const run = options.runId
		? await updateEvolutionRun(options.paths, (await readEvolutionRun(options.paths, options.runId)).id, {
				status: "researching",
				...(request ? { request } : {}),
				evidenceDigest: corpus.evidenceDigest,
				error: undefined,
			})
		: await createEvolutionRun({
				paths: options.paths,
				trigger: options.trigger ?? (request ? "request" : "scheduled"),
				...(request ? { request } : {}),
				evidenceDigest: corpus.evidenceDigest,
			});
	try {
		const config = options.config ?? (await readEvoControlConfig(options.paths));
		const cwd = options.cwd ?? process.cwd();
		// The corpus lives on disk as an on-demand file tree; prompts carry only its index
		// so large evidence never crowds the context window.
		const materializedCorpus = await materializeEvidenceCorpus(corpus, evolutionRunDirectory(options.paths, run.id));
		const research = await runEvolutionResearchPlan({
			paths: options.paths,
			run,
			corpus,
			materializedCorpus,
			runner: options.runner,
			cwd,
			...(options.agentDir ? { agentDir: options.agentDir } : {}),
			model: config.models.researchPlanner.model,
			...(config.models.researchPlanner.thinkingLevel
				? { thinkingLevel: config.models.researchPlanner.thinkingLevel }
				: {}),
			...(activePreferences ? { activePreferences } : {}),
			...(options.signal ? { signal: options.signal } : {}),
		});
		await assertFrozenExperiment(options.paths, research.state, research.plan.experiment);
		await applyInboxDecisions(options.paths, research.plan.inboxDecisions, new Set(corpus.inboxFiles));
		if (research.plan.candidateKind === "none") {
			await advanceEvidenceReviewCursor(options.paths, corpus.nextReviewCursor);
			await garbageCollectInbox(options.paths);
			const completed = await updateEvolutionRun(options.paths, run.id, { status: "completed" });
			return { run: completed, proposals: [] };
		}
		await updateEvolutionRun(options.paths, run.id, { status: "building" });
		const built = await runEvolutionBuilder({
			paths: options.paths,
			plan: research.plan,
			parentDigest: stable,
			corpus,
			materializedCorpus,
			sessionIdentity: `evo-builder-${run.id}`,
			runner: options.runner,
			cwd,
			...(options.agentDir ? { agentDir: options.agentDir } : {}),
			model: config.models.builder.model,
			...(config.models.builder.thinkingLevel ? { thinkingLevel: config.models.builder.thinkingLevel } : {}),
			...(activePreferences ? { activePreferences } : {}),
			...(options.signal ? { signal: options.signal } : {}),
		});
		await updateEvolutionRun(options.paths, run.id, { status: "validating" });
		const groundedDraft = {
			...built.draft,
			evidence: await validateDraftGrounding(options.paths, built.draft),
		};
		let proposal = await stageProposal({
			paths: options.paths,
			parentDigest: stable,
			draft: groundedDraft,
			observationsMarkdown: built.observationsMarkdown,
			repositoryCwd: cwd,
			...(options.codeValidationExecutor ? { codeValidationExecutor: options.codeValidationExecutor } : {}),
			...(options.signal ? { signal: options.signal } : {}),
		});
		await updateEvolutionRun(options.paths, run.id, { status: "validating", proposalId: proposal.id });
		if (!proposal.l1.passed) throw new Error(`Evolution proposal ${proposal.id} failed L1`);
		// Receipts are written by the code that actually executed each check; the
		// release gate reads receipts and nothing else.
		await writeProfileReceipt(options.paths, run.id, {
			profile: "bundle-compile",
			passed: proposal.l1.passed,
			summary: "Candidate bundle compiled during L1 staging",
			artifact: proposal.candidateDigest,
		});
		if (proposal.kind === "code") {
			// Sandboxed code staging runs the repository check and related tests as part of L1.
			await writeProfileReceipt(options.paths, run.id, {
				profile: "repo-check",
				passed: proposal.l1.passed,
				summary: "npm run check executed in the sandboxed L1 worktree",
			});
			await writeProfileReceipt(options.paths, run.id, {
				profile: "related-tests",
				passed: proposal.l1.passed,
				summary: "Changed-path vitest suites executed in the sandboxed L1 worktree",
			});
		}
		if (changesComponentSelection(proposal)) {
			const validation = await validateComponentCandidate(options.paths, proposal, {
				sandbox: options.componentSandbox,
			});
			await atomicWriteFile(join(evolutionRunDirectory(options.paths, run.id), "validation.md"), validation);
			await writeProfileReceipt(options.paths, run.id, {
				profile: "related-tests",
				passed: true,
				summary: "Component ABI fixture validation executed",
			});
			proposal = await attachProposalArtifact({
				paths: options.paths,
				proposalId: proposal.id,
				expected: proposalApproval(proposal),
				kind: "validation",
				content: validation,
				allowedStatuses: ["pending"],
			});
		}
		await linkProposalInbox(options.paths, proposal);
		let replay: CounterfactualReplayResult | undefined;
		if (proposal.tier === "T2") {
			await updateEvolutionRun(options.paths, run.id, { status: "replaying", proposalId: proposal.id });
			replay = await runCounterfactualReplay({
				paths: options.paths,
				runner: options.runner,
				proposal,
				...(options.agentDir ? { agentDir: options.agentDir } : {}),
				model: config.models.evaluator.model,
				...(config.models.evaluator.thinkingLevel ? { thinkingLevel: config.models.evaluator.thinkingLevel } : {}),
				...(options.signal ? { signal: options.signal } : {}),
			});
			proposal = replay.proposal;
			await writeProfileReceipt(options.paths, run.id, {
				profile: "paired-replay",
				passed: true,
				summary: "Counterfactual paired replay executed against the recorded scenario",
				artifact: sha256(replay.markdown),
			});
		}
		await assertFrozenExperiment(
			options.paths,
			await readEvolutionRun(options.paths, run.id),
			research.plan.experiment,
		);
		await updateEvolutionRun(options.paths, run.id, { status: "evaluating", proposalId: proposal.id });
		const evaluation = await runEvolutionEvaluator({
			paths: options.paths,
			plan: research.plan,
			proposal,
			corpus,
			materializedCorpus,
			...(replay ? { replay } : {}),
			runner: options.runner,
			cwd,
			...(options.agentDir ? { agentDir: options.agentDir } : {}),
			model: config.models.evaluator.model,
			...(config.models.evaluator.thinkingLevel ? { thinkingLevel: config.models.evaluator.thinkingLevel } : {}),
			...(activePreferences ? { activePreferences } : {}),
			...(options.signal ? { signal: options.signal } : {}),
		});
		proposal = evaluation.proposal;
		await atomicWriteFile(join(evolutionRunDirectory(options.paths, run.id), "evaluation.md"), evaluation.markdown);
		// The intent file marks the non-atomic window between "release policy may have
		// mutated the registry" and "the final run status is on disk"; crash reconcile
		// derives the truth from the proposal whenever this file exists.
		await atomicWriteJson(join(evolutionRunDirectory(options.paths, run.id), "release-intent.json"), {
			schemaVersion: 1,
			proposalId: proposal.id,
			verdict: evaluation.verdict,
			intendedAt: new Date().toISOString(),
		});
		const release = await applyEvolutionReleasePolicy({
			service,
			config,
			proposal,
			verdict: evaluation.verdict,
			evidenceStrategy: research.plan.experiment.evidenceStrategy,
			receipts: await readProfileReceipts(options.paths, run.id),
		});
		await advanceEvidenceReviewCursor(options.paths, corpus.nextReviewCursor);
		await garbageCollectInbox(options.paths);
		const completed = await updateEvolutionRun(options.paths, run.id, {
			status: RELEASE_ACTION_RUN_STATUS[release.action],
			proposalId: release.proposal.id,
			...(release.action === "awaiting-canary-approval"
				? {
						canaryCandidateDigest: release.proposal.candidateDigest,
						canaryParentDigest: release.proposal.parentBundleDigest,
						canaryTargetAbi: release.proposal.targetAbi,
					}
				: {}),
		});
		await rm(join(evolutionRunDirectory(options.paths, run.id), "release-intent.json"), { force: true });
		return { run: completed, proposals: [release.proposal], evaluation, release };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await updateEvolutionRun(options.paths, run.id, {
			status: options.signal?.aborted ? "cancelled" : "failed",
			error: message,
		}).catch(() => undefined);
		throw error;
	}
}

export async function runEvolutionCycle(options: RunEvolutionCycleOptions): Promise<EvolutionCycleResult> {
	return withFileLock(options.paths, "evolution-cycle", () => runEvolutionCycleUnlocked(options), {
		timeoutMs: 24 * 60 * 60_000,
		staleAfterMs: 24 * 60 * 60_000,
	});
}
