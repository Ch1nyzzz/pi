import { chmod, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface EvoPaths {
	root: string;
	log: string;
	digests: string;
	artifacts: string;
	components: string;
	inbox: string;
	bundles: string;
	runs: string;
	workflow: string;
	config: string;
	registry: string;
	stable: string;
	trial: string;
	transition: string;
	receipts: string;
	history: string;
	inboxHistory: string;
	paused: string;
	intents: string;
	proposals: string;
	reports: string;
	worktrees: string;
	locks: string;
}

function resolveEvoRoot(agentDir: string = getAgentDir()): string {
	return resolve(agentDir, "evo");
}

export function getEvoPaths(root: string = resolveEvoRoot()): EvoPaths {
	const resolvedRoot = resolve(root);
	const registry = join(resolvedRoot, "registry");
	return {
		root: resolvedRoot,
		log: join(resolvedRoot, "log"),
		digests: join(resolvedRoot, "session-digests"),
		artifacts: join(resolvedRoot, "artifacts", "sha256"),
		components: join(resolvedRoot, "components", "sha256"),
		inbox: join(resolvedRoot, "inbox"),
		bundles: join(resolvedRoot, "bundles"),
		runs: join(resolvedRoot, "runs"),
		workflow: join(resolvedRoot, "workflow.md"),
		config: join(resolvedRoot, "config.json"),
		registry,
		stable: join(registry, "stable"),
		trial: join(registry, "trial.json"),
		transition: join(registry, "transition.json"),
		receipts: join(registry, "receipts.jsonl"),
		history: join(registry, "history.jsonl"),
		inboxHistory: join(registry, "inbox-history.jsonl"),
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
		dirname(paths.components),
		paths.components,
		paths.log,
		paths.digests,
		paths.inbox,
		paths.bundles,
		paths.runs,
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
