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
import { stageProposal } from "../proposal.ts";
import {
	advanceEvidenceReviewCursor,
	collectEvidenceCorpus,
	readEvidenceReviewCursor,
	validateDraftGrounding,
} from "../reflect/evidence.ts";
import type { ModelRunner } from "../reflect/model-runner.ts";
import { type CounterfactualReplayResult, runCounterfactualReplay } from "../reflect/replay.ts";
import { EvoService } from "../service.ts";
import { atomicWriteFile, withFileLock } from "../storage.ts";
import type { EvoControlConfig, EvolutionRun, Proposal } from "../types.ts";
import { runEvolutionBuilder } from "./builder.ts";
import { readEvoControlConfig } from "./config.ts";
import { type EvolutionEvaluationResult, runEvolutionEvaluator } from "./evaluator.ts";
import { applyEvolutionReleasePolicy, type EvolutionReleaseResult } from "./release.ts";
import { runEvolutionResearchPlan } from "./research-plan.ts";
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
		maxBytes: options.maxCorpusBytes,
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
		const research = await runEvolutionResearchPlan({
			paths: options.paths,
			run,
			corpus,
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
			runner: options.runner,
			cwd,
			...(options.agentDir ? { agentDir: options.agentDir } : {}),
			model: config.models.builder.model,
			...(config.models.builder.thinkingLevel ? { thinkingLevel: config.models.builder.thinkingLevel } : {}),
			...(activePreferences ? { activePreferences } : {}),
			...(options.signal ? { signal: options.signal } : {}),
		});
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
		if (!proposal.l1.passed) throw new Error(`Evolution proposal ${proposal.id} failed L1`);
		await linkProposalInbox(options.paths, proposal);
		let replay: CounterfactualReplayResult | undefined;
		if (proposal.tier === "T2") {
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
		}
		await updateEvolutionRun(options.paths, run.id, { status: "evaluating", proposalId: proposal.id });
		const evaluation = await runEvolutionEvaluator({
			paths: options.paths,
			plan: research.plan,
			proposal,
			corpus,
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
		const release = await applyEvolutionReleasePolicy({
			service,
			config,
			proposal,
			verdict: evaluation.verdict,
		});
		await advanceEvidenceReviewCursor(options.paths, corpus.nextReviewCursor);
		await garbageCollectInbox(options.paths);
		const completed = await updateEvolutionRun(options.paths, run.id, {
			status: "completed",
			proposalId: release.proposal.id,
		});
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
