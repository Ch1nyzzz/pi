import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvoPaths } from "../paths.ts";
import { atomicWriteJson } from "../storage.ts";
import type { EvoCheckProfile } from "../types.ts";
import { evolutionRunDirectory } from "./run.ts";

export type EvolutionCandidateKind = "none" | "data" | "component" | "code";

/**
 * A receipt is the one and only representation of "this check actually executed".
 * It is written exclusively by the code that performed the execution; the release
 * gate reads receipts and nothing else. Declarations never count as execution.
 */
export interface ProfileReceipt {
	schemaVersion: 1;
	profile: EvoCheckProfile;
	passed: boolean;
	executedAt: string;
	/** Human-readable one-liner about what ran (command, scenario, scope). */
	summary: string;
	/** Digest or path of the produced artifact, when one exists. */
	artifact?: string;
}

/**
 * Capability table: which profiles can actually execute before release, per
 * candidate kind. A plan can only require what the system can execute — the
 * declarable set is derived from this table, never maintained separately.
 *
 * session-comparison and compaction-replay are absent: the former only runs
 * during the post-release trial retrospective, the latter has no executor yet.
 * Neither can therefore be a pre-release requirement.
 */
export const OFFLINE_PROFILE_CAPABILITIES: Partial<Record<EvoCheckProfile, ReadonlySet<EvolutionCandidateKind>>> = {
	// "none" plans freeze an experiment that is never built; they may describe the
	// checks a future candidate would need without blocking on execution.
	"bundle-compile": new Set(["none", "data", "component", "code"]),
	"repo-check": new Set(["code"]),
	"related-tests": new Set(["code", "component"]),
};

export const HISTORICAL_PROFILE_CAPABILITIES: Partial<Record<EvoCheckProfile, ReadonlySet<EvolutionCandidateKind>>> = {
	"paired-replay": new Set(["none", "data", "component", "code"]),
};

export function declarableProfiles(
	capabilities: Partial<Record<EvoCheckProfile, ReadonlySet<EvolutionCandidateKind>>>,
	kind: EvolutionCandidateKind,
): Set<EvoCheckProfile> {
	const declarable = new Set<EvoCheckProfile>();
	for (const [profile, kinds] of Object.entries(capabilities)) {
		if (kinds?.has(kind)) declarable.add(profile as EvoCheckProfile);
	}
	return declarable;
}

function receiptsDirectory(paths: EvoPaths, runId: string): string {
	return join(evolutionRunDirectory(paths, runId), "receipts");
}

export async function writeProfileReceipt(
	paths: EvoPaths,
	runId: string,
	receipt: Omit<ProfileReceipt, "schemaVersion" | "executedAt"> & { executedAt?: string },
): Promise<ProfileReceipt> {
	const complete: ProfileReceipt = {
		schemaVersion: 1,
		executedAt: receipt.executedAt ?? new Date().toISOString(),
		profile: receipt.profile,
		passed: receipt.passed,
		summary: receipt.summary,
		...(receipt.artifact ? { artifact: receipt.artifact } : {}),
	};
	await mkdir(receiptsDirectory(paths, runId), { recursive: true });
	await atomicWriteJson(join(receiptsDirectory(paths, runId), `${complete.profile}.json`), complete);
	return complete;
}

export async function readProfileReceipts(
	paths: EvoPaths,
	runId: string,
): Promise<ReadonlyMap<EvoCheckProfile, ProfileReceipt>> {
	const receipts = new Map<EvoCheckProfile, ProfileReceipt>();
	let entries: string[];
	try {
		entries = await readdir(receiptsDirectory(paths, runId));
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return receipts;
		throw error;
	}
	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;
		const value = JSON.parse(await readFile(join(receiptsDirectory(paths, runId), entry), "utf8")) as ProfileReceipt;
		if (value.schemaVersion !== 1 || typeof value.profile !== "string" || typeof value.passed !== "boolean") {
			throw new Error(`Profile receipt ${entry} is invalid`);
		}
		receipts.set(value.profile, value);
	}
	return receipts;
}
