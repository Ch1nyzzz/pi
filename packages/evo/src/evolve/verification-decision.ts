import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { EvoPaths } from "../paths.ts";
import { loadProposal } from "../proposal.ts";
import type { EvoService } from "../service.ts";
import { atomicWriteJson, readJsonIfExists } from "../storage.ts";
import type { EvoCheckProfile, EvoControlConfig, EvolutionResearchPlan, EvolutionRun } from "../types.ts";
import { readProfileReceipts } from "./check-profiles.ts";
import type { EvolutionEvaluationVerdict } from "./evaluator.ts";
import { applyEvolutionReleasePolicy, type EvolutionReleaseResult, RELEASE_ACTION_RUN_STATUS } from "./release.ts";
import { evolutionRunDirectory, readEvolutionRun, updateEvolutionRun } from "./run.ts";

const PENDING_VERIFICATION_FILE = "pending-verification.json";

/**
 * A researcher-recommended verification the harness deferred so the user can
 * decide execute, skip, or reject. The stored verdict is the evaluation result
 * computed without the recommended evidence; skipping releases against it.
 */
export interface PendingVerification {
	schemaVersion: 1;
	runId: string;
	proposalId: string;
	profiles: EvoCheckProfile[];
	datasets: string[];
	minimumSamples: number;
	reason: string;
	verdict: EvolutionEvaluationVerdict;
	evaluatedAt: string;
}

function pendingVerificationPath(paths: EvoPaths, runId: string): string {
	return join(evolutionRunDirectory(paths, runId), PENDING_VERIFICATION_FILE);
}

export async function writePendingVerification(paths: EvoPaths, record: PendingVerification): Promise<void> {
	await atomicWriteJson(pendingVerificationPath(paths, record.runId), record);
}

export async function readPendingVerification(
	paths: EvoPaths,
	runId: string,
): Promise<PendingVerification | undefined> {
	const record = await readJsonIfExists<PendingVerification>(pendingVerificationPath(paths, runId));
	if (!record || record.schemaVersion !== 1 || record.runId !== runId) return undefined;
	return record;
}

export async function clearPendingVerification(paths: EvoPaths, runId: string): Promise<void> {
	await rm(pendingVerificationPath(paths, runId), { force: true });
}

async function readRunPlan(paths: EvoPaths, runId: string): Promise<EvolutionResearchPlan> {
	const raw = await readFile(join(evolutionRunDirectory(paths, runId), "plan.json"), "utf8");
	return JSON.parse(raw) as EvolutionResearchPlan;
}

async function requirePendingVerification(
	paths: EvoPaths,
	runId: string,
): Promise<{ run: EvolutionRun; pending: PendingVerification }> {
	const run = await readEvolutionRun(paths, runId);
	if (run.status !== "awaiting-evidence") {
		throw new Error(`Evolution run ${runId} is ${run.status}, not awaiting a verification decision`);
	}
	const pending = await readPendingVerification(paths, runId);
	if (!pending) throw new Error(`Evolution run ${runId} has no pending verification decision`);
	return { run, pending };
}

/**
 * Release the candidate on the already-computed verdict without executing the
 * recommended verification. The frozen recommendation was never a release
 * blocker, so the standing release policy applies unchanged.
 */
export async function skipPendingVerification(options: {
	paths: EvoPaths;
	service: EvoService;
	config: EvoControlConfig;
	runId: string;
}): Promise<EvolutionReleaseResult> {
	const { pending } = await requirePendingVerification(options.paths, options.runId);
	const plan = await readRunPlan(options.paths, options.runId);
	const proposal = await loadProposal(options.paths, pending.proposalId);
	const directory = evolutionRunDirectory(options.paths, options.runId);
	await atomicWriteJson(join(directory, "release-intent.json"), {
		schemaVersion: 1,
		proposalId: proposal.id,
		verdict: pending.verdict,
		intendedAt: new Date().toISOString(),
	});
	const release = await applyEvolutionReleasePolicy({
		service: options.service,
		config: options.config,
		proposal,
		verdict: pending.verdict,
		evidenceStrategy: plan.experiment.evidenceStrategy,
		receipts: await readProfileReceipts(options.paths, options.runId),
	});
	await updateEvolutionRun(options.paths, options.runId, {
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
	await clearPendingVerification(options.paths, options.runId);
	await rm(join(directory, "release-intent.json"), { force: true });
	return release;
}

/** Reject the candidate outright instead of spending verification budget on it. */
export async function rejectPendingVerification(options: {
	paths: EvoPaths;
	service: EvoService;
	runId: string;
}): Promise<void> {
	const { pending } = await requirePendingVerification(options.paths, options.runId);
	await options.service.reject(pending.proposalId, "User declined the recommended verification and the candidate");
	await updateEvolutionRun(options.paths, options.runId, { status: "completed" });
	await clearPendingVerification(options.paths, options.runId);
}
