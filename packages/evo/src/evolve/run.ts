import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { EvoPaths } from "../paths.ts";
import { ensureEvoLayout } from "../paths.ts";
import { loadProposal } from "../proposal.ts";
import { atomicWriteJson, readJson, readJsonIfExists } from "../storage.ts";
import type { EvoExperimentSpec, EvolutionRun, EvolutionRunStatus } from "../types.ts";

const RUN_ID_PATTERN = /^r-[A-Za-z0-9._-]+$/;
const PROPOSAL_ID_PATTERN = /^p-[A-Za-z0-9._-]+$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const TERMINAL_STATUSES = new Set<EvolutionRunStatus>(["completed", "failed", "cancelled"]);

/**
 * Legal run-status transitions. Same-status patches always pass; anything absent
 * here throws, which makes accidental resets (most importantly any transition out
 * of "completed") unrepresentable instead of merely unlikely.
 */
const RUN_TRANSITIONS: Record<EvolutionRunStatus, ReadonlySet<EvolutionRunStatus>> = {
	queued: new Set([
		"researching",
		"building",
		"completed",
		"validating",
		"awaiting-canary-approval",
		"paused",
		"failed",
		"cancelled",
	]),
	researching: new Set(["planned", "paused", "failed", "cancelled"]),
	planned: new Set(["building", "completed", "paused", "failed", "cancelled"]),
	building: new Set(["validating", "paused", "failed", "cancelled"]),
	validating: new Set([
		"replaying",
		"evaluating",
		"awaiting-canary-approval",
		"awaiting-evidence",
		"awaiting-decision",
		"paused",
		"failed",
		"cancelled",
	]),
	replaying: new Set(["evaluating", "paused", "failed", "cancelled"]),
	evaluating: new Set([
		"completed",
		"trialing",
		"awaiting-evidence",
		"awaiting-canary-approval",
		"awaiting-decision",
		"paused",
		"failed",
		"cancelled",
	]),
	"awaiting-evidence": new Set([
		"replaying",
		"evaluating",
		"trialing",
		"awaiting-decision",
		"completed",
		"failed",
		"cancelled",
	]),
	"awaiting-canary-approval": new Set(["trialing", "awaiting-decision", "completed", "failed", "cancelled"]),
	"awaiting-decision": new Set(["trialing", "completed", "failed", "cancelled"]),
	trialing: new Set(["awaiting-decision", "completed", "failed", "cancelled"]),
	paused: new Set([
		"queued",
		"researching",
		"planned",
		"building",
		"validating",
		"replaying",
		"evaluating",
		"failed",
		"cancelled",
	]),
	failed: new Set(["researching"]),
	cancelled: new Set(["researching"]),
	completed: new Set(),
};

