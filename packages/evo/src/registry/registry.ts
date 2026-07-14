import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { loadCompiledBundle } from "../bundle/compile.ts";
import { isDigest } from "../bundle/schema.ts";
import { type EvoPaths, ensureEvoLayout, getEvoPaths } from "../paths.ts";
import { appendJsonLine, atomicWriteFile, atomicWriteJson, readJsonIfExists, withFileLock } from "../storage.ts";
import type { EvoStatus, HistoryEntry, Proposal, TrialState } from "../types.ts";

async function readTextIfExists(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

export class BundleRegistry {
	readonly paths: EvoPaths;

	constructor(paths: EvoPaths = getEvoPaths()) {
		this.paths = paths;
	}

	async readStableDigest(): Promise<string | undefined> {
		const digest = (await readTextIfExists(this.paths.stable))?.trim();
		if (!digest) return undefined;
		if (!isDigest(digest)) throw new Error("registry/stable contains an invalid digest");
		return digest;
	}

	async readTrial(): Promise<TrialState | undefined> {
		const trial = await readJsonIfExists<TrialState>(this.paths.trial);
		if (!trial) return undefined;
		if (!isDigest(trial.digest) || !isDigest(trial.parent) || !trial.proposalId || !trial.startedAt) {
			throw new Error("registry/trial.json is invalid");
		}
		return trial;
	}

	private async appendHistory(entry: HistoryEntry): Promise<void> {
		await appendJsonLine(this.paths.history, entry);
	}

	async initialize(digest: string, reason = "Initialize Evo-Pi registry"): Promise<void> {
		await withFileLock(this.paths, "registry", async () => {
			if (await this.readStableDigest()) throw new Error("Evo-Pi registry is already initialized");
			await loadCompiledBundle(this.paths, digest);
			await atomicWriteFile(this.paths.stable, `${digest}\n`);
			await this.appendHistory({
				timestamp: new Date().toISOString(),
				action: "initialize",
				actor: "human",
				toDigest: digest,
				reason,
			});
		});
	}

	async activateTrial(options: { digest: string; proposalId: string; plan: string }): Promise<TrialState> {
		return withFileLock(this.paths, "registry", async () => {
			const stable = await this.readStableDigest();
			if (!stable) throw new Error("Evo-Pi registry is not initialized");
			if (await this.readTrial()) throw new Error("A trial is already active; keep or rollback it first");
			const candidate = await loadCompiledBundle(this.paths, options.digest);
			if (candidate.manifest.parentDigest !== stable) {
				throw new Error("Proposal parent is no longer stable; regenerate or rebase the proposal");
			}
			const trial: TrialState = {
				digest: options.digest,
				parent: stable,
				proposalId: options.proposalId,
				startedAt: new Date().toISOString(),
				plan: options.plan,
			};
			await atomicWriteJson(this.paths.trial, trial);
			try {
				await atomicWriteFile(this.paths.stable, `${options.digest}\n`);
			} catch (error) {
				await unlink(this.paths.trial).catch(() => {});
				throw error;
			}
			await this.appendHistory({
				timestamp: trial.startedAt,
				action: "trial-start",
				actor: "human",
				fromDigest: stable,
				toDigest: options.digest,
				proposalId: options.proposalId,
				reason: options.plan,
			});
			return trial;
		});
	}

	async keepTrial(reason: string): Promise<TrialState> {
		return withFileLock(this.paths, "registry", async () => {
			const trial = await this.readTrial();
			if (!trial) throw new Error("No trial is active");
			if ((await this.readStableDigest()) !== trial.digest) throw new Error("Trial and stable pointer disagree");
			await unlink(this.paths.trial);
			await this.appendHistory({
				timestamp: new Date().toISOString(),
				action: "trial-keep",
				actor: "human",
				fromDigest: trial.parent,
				toDigest: trial.digest,
				proposalId: trial.proposalId,
				reason,
			});
			return trial;
		});
	}

	async rollback(targetDigest: string | undefined, reason: string): Promise<{ from: string; to: string }> {
		return withFileLock(this.paths, "registry", async () => {
			const stable = await this.readStableDigest();
			if (!stable) throw new Error("Evo-Pi registry is not initialized");
			const trial = await this.readTrial();
			const currentBundle = await loadCompiledBundle(this.paths, stable);
			const target =
				targetDigest ??
				(trial?.digest === stable ? trial.parent : (currentBundle.manifest.parentDigest ?? undefined));
			if (!target) throw new Error("Current bundle has no parent; provide an explicit rollback digest");
			await loadCompiledBundle(this.paths, target);
			await atomicWriteFile(this.paths.stable, `${target}\n`);
			if (trial) await unlink(this.paths.trial).catch(() => {});
			await this.appendHistory({
				timestamp: new Date().toISOString(),
				action: "rollback",
				actor: "human",
				fromDigest: stable,
				toDigest: target,
				proposalId: trial?.proposalId,
				reason,
			});
			return { from: stable, to: target };
		});
	}

	async recordDecision(options: { proposalId: string; approved: boolean; reason: string }): Promise<void> {
		await withFileLock(this.paths, "registry", async () => {
			await this.appendHistory({
				timestamp: new Date().toISOString(),
				action: options.approved ? "proposal-approved" : "proposal-rejected",
				actor: "human",
				proposalId: options.proposalId,
				reason: options.reason,
			});
		});
	}

	async pause(reason: string): Promise<void> {
		await withFileLock(this.paths, "registry", async () => {
			await atomicWriteFile(this.paths.paused, `${new Date().toISOString()}\t${reason}\n`);
			await this.appendHistory({
				timestamp: new Date().toISOString(),
				action: "pause",
				actor: "human",
				reason,
			});
		});
	}

	async resume(reason: string): Promise<void> {
		await withFileLock(this.paths, "registry", async () => {
			await unlink(this.paths.paused).catch(() => {});
			await this.appendHistory({
				timestamp: new Date().toISOString(),
				action: "resume",
				actor: "human",
				reason,
			});
		});
	}

	async isPaused(): Promise<boolean> {
		return (await readTextIfExists(this.paths.paused)) !== undefined;
	}

	async getStatus(): Promise<EvoStatus> {
		await ensureEvoLayout(this.paths);
		let pendingProposals = 0;
		for (const entry of await readdir(this.paths.proposals, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			try {
				const proposal = JSON.parse(
					await readFile(join(this.paths.proposals, entry.name, "proposal.json"), "utf8"),
				) as Proposal;
				if (proposal.status === "pending") pendingProposals++;
			} catch (error) {
				if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT")
					throw error;
			}
		}
		const stableDigest = await this.readStableDigest();
		return {
			initialized: stableDigest !== undefined,
			stableDigest,
			trial: await this.readTrial(),
			pendingProposals,
			paused: await this.isPaused(),
		};
	}
}
