import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { compileBundle, loadCompiledBundle } from "./bundle/compile.ts";
import { type EvoPaths, ensureEvoLayout, getEvoPaths } from "./paths.ts";
import { approveProposal, loadProposal, rejectProposal, saveProposal } from "./proposal.ts";
import { createRecorderStore, type StoredInboxEntry } from "./recorder/store.ts";
import { BundleRegistry } from "./registry/registry.ts";
import { atomicWriteJson } from "./storage.ts";
import type { CompiledBundle, EvoStatus, Proposal } from "./types.ts";

export class EvoService {
	readonly paths: EvoPaths;
	readonly registry: BundleRegistry;

	constructor(paths: EvoPaths = getEvoPaths()) {
		this.paths = paths;
		this.registry = new BundleRegistry(paths);
	}

	async init(): Promise<CompiledBundle> {
		await ensureEvoLayout(this.paths);
		const existingDigest = await this.registry.readStableDigest();
		if (existingDigest) return loadCompiledBundle(this.paths, existingDigest);

		const sourceDirectory = await mkdtemp(join(this.paths.root, ".seed-"));
		try {
			await atomicWriteJson(join(sourceDirectory, "policy.json"), {
				schemaVersion: 1,
				coreAssets: [],
				modelRouting: {},
				validation: { requiredChecks: [] },
			});
			const bundle = await compileBundle({
				paths: this.paths,
				sourceDirectory,
				parentDigest: null,
				summary: "Initial empty Evo-Pi data bundle",
			});
			await this.registry.initialize(bundle.digest);
			return bundle;
		} finally {
			await rm(sourceDirectory, { recursive: true, force: true });
		}
	}

	async status(): Promise<EvoStatus> {
		return this.registry.getStatus();
	}

	async listProposals(): Promise<Proposal[]> {
		await ensureEvoLayout(this.paths);
		const proposals: Proposal[] = [];
		for (const entry of await readdir(this.paths.proposals, { withFileTypes: true })) {
			if (!entry.isDirectory() || !entry.name.startsWith("p-")) continue;
			proposals.push(await loadProposal(this.paths, entry.name));
		}
		return proposals.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
	}

	async getProposal(id: string): Promise<Proposal> {
		return loadProposal(this.paths, id);
	}

	async note(sessionId: string, text: string): Promise<StoredInboxEntry> {
		return this.writeInbox(sessionId, "NOTE", text);
	}

	async request(sessionId: string, text: string): Promise<StoredInboxEntry> {
		return this.writeInbox(sessionId, "REQUEST", text);
	}

	async approve(id: string, expectedApprovalDigest: string): Promise<Proposal> {
		return approveProposal(this.paths, id, expectedApprovalDigest);
	}

	async reject(id: string, reason: string): Promise<Proposal> {
		return rejectProposal(this.paths, id, reason);
	}

	async rollback(targetDigest: string | undefined, reason: string): Promise<{ from: string; to: string }> {
		const trial = await this.registry.readTrial();
		const result = await this.registry.rollback(targetDigest, reason);
		if (trial) {
			const proposal = await loadProposal(this.paths, trial.proposalId);
			proposal.status = "rolled-back";
			await saveProposal(this.paths, proposal);
		}
		return result;
	}

	async keep(reason: string): Promise<Proposal> {
		const trial = await this.registry.keepTrial(reason);
		const proposal = await loadProposal(this.paths, trial.proposalId);
		proposal.status = "kept";
		await saveProposal(this.paths, proposal);
		return proposal;
	}

	async pause(reason: string): Promise<void> {
		await this.registry.pause(reason);
	}

	async resume(reason: string): Promise<void> {
		await this.registry.resume(reason);
	}

	private async writeInbox(sessionId: string, kind: "NOTE" | "REQUEST", text: string): Promise<StoredInboxEntry> {
		const normalized = text.trim();
		if (!normalized) throw new Error(`${kind.toLowerCase()} text must not be empty`);
		const store = await createRecorderStore({
			paths: this.paths,
			sessionId,
			bundleDigest: await this.registry.readStableDigest(),
		});
		return store.writeInbox(`${kind}: ${normalized}`, "extension");
	}
}