function runId(): string {
	return `r-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

export function evolutionRunDirectory(paths: EvoPaths, id: string): string {
	if (!RUN_ID_PATTERN.test(id)) throw new Error(`Invalid evolution run id: ${id}`);
	return join(paths.runs, id);
}

export async function createEvolutionRun(options: {
	paths: EvoPaths;
	trigger: EvolutionRun["trigger"];
	request?: string;
	evidenceDigest: string;
	status?: EvolutionRunStatus;
	now?: () => Date;
}): Promise<EvolutionRun> {
	await ensureEvoLayout(options.paths);
	const id = runId();
	const timestamp = (options.now ?? (() => new Date()))().toISOString();
	const run: EvolutionRun = {
		schemaVersion: 1,
		id,
		trigger: options.trigger,
		...(options.request ? { request: options.request } : {}),
		status: options.status ?? "researching",
		startedAt: timestamp,
		updatedAt: timestamp,
		evidenceDigest: options.evidenceDigest,
	};
	const directory = evolutionRunDirectory(options.paths, id);
	await mkdir(directory, { recursive: false, mode: 0o700 });
	await atomicWriteJson(join(directory, "run.json"), run);
	return run;
}

function parseEvolutionRun(value: unknown): EvolutionRun {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Evolution run is invalid");
	const run = value as Record<string, unknown>;
	const statuses = new Set<EvolutionRunStatus>([
		"queued",
		"researching",
		"planned",
		"building",
		"validating",
		"replaying",
		"evaluating",
		"awaiting-evidence",
		"awaiting-canary-approval",
		"trialing",
		"awaiting-decision",
		"paused",
		"completed",
		"failed",
		"cancelled",
	]);
	if (
		run.schemaVersion !== 1 ||
		typeof run.id !== "string" ||
		!RUN_ID_PATTERN.test(run.id) ||
		(run.trigger !== "scheduled" && run.trigger !== "request") ||
		typeof run.status !== "string" ||
		!statuses.has(run.status as EvolutionRunStatus) ||
		typeof run.startedAt !== "string" ||
		typeof run.updatedAt !== "string" ||
		typeof run.evidenceDigest !== "string" ||
		(run.request !== undefined && typeof run.request !== "string") ||
		(run.planFile !== undefined && typeof run.planFile !== "string") ||
		(run.experimentFile !== undefined && typeof run.experimentFile !== "string") ||
		(run.proposalId !== undefined &&
			(typeof run.proposalId !== "string" || !PROPOSAL_ID_PATTERN.test(run.proposalId))) ||
		(run.error !== undefined && typeof run.error !== "string") ||
		(run.workerPid !== undefined && (!Number.isInteger(run.workerPid) || (run.workerPid as number) <= 0)) ||
		(run.workerStartedAt !== undefined && typeof run.workerStartedAt !== "string") ||
		(run.logFile !== undefined && typeof run.logFile !== "string") ||
		(run.pausedAt !== undefined && typeof run.pausedAt !== "string") ||
		(run.pausedFrom !== undefined &&
			run.pausedFrom !== "queued" &&
			run.pausedFrom !== "researching" &&
			run.pausedFrom !== "planned" &&
			run.pausedFrom !== "building" &&
			run.pausedFrom !== "validating" &&
			run.pausedFrom !== "replaying" &&
			run.pausedFrom !== "evaluating") ||
		(run.canaryApprovedAt !== undefined && typeof run.canaryApprovedAt !== "string") ||
		(run.canaryApprovalDigest !== undefined &&
			(typeof run.canaryApprovalDigest !== "string" || !DIGEST_PATTERN.test(run.canaryApprovalDigest))) ||
		(run.canaryStableDigest !== undefined &&
			(typeof run.canaryStableDigest !== "string" || !DIGEST_PATTERN.test(run.canaryStableDigest))) ||
		(run.canaryCandidateDigest !== undefined &&
			(typeof run.canaryCandidateDigest !== "string" || !DIGEST_PATTERN.test(run.canaryCandidateDigest))) ||
		(run.canaryParentDigest !== undefined &&
			(typeof run.canaryParentDigest !== "string" || !DIGEST_PATTERN.test(run.canaryParentDigest))) ||
		(run.canaryTargetAbi !== undefined &&
			(typeof run.canaryTargetAbi !== "string" || !/^[a-z][a-z0-9-]*\/v[1-9][0-9]*$/.test(run.canaryTargetAbi))) ||
		(run.componentApprovalMode !== undefined &&
			run.componentApprovalMode !== "direct" &&
			run.componentApprovalMode !== "default-canary" &&
			run.componentApprovalMode !== "custom-canary") ||
		(run.canaryMinimumSamples !== undefined &&
			(!Number.isSafeInteger(run.canaryMinimumSamples) || (run.canaryMinimumSamples as number) <= 0)) ||
		(run.canaryMaximumDurationDays !== undefined &&
			(!Number.isSafeInteger(run.canaryMaximumDurationDays) || (run.canaryMaximumDurationDays as number) <= 0)) ||
		(run.experimentDigest !== undefined &&
			(typeof run.experimentDigest !== "string" || !DIGEST_PATTERN.test(run.experimentDigest))) ||
		(run.retryOfRunId !== undefined &&
			(typeof run.retryOfRunId !== "string" || !RUN_ID_PATTERN.test(run.retryOfRunId))) ||
		(run.sourceProposalId !== undefined &&
			(typeof run.sourceProposalId !== "string" || !PROPOSAL_ID_PATTERN.test(run.sourceProposalId))) ||
		(run.resumeFrom !== undefined && run.resumeFrom !== "building")
	) {
		throw new Error("Evolution run is invalid");
	}
	return value as EvolutionRun;
}

export async function readEvolutionRun(paths: EvoPaths, id: string): Promise<EvolutionRun> {
	return parseEvolutionRun(await readJson(join(evolutionRunDirectory(paths, id), "run.json")));
}

export async function updateEvolutionRun(
	paths: EvoPaths,
	id: string,
	patch: Partial<
		Pick<
			EvolutionRun,
			| "status"
			| "request"
			| "evidenceDigest"
			| "planFile"
			| "experimentFile"
			| "proposalId"
			| "error"
			| "workerPid"
			| "workerStartedAt"
			| "logFile"
			| "pausedAt"
			| "pausedFrom"
			| "canaryApprovedAt"
			| "canaryApprovalDigest"
			| "canaryStableDigest"
			| "canaryCandidateDigest"
			| "canaryParentDigest"
			| "canaryTargetAbi"
			| "componentApprovalMode"
			| "canaryMinimumSamples"
			| "canaryMaximumDurationDays"
			| "experimentDigest"
			| "retryOfRunId"
			| "sourceProposalId"
			| "resumeFrom"
		>
	>,
	now: () => Date = () => new Date(),
): Promise<EvolutionRun> {
	const current = await readEvolutionRun(paths, id);
	if (
		patch.status !== undefined &&
		patch.status !== current.status &&
		!RUN_TRANSITIONS[current.status].has(patch.status)
	) {
		throw new Error(`Illegal evolution run transition ${current.status} → ${patch.status} for ${id}`);
	}
	const next: EvolutionRun = { ...current, ...patch, updatedAt: now().toISOString() };
	await atomicWriteJson(join(evolutionRunDirectory(paths, id), "run.json"), next);
	return next;
}

export async function deleteEvolutionRun(paths: EvoPaths, id: string): Promise<void> {
	await rm(evolutionRunDirectory(paths, id), { recursive: true, force: true });
}

async function reconcileEvolutionRun(paths: EvoPaths, run: EvolutionRun): Promise<EvolutionRun> {
	if (TERMINAL_STATUSES.has(run.status) || !run.proposalId) return run;
	const proposal = await loadProposal(paths, run.proposalId);
	const status =
		proposal.status === "trialing"
			? "trialing"
			: proposal.status === "deferred"
				? "awaiting-decision"
				: proposal.status === "approved" ||
						proposal.status === "rejected" ||
						proposal.status === "kept" ||
						proposal.status === "rolled-back"
					? "completed"
					: run.status;
	return status === run.status ? run : updateEvolutionRun(paths, run.id, { status });
}

export async function listEvolutionRuns(paths: EvoPaths): Promise<EvolutionRun[]> {
	await ensureEvoLayout(paths);
	const runs: EvolutionRun[] = [];
	for (const entry of await readdir(paths.runs, { withFileTypes: true })) {
		if (!entry.isDirectory() || !RUN_ID_PATTERN.test(entry.name)) continue;
		runs.push(await reconcileEvolutionRun(paths, await readEvolutionRun(paths, entry.name)));
	}
	return runs.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

/**
 * Locate the frozen experiment contract that produced a proposal by scanning run
 * records for the matching proposalId. Reads are deliberately tolerant: legacy
 * runs without a contract simply yield undefined.
 */
export async function readFrozenExperimentForProposal(
	paths: EvoPaths,
	proposalId: string,
): Promise<EvoExperimentSpec | undefined> {
	let entries: string[];
	try {
		entries = await readdir(paths.runs);
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return undefined;
		throw error;
	}
	for (const id of entries) {
		const run = await readJsonIfExists<{ proposalId?: string; experimentFile?: string }>(
			join(paths.runs, id, "run.json"),
		);
		if (!run || run.proposalId !== proposalId || !run.experimentFile) continue;
		const experiment = await readJsonIfExists<EvoExperimentSpec>(join(paths.runs, id, run.experimentFile));
		if (experiment) return experiment;
	}
	return undefined;
}
