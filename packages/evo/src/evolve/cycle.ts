import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { loadCompiledBundle } from "../bundle/compile.ts";
import type { CodeValidationExecutor } from "../code/worktree.ts";
import { createDefaultEvoAbiRegistry } from "../components/registry.ts";
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
import type { EvoControlConfig, EvolutionResearchPlan, EvolutionRun, Proposal } from "../types.ts";
import { runEvolutionBuilder, runUnknownAbiBuilder } from "./builder.ts";
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
import { persistEvolutionResearchPlan, runEvolutionResearchPlan } from "./research-plan.ts";
import { validateComponentCandidate } from "./retry.ts";
import { createEvolutionRun, evolutionRunDirectory, readEvolutionRun, updateEvolutionRun } from "./run.ts";
import {
	assertUnknownAbiCodePatch,
	parseUnknownAbiBuilderRequest,
	type UnknownAbiBuilderRequest,
} from "./unknown-abi.ts";
import { writePendingVerification } from "./verification-decision.ts";

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

export interface RunUnknownAbiBuilderCycleOptions {
	paths: EvoPaths;
	request: unknown;
	runner: ModelRunner;
	service?: EvoService;
	/** Stable bundle observed by pack import; drift fails before a run is created. */
	parentDigest?: string;
	cwd?: string;
	agentDir?: string;
	config?: EvoControlConfig;
	codeValidationExecutor?: CodeValidationExecutor;
	signal?: AbortSignal;
}

