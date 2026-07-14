import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface EvoPaths {
	root: string;
	log: string;
	artifacts: string;
	inbox: string;
	bundles: string;
	registry: string;
	stable: string;
	trial: string;
	history: string;
	paused: string;
	proposals: string;
	reports: string;
	worktrees: string;
	locks: string;
}

export function resolveEvoRoot(agentDir: string = getAgentDir()): string {
	return resolve(agentDir, "evo");
}

export function getEvoPaths(root: string = resolveEvoRoot()): EvoPaths {
	const resolvedRoot = resolve(root);
	const registry = join(resolvedRoot, "registry");
	return {
		root: resolvedRoot,
		log: join(resolvedRoot, "log"),
		artifacts: join(resolvedRoot, "artifacts", "sha256"),
		inbox: join(resolvedRoot, "inbox"),
		bundles: join(resolvedRoot, "bundles"),
		registry,
		stable: join(registry, "stable"),
		trial: join(registry, "trial.json"),
		history: join(registry, "history.jsonl"),
		paused: join(registry, "paused"),
		proposals: join(resolvedRoot, "proposals"),
		reports: join(resolvedRoot, "reports"),
		worktrees: join(resolvedRoot, "worktrees"),
		locks: join(resolvedRoot, "locks"),
	};
}

export async function ensureEvoLayout(paths: EvoPaths): Promise<void> {
	await Promise.all(
		[
			paths.log,
			paths.artifacts,
			paths.inbox,
			paths.bundles,
			paths.registry,
			paths.proposals,
			paths.reports,
			paths.worktrees,
			paths.locks,
		].map((directory) => mkdir(directory, { recursive: true })),
	);
}
