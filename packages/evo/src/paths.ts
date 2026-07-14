import { chmod, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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
	transition: string;
	receipts: string;
	history: string;
	paused: string;
	intents: string;
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
		transition: join(registry, "transition.json"),
		receipts: join(registry, "receipts.jsonl"),
		history: join(registry, "history.jsonl"),
		paused: join(registry, "paused"),
		intents: join(registry, "intents"),
		proposals: join(resolvedRoot, "proposals"),
		reports: join(resolvedRoot, "reports"),
		worktrees: join(resolvedRoot, "worktrees"),
		locks: join(resolvedRoot, "locks"),
	};
}

export async function ensureEvoLayout(paths: EvoPaths): Promise<void> {
	const directories = [
		paths.root,
		dirname(paths.artifacts),
		paths.artifacts,
		paths.log,
		paths.inbox,
		paths.bundles,
		paths.registry,
		paths.intents,
		paths.proposals,
		paths.reports,
		paths.worktrees,
		paths.locks,
	];
	await Promise.all(
		[...new Set(directories)].map(async (directory) => {
			await mkdir(directory, { recursive: true, mode: 0o700 });
			await chmod(directory, 0o700);
		}),
	);
}