export interface UnknownAbiBuilderCycleResult {
	run: EvolutionRun;
	proposal: Proposal;
	request: UnknownAbiBuilderRequest;
	plan: EvolutionResearchPlan;
	nextAction: string;
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

async function assertFrozenUnknownAbiRequest(
	paths: EvoPaths,
	run: EvolutionRun,
	request: UnknownAbiBuilderRequest,
): Promise<void> {
	const stored = parseUnknownAbiBuilderRequest(
		JSON.parse(
			await readFile(join(evolutionRunDirectory(paths, run.id), "unknown-abi-request.json"), "utf8"),
		) as unknown,
	);
	const digest = sha256(canonicalJson(stored));
	if (digest !== run.evidenceDigest || canonicalJson(stored) !== canonicalJson(request)) {
		throw new Error(`Evolution task ${run.id} frozen unknown ABI request changed`);
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
			runId: run.id,
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
			...(built.codeBase ? { expectedCodeBase: built.codeBase } : {}),
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
		// Replay execution is contract-driven: the frozen plan requires it, or it
		// recommends it and this run auto-executes recommendations (scheduled runs
		// always do; request runs only when configured). A recommendation that is
		// not auto-executed is deferred to an explicit user decision after
		// evaluation instead of silently blocking or silently skipping.
		const historicalReplay = research.plan.experiment.evidenceStrategy.historicalReplay;
		const autoExecuteRecommended = run.trigger === "scheduled" || config.verification.approval === "auto";
		const replayDeclared =
			(historicalReplay.mode === "required" ||
				(historicalReplay.mode === "recommended" && autoExecuteRecommended)) &&
			historicalReplay.profiles.includes("paired-replay");
		let replay: CounterfactualReplayResult | undefined;
		if (proposal.tier === "T2" || (replayDeclared && proposal.replayScenarios.length > 0)) {
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
		const deferredProfiles =
			historicalReplay.mode === "recommended" && !autoExecuteRecommended
				? await (async () => {
						const receipts = await readProfileReceipts(options.paths, run.id);
						return historicalReplay.profiles.filter((profile) => receipts.get(profile)?.passed !== true);
					})()
				: [];
		await updateEvolutionRun(options.paths, run.id, { status: "evaluating", proposalId: proposal.id });
		const evaluation = await runEvolutionEvaluator({
			paths: options.paths,
			plan: research.plan,
			proposal,
			corpus,
			materializedCorpus,
			...(replay ? { replay } : {}),
			...(deferredProfiles.length > 0 ? { deferredProfiles } : {}),
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
		if (
			deferredProfiles.length > 0 &&
			historicalReplay.mode === "recommended" &&
			evaluation.verdict !== "invalid" &&
			evaluation.verdict !== "unsupported"
		) {
			// Park the run for an explicit execute/skip/reject decision. No release
			// intent is written: the registry has not been touched yet, and both the
			// skip and execute paths apply the release policy themselves later.
			await writePendingVerification(options.paths, {
				schemaVersion: 1,
				runId: run.id,
				proposalId: proposal.id,
				profiles: deferredProfiles,
				datasets: historicalReplay.datasets,
				minimumSamples: historicalReplay.minimumSamples,
				reason: historicalReplay.reason,
				verdict: evaluation.verdict,
				evaluatedAt: new Date().toISOString(),
			});
			await advanceEvidenceReviewCursor(options.paths, corpus.nextReviewCursor);
			await garbageCollectInbox(options.paths);
			const parked = await updateEvolutionRun(options.paths, run.id, {
				status: "awaiting-evidence",
				proposalId: proposal.id,
			});
			return { run: parked, proposals: [proposal], evaluation };
		}
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

function unknownAbiResearchPlan(request: UnknownAbiBuilderRequest, parentDigest: string): EvolutionResearchPlan {
	const selections = request.parts.map((part) => {
		const capabilities = part.manifest.capabilities.join(", ") || "(none)";
		return `- ${part.selection.id}: artifact ${part.selection.artifactDigest}; capabilities ${capabilities}; explicit grants ${canonicalJson(part.selection.grants)}`;
	});
	const trialPlan =
		"Do not activate a component in this run. Await explicit T2 code review; after approval, commit the staged patch, rebuild and restart the host, then retry the same integrity-pinned pack import to create the component-selection proposal.";
	return {
		topic: `Add host ABI ${request.targetAbi} for optimization pack ${request.source.name}`,
		reason: `Pack ${request.source.name}@${request.source.version} declares ${request.targetAbi}, which is not registered in this host.`,
		planMarkdown: [
			`# Add unregistered ABI ${request.targetAbi}`,
			"",
			`Pack: ${request.source.name}@${request.source.version}`,
			`Integrity: ${request.source.integrity}`,
			`Surface: ${request.surface}`,
			`Activation boundary: ${request.activationBoundary}`,
			`Capability ceiling: ${request.capabilityCeiling.join(", ") || "(empty)"}`,
			"",
			"## Frozen future selections",
			"",
			...selections,
			"",
			"These selections are audit input only. This plan must not write policy or broker state. After the ABI patch is approved and the host is rebuilt, retry import to stage them through the registered-ABI path.",
		].join("\n"),
		experiment: {
			baseline: `Stable bundle ${parentDigest}; ${request.targetAbi} absent from the default ABI registry.`,
			hypothesis:
				"A narrowly scoped ABI definition, strict validators, host wiring, and focused tests can safely expose the requested surface without widening component authority.",
			checkProfiles: ["repo-check", "related-tests"],
			evidenceStrategy: {
				patchClass: "infrastructure",
				offline: { mode: "required", profiles: ["repo-check", "related-tests"] },
				historicalReplay: {
					mode: "not-applicable",
					reason: "A previously unavailable host ABI has no valid historical runtime baseline to replay.",
				},
				online: { mode: "none" },
				rollout: "direct",
			},
			metrics: [],
			minimumEffect: {},
			trialPlan,
			rollbackConditions: [
				"Generated capability ceiling differs from the exact declared union.",
				"Host wiring grants ambient authority or mutates broker state.",
				"Repository check or focused tests fail.",
			],
		},
		targetAbi: request.targetAbi,
		requiresNewAbi: true,
		candidateKind: "code",
		builderInstructions:
			"Define and register the exact EvoAbiDefinition, make strict config/input/output validators compatible with the pack's default empty config, wire only the declared host surface, and add focused tests. Do not activate or grant the future component selection.",
		inboxDecisions: [],
	};
}

async function runUnknownAbiBuilderCycleUnlocked(
	options: RunUnknownAbiBuilderCycleOptions,
): Promise<UnknownAbiBuilderCycleResult> {
	const request = parseUnknownAbiBuilderRequest(options.request);
	if (createDefaultEvoAbiRegistry().get(request.targetAbi)) {
		throw new Error(`ABI is already registered; retry normal pack import instead: ${request.targetAbi}`);
	}
	const service = options.service ?? new EvoService(options.paths);
	if (await service.registry.isPaused()) throw new Error("Evo-Pi is paused");
	const existing = (await service.listProposals()).find(
		(proposal) =>
			proposal.requiresNewAbi === true &&
			proposal.targetAbi === request.targetAbi &&
			proposal.status !== "rejected" &&
			proposal.status !== "rolled-back",
	);
	if (existing) {
		throw new Error(
			`ABI ${request.targetAbi} already has proposal ${existing.id} in status ${existing.status}; review it or rebuild before retrying import`,
		);
	}
	const stable = await service.registry.readStableDigest();
	if (!stable) throw new Error("Evo-Pi registry is not initialized");
	if (options.parentDigest && options.parentDigest !== stable) {
		throw new Error("Stable bundle changed after pack inspection; inspect the pack again before building its ABI");
	}
	await loadCompiledBundle(options.paths, stable);
	const requestDigest = sha256(canonicalJson(request));
	const run = await createEvolutionRun({
		paths: options.paths,
		trigger: "request",
		request: `Install ${request.source.name}@${request.source.version}: add unregistered ABI ${request.targetAbi}`,
		evidenceDigest: requestDigest,
	});
	try {
		const directory = evolutionRunDirectory(options.paths, run.id);
		await atomicWriteJson(join(directory, "unknown-abi-request.json"), request);
		await assertFrozenUnknownAbiRequest(options.paths, run, request);
		const persisted = await persistEvolutionResearchPlan({
			paths: options.paths,
			run,
			plan: unknownAbiResearchPlan(request, stable),
		});
		await assertFrozenExperiment(options.paths, persisted.state, persisted.plan.experiment);
		const config = options.config ?? (await readEvoControlConfig(options.paths));
		const cwd = options.cwd ?? process.cwd();
		await updateEvolutionRun(options.paths, run.id, { status: "building" });
		const built = await runUnknownAbiBuilder({
			paths: options.paths,
			plan: persisted.plan,
			request,
			runner: options.runner,
			cwd,
			...(options.agentDir ? { agentDir: options.agentDir } : {}),
			model: config.models.builder.model,
			...(config.models.builder.thinkingLevel ? { thinkingLevel: config.models.builder.thinkingLevel } : {}),
			sessionIdentity: `evo-unknown-abi-builder-${run.id}`,
			...(options.signal ? { signal: options.signal } : {}),
		});
		await updateEvolutionRun(options.paths, run.id, { status: "validating" });
		const expectedPaths = assertUnknownAbiCodePatch(request, built.draft.codePatch ?? "");
		await assertFrozenUnknownAbiRequest(options.paths, await readEvolutionRun(options.paths, run.id), request);
		const proposal = await stageProposal({
			paths: options.paths,
			parentDigest: stable,
			draft: built.draft,
			observationsMarkdown: built.observationsMarkdown,
			repositoryCwd: cwd,
			...(options.codeValidationExecutor ? { codeValidationExecutor: options.codeValidationExecutor } : {}),
			...(options.signal ? { signal: options.signal } : {}),
		});
		await updateEvolutionRun(options.paths, run.id, {
			status: "validating",
			proposalId: proposal.id,
		});
		if (canonicalJson(proposal.changedPaths) !== canonicalJson(expectedPaths)) {
			throw new Error(`Unknown ABI proposal ${proposal.id} staged a path set different from its reviewed patch`);
		}
		if (
			proposal.kind !== "code" ||
			proposal.tier !== "T2" ||
			proposal.targetAbi !== request.targetAbi ||
			proposal.requiresNewAbi !== true
		) {
			throw new Error(`Unknown ABI proposal ${proposal.id} lost its mandatory T2 infrastructure classification`);
		}
		await writeProfileReceipt(options.paths, run.id, {
			profile: "repo-check",
			passed: proposal.l1.passed,
			summary: "npm run check executed in the sandboxed unknown-ABI worktree",
		});
		await writeProfileReceipt(options.paths, run.id, {
			profile: "related-tests",
			passed: proposal.l1.passed,
			summary: "Focused Evo tests executed in the sandboxed unknown-ABI worktree",
		});
		if (!proposal.l1.passed) throw new Error(`Unknown ABI proposal ${proposal.id} failed L1`);
		await assertFrozenExperiment(
			options.paths,
			await readEvolutionRun(options.paths, run.id),
			persisted.plan.experiment,
		);
		await assertFrozenUnknownAbiRequest(options.paths, await readEvolutionRun(options.paths, run.id), request);
		const awaitingDecision = await updateEvolutionRun(options.paths, run.id, {
			status: "awaiting-decision",
			proposalId: proposal.id,
		});
		return {
			run: awaitingDecision,
			proposal,
			request,
			plan: persisted.plan,
			nextAction:
				"Review and explicitly confirm the T2 patch; commit, rebuild, and restart the host, then retry the same pack import.",
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await updateEvolutionRun(options.paths, run.id, {
			status: options.signal?.aborted ? "cancelled" : "failed",
			error: message,
		}).catch(() => undefined);
		throw error;
	}
}

export async function runUnknownAbiBuilderCycle(
	options: RunUnknownAbiBuilderCycleOptions,
): Promise<UnknownAbiBuilderCycleResult> {
	return withFileLock(options.paths, "evolution-cycle", () => runUnknownAbiBuilderCycleUnlocked(options), {
		timeoutMs: 24 * 60 * 60_000,
		staleAfterMs: 24 * 60 * 60_000,
	});
}
