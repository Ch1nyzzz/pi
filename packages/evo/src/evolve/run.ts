import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { EvoPaths } from "../paths.ts";
import { ensureEvoLayout } from "../paths.ts";
import { atomicWriteJson, readJson } from "../storage.ts";
import type { EvolutionRun, EvolutionRunStatus } from "../types.ts";

const RUN_ID_PATTERN = /^r-[A-Za-z0-9._-]+$/;

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
		"evaluating",
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
		(run.proposalId !== undefined && typeof run.proposalId !== "string") ||
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
			run.pausedFrom !== "evaluating")
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
		>
	>,
	now: () => Date = () => new Date(),
): Promise<EvolutionRun> {
	const current = await readEvolutionRun(paths, id);
	const next: EvolutionRun = { ...current, ...patch, updatedAt: now().toISOString() };
	await atomicWriteJson(join(evolutionRunDirectory(paths, id), "run.json"), next);
	return next;
}

export async function deleteEvolutionRun(paths: EvoPaths, id: string): Promise<void> {
	await rm(evolutionRunDirectory(paths, id), { recursive: true, force: true });
}

export async function listEvolutionRuns(paths: EvoPaths): Promise<EvolutionRun[]> {
	await ensureEvoLayout(paths);
	const runs: EvolutionRun[] = [];
	for (const entry of await readdir(paths.runs, { withFileTypes: true })) {
		if (!entry.isDirectory() || !RUN_ID_PATTERN.test(entry.name)) continue;
		runs.push(await readEvolutionRun(paths, entry.name));
	}
	return runs.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}
