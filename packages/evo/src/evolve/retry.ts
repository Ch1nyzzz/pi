import { copyFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { loadCompiledBundle } from "../bundle/compile.ts";
import { validateEvoComponentSelection } from "../components/artifact.ts";
import { EvoComponentProcess } from "../components/process-runtime.ts";
import { type CompactionV1Output, createDefaultEvoAbiRegistry } from "../components/registry.ts";
import { renderBundlePreferenceInstructions } from "../memory/preferences.ts";
import type { EvoPaths } from "../paths.ts";
import { attachProposalArtifact, loadProposal, proposalApproval, stageProposal } from "../proposal.ts";
import { validateEvaluationArtifact } from "../proposal-artifacts.ts";
import type { ModelRunner } from "../reflect/model-runner.ts";
import { type CounterfactualReplayResult, runCounterfactualReplay } from "../reflect/replay.ts";
import { BundleRegistry } from "../registry/registry.ts";
import { EvoService } from "../service.ts";
import { atomicWriteFile, atomicWriteJson, canonicalJson, sha256 } from "../storage.ts";
import type {
	EvoCheckProfile,
	EvoControlConfig,
	EvoExperimentSpec,
	EvolutionResearchPlan,
	EvolutionRun,
	EvolutionRunStatus,
	Proposal,
} from "../types.ts";
import { readProfileReceipts, writeProfileReceipt } from "./check-profiles.ts";
import { readEvoControlConfig } from "./config.ts";
import { type EvolutionEvaluationVerdict, runEvolutionEvaluator } from "./evaluator.ts";
import { applyEvolutionReleasePolicy, type EvolutionReleaseResult, RELEASE_ACTION_RUN_STATUS } from "./release.ts";
import { readMaterializedCorpus } from "./research-corpus.ts";
import { createEvolutionRun, evolutionRunDirectory, readEvolutionRun, updateEvolutionRun } from "./run.ts";
import { dryRunWorkflowSelection } from "./workflow-dry-run.ts";

async function candidateChanges(
	paths: EvoPaths,
	proposal: Proposal,
): Promise<Array<{ path: string; content: string | null }>> {
	if (!proposal.candidateDigest) throw new Error(`Proposal ${proposal.id} has no candidate bundle`);
	const candidate = await loadCompiledBundle(paths, proposal.candidateDigest);
	return Promise.all(
		proposal.changedPaths.map(async (path) => {
			try {
				return { path, content: await readFile(join(candidate.directory, path), "utf8") };
			} catch {
				return { path, content: null };
			}
		}),
	);
}

async function readBoundArtifact(paths: EvoPaths, proposal: Proposal, kind: "review" | "replay"): Promise<string> {
	const reference = proposal.artifacts[kind];
	if (!reference) throw new Error(`Source proposal ${proposal.id} has no ${kind} artifact`);
	await validateEvaluationArtifact({
		paths,
		proposalId: proposal.id,
		revision: proposal.revision,
		diffDigest: proposal.diffDigest,
		kind,
		reference,
	});
	return readFile(join(paths.proposals, proposal.id, reference.file), "utf8");
}

export async function validateComponentCandidate(
	paths: EvoPaths,
	proposal: Proposal,
	options: { sandbox?: boolean } = {},
): Promise<string> {
	if (!proposal.candidateDigest || !proposal.targetAbi)
		throw new Error("Retry candidate is not a component selection");
	const bundle = await loadCompiledBundle(paths, proposal.candidateDigest);
	const registry = createDefaultEvoAbiRegistry();
	const abi = registry.require(proposal.targetAbi);
	if (abi.id === "workflow/v1") {
		const selections = bundle.policy.workflows ?? [];
		if (selections.length === 0) throw new Error("Candidate bundle selects no workflows");
		const outcomes = await Promise.all(
			selections.map((selection) => dryRunWorkflowSelection(paths, selection, options)),
		);
		const failed = outcomes.filter((outcome) => !outcome.passed);
		if (failed.length > 0) {
			throw new Error(
				`Workflow dry run failed for ${failed.length} selection(s):\n${failed
					.map((outcome) => outcome.markdown)
					.join("\n")}`,
			);
		}
		return outcomes.map((outcome) => outcome.markdown).join("\n");
	}
	const selection = bundle.policy.components?.[abi.surface];
	if (!selection) throw new Error(`Candidate bundle does not select ${abi.surface}`);
	const config = registry.validateSelection(abi.surface, selection);
	const artifact = await validateEvoComponentSelection(paths, abi.surface, selection, registry);
	const process = new EvoComponentProcess(artifact, abi, config, { sandbox: options.sandbox });
	try {
		await process.start();
		await process.health();
		if (abi.id !== "compaction/v1") {
			throw new Error(`Retry validation has no deterministic fixture for ${abi.id}`);
		}
		const initialInput = {
			conversation: "[User]: Preserve requirement alpha.\n\n[Assistant]: Requirement alpha is active.",
			firstKeptEntryId: "entry-alpha",
			tokensBefore: 4096,
			reason: "threshold" as const,
		};
		// The ABI declares metrics as observational telemetry (wall-clock timing);
		// determinism binds the semantic effect, not the observation of producing it.
		const semanticEffect = ({ metrics: _telemetry, ...effect }: CompactionV1Output) => effect;
		const first = (await process.invoke(initialInput)) as CompactionV1Output;
		const repeated = (await process.invoke(initialInput)) as CompactionV1Output;
		if (canonicalJson(semanticEffect(first)) !== canonicalJson(semanticEffect(repeated))) {
			throw new Error("Component output is not deterministic");
		}
		if (first.firstKeptEntryId !== initialInput.firstKeptEntryId) {
			throw new Error("Component changed firstKeptEntryId");
		}
		const appended = (await process.invoke({
			...initialInput,
			conversation: "[User]: Preserve requirement beta.",
			previousSummary: first.summary,
			tokensBefore: 8192,
		})) as CompactionV1Output;
		if (!appended.summary.startsWith(first.summary)) {
			throw new Error("Append compaction did not preserve previousSummary as an exact prefix");
		}
		return [
			"# Reused component validation",
			"",
			`- artifact: ${artifact.manifest.artifactDigest}`,
			`- ABI: ${abi.id}`,
			`- execution boundary: ${process.sandboxKind ?? "unknown"}`,
			"- initialize: passed",
			"- health: passed",
			"- deterministic repeated invoke: passed",
			"- firstKeptEntryId preservation: passed",
			"- exact append-prefix preservation: passed",
			"- shutdown: passed",
			"",
		].join("\n");
	} finally {
		await process.shutdown();
	}
}

export async function retryEvolutionFromValidation(options: {
	paths: EvoPaths;
	sourceRunId: string;
	cwd: string;
	sandbox?: boolean;
}): Promise<{ runId: string; proposal: Proposal; status: EvolutionRunStatus }> {
	let sourceRun = await readEvolutionRun(options.paths, options.sourceRunId);
	if (!["completed", "failed", "cancelled"].includes(sourceRun.status)) {
		throw new Error(`Evolution task ${sourceRun.id} is still active; pause or finish it before retrying`);
	}
	if (!sourceRun.proposalId) throw new Error(`Evolution task ${sourceRun.id} has no reusable proposal`);
	const source = await loadProposal(options.paths, sourceRun.proposalId);
	if (!source.targetAbi || !source.candidateDigest)
		throw new Error("Only built component candidates can resume at validation");
	if (sourceRun.planFile !== "plan.md" || sourceRun.experimentFile !== "experiment.json") {
		throw new Error(`Evolution task ${sourceRun.id} has no reusable frozen experiment`);
	}
	const sourceDirectory = evolutionRunDirectory(options.paths, sourceRun.id);
	const experiment = await readFile(join(sourceDirectory, sourceRun.experimentFile), "utf8");
	const experimentSpec = JSON.parse(experiment) as Partial<EvoExperimentSpec>;
	const experimentDigest = sha256(canonicalJson(experimentSpec));
	if (sourceRun.experimentDigest && experimentDigest !== sourceRun.experimentDigest) {
		throw new Error(`Evolution task ${sourceRun.id} frozen experiment changed`);
	}
	if (!sourceRun.experimentDigest) {
		// Legacy runs predate experiment digests. Pin their existing immutable
		// experiment exactly once before creating the retry lineage.
		sourceRun = await updateEvolutionRun(options.paths, sourceRun.id, { experimentDigest });
	}
	const [sourceReplay, sourceReview] = await Promise.all([
		source.artifacts.replay ? readBoundArtifact(options.paths, source, "replay") : undefined,
		source.artifacts.review ? readBoundArtifact(options.paths, source, "review") : undefined,
	]);
	const stable = await new BundleRegistry(options.paths).readStableDigest();
	if (stable !== source.parentBundleDigest) throw new Error("Stable bundle changed; the candidate must be rebuilt");
	const run = await createEvolutionRun({
		paths: options.paths,
		trigger: "request",
		request: sourceRun.request ?? source.motivation,
		evidenceDigest: sourceRun.evidenceDigest,
		status: "validating",
	});
	const retryDirectory = evolutionRunDirectory(options.paths, run.id);
	let retryProposal: Proposal | undefined;
	try {
		await copyFile(join(sourceDirectory, "plan.md"), join(retryDirectory, "plan.md"));
		await copyFile(join(sourceDirectory, "experiment.json"), join(retryDirectory, "experiment.json"));
		await updateEvolutionRun(options.paths, run.id, {
			retryOfRunId: sourceRun.id,
			sourceProposalId: source.id,
			experimentDigest: sourceRun.experimentDigest,
			planFile: "plan.md",
			experimentFile: "experiment.json",
		});
		const observations = await readFile(join(options.paths.proposals, source.id, "observations.md"), "utf8");
		const proposal = await stageProposal({
			paths: options.paths,
			parentDigest: source.parentBundleDigest,
			observationsMarkdown: observations,
			draft: {
				motivation: source.motivation,
				expectedEffect: source.expectedEffect,
				risk: source.risk,
				verifyPlan: source.verifyPlan,
				trialPlan: source.trialPlan,
				source: source.source,
				evidence: source.evidence,
				inboxReferences: source.inboxReferences,
				replayScenarios: source.replayScenarios,
				targetAbi: source.targetAbi,
				requiresNewAbi: source.requiresNewAbi,
				suggestedTier: source.tier,
				changes: await candidateChanges(options.paths, source),
			},
			repositoryCwd: options.cwd,
		});
		retryProposal = proposal;
		await updateEvolutionRun(options.paths, run.id, { proposalId: proposal.id });
		if (!proposal.l1.passed) throw new Error(`Reused proposal ${proposal.id} failed L1`);
		if (
			proposal.diffDigest !== source.diffDigest ||
			proposal.candidateDigest !== source.candidateDigest ||
			proposal.targetAbi !== source.targetAbi
		) {
			throw new Error("Reused component no longer matches the source candidate");
		}
		const validation = await validateComponentCandidate(options.paths, proposal, { sandbox: options.sandbox });
		await atomicWriteFile(join(evolutionRunDirectory(options.paths, run.id), "validation.md"), validation);
		let reviewed = await attachProposalArtifact({
			paths: options.paths,
			proposalId: proposal.id,
			expected: proposalApproval(proposal),
			kind: "replay",
			content:
				sourceReplay ??
				`${validation}\nThis trusted executable component replay replaces the unavailable pre-validation model replay. Provider and live-session effects remain Canary evidence.\n`,
			allowedStatuses: ["pending"],
		});
		reviewed = await attachProposalArtifact({
			paths: options.paths,
			proposalId: reviewed.id,
			expected: proposalApproval(reviewed),
			kind: "validation",
			content: validation,
			allowedStatuses: ["pending"],
		});
		reviewed = await attachProposalArtifact({
			paths: options.paths,
			proposalId: reviewed.id,
			expected: proposalApproval(reviewed),
			kind: "review",
			content: [
				"# Retry review",
				"",
				"## Prior independent evaluation",
				"",
				sourceReview?.trim() ??
					"No prior independent evaluation completed because the source run stopped during deterministic validation.",
				"",
				"## Trusted executable-validation addendum",
				"",
				"The exact same content-addressed candidate passed executable ABI, health, determinism, and prefix-preservation validation. Benefit and semantic non-inferiority remain unverified, so it may only enter the explicitly approved reversible Canary.",
				"",
				"Recommendation: needs-evidence",
				"",
			].join("\n"),
			allowedStatuses: ["pending"],
		});
		const strategy = experimentSpec.evidenceStrategy;
		const canaryEligible =
			strategy?.historicalReplay.mode !== "required" &&
			strategy?.online.mode === "canary" &&
			strategy.rollout === "canary-first";
		const status: EvolutionRunStatus = canaryEligible ? "awaiting-canary-approval" : "awaiting-evidence";
		await updateEvolutionRun(options.paths, run.id, {
			status,
			proposalId: reviewed.id,
			...(canaryEligible
				? {
						canaryCandidateDigest: reviewed.candidateDigest,
						canaryParentDigest: reviewed.parentBundleDigest,
						canaryTargetAbi: reviewed.targetAbi,
					}
				: {}),
		});
		return { runId: run.id, proposal: reviewed, status };
	} catch (error) {
		if (retryProposal?.status === "pending") {
			await new EvoService(options.paths)
				.reject(retryProposal.id, "Retry validation failed before Canary activation")
				.catch(() => undefined);
		}
		await updateEvolutionRun(options.paths, run.id, {
			status: "failed",
			error: error instanceof Error ? error.message : String(error),
		}).catch(() => undefined);
		throw error;
	}
}

export interface ResumeEvolutionEvidenceResult {
	run: EvolutionRun;
	release: EvolutionReleaseResult;
	verdict: EvolutionEvaluationVerdict;
	executedProfilesNow: EvoCheckProfile[];
}

/**
 * Complete an awaiting-evidence run by executing whichever required check profiles
 * can still run (currently paired-replay), then re-evaluating and re-applying the
 * deterministic release policy. The waiting state is defined by missing receipts,
 * so this is the state machine's own forward edge — not a special-case repair.
 */
export async function resumeEvolutionEvidence(options: {
	paths: EvoPaths;
	runner: ModelRunner;
	runId: string;
	cwd?: string;
	agentDir?: string;
	config?: EvoControlConfig;
	signal?: AbortSignal;
}): Promise<ResumeEvolutionEvidenceResult> {
	const run = await readEvolutionRun(options.paths, options.runId);
	if (run.status !== "awaiting-evidence") {
		throw new Error(`Evolution run ${run.id} is ${run.status}, not awaiting-evidence`);
	}
	if (!run.proposalId) throw new Error(`Evolution run ${run.id} has no proposal to resume`);
	const directory = evolutionRunDirectory(options.paths, run.id);
	const planRaw = await readFile(join(directory, "plan.json"), "utf8").catch(() => undefined);
	if (!planRaw) {
		throw new Error(`Evolution run ${run.id} predates plan persistence and cannot resume automatically`);
	}
	const plan = JSON.parse(planRaw) as EvolutionResearchPlan;
	let proposal = await loadProposal(options.paths, run.proposalId);
	const config = options.config ?? (await readEvoControlConfig(options.paths));
	const service = new EvoService(options.paths);

	const strategy = plan.experiment.evidenceStrategy;
	const required: EvoCheckProfile[] = [
		...(strategy.offline.mode === "required" ? strategy.offline.profiles : []),
		...(strategy.historicalReplay.mode === "required" ? strategy.historicalReplay.profiles : []),
	];
	const receipts = await readProfileReceipts(options.paths, run.id);
	const missing = required.filter((profile) => receipts.get(profile)?.passed !== true);
	const executedProfilesNow: EvoCheckProfile[] = [];

	let replay: CounterfactualReplayResult | undefined;
	if (missing.includes("paired-replay") && proposal.replayScenarios.length > 0) {
		await updateEvolutionRun(options.paths, run.id, { status: "replaying" });
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
			summary: "Counterfactual paired replay executed during evidence resumption",
			artifact: sha256(replay.markdown),
		});
		executedProfilesNow.push("paired-replay");
	}

	const materializedCorpus = await readMaterializedCorpus(directory);
	const stable = await new BundleRegistry(options.paths).readStableDigest();
	const activePreferences = stable
		? await renderBundlePreferenceInstructions(await loadCompiledBundle(options.paths, stable))
		: undefined;
	await updateEvolutionRun(options.paths, run.id, { status: "evaluating" });
	const evaluation = await runEvolutionEvaluator({
		paths: options.paths,
		plan,
		proposal,
		corpus: { text: "", truncated: false },
		// The revision's review artifact is immutable; this re-evaluation lives in
		// the run directory as evaluation-resume.md instead.
		attachArtifact: false,
		...(materializedCorpus ? { materializedCorpus } : {}),
		...(replay ? { replay } : {}),
		runner: options.runner,
		cwd: options.cwd ?? process.cwd(),
		...(options.agentDir ? { agentDir: options.agentDir } : {}),
		model: config.models.evaluator.model,
		...(config.models.evaluator.thinkingLevel ? { thinkingLevel: config.models.evaluator.thinkingLevel } : {}),
		...(activePreferences ? { activePreferences } : {}),
		...(options.signal ? { signal: options.signal } : {}),
	});
	proposal = evaluation.proposal;
	await atomicWriteFile(join(directory, "evaluation-resume.md"), evaluation.markdown);
	await atomicWriteJson(join(directory, "release-intent.json"), {
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
		evidenceStrategy: strategy,
		receipts: await readProfileReceipts(options.paths, run.id),
	});
	const finalRun = await updateEvolutionRun(options.paths, run.id, {
		status: RELEASE_ACTION_RUN_STATUS[release.action],
		proposalId: release.proposal.id,
	});
	await rm(join(directory, "release-intent.json"), { force: true });
	return { run: finalRun, release, verdict: evaluation.verdict, executedProfilesNow };
}
