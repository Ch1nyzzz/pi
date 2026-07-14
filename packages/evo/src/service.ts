import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { compileBundle, loadCompiledBundle } from "./bundle/compile.ts";
import { isDigest } from "./bundle/schema.ts";
import {
	type EvoBundleMigrationOptions,
	inferAgentDirectoryForEvoRoot,
	migratePiDataToBundleSource,
} from "./migration.ts";
import { type EvoPaths, ensureEvoLayout, getEvoPaths } from "./paths.ts";
import { approveProposal, deferProposal, loadProposal, rejectProposal, reopenProposal } from "./proposal.ts";
import { createRecorderStore, type StoredInboxEntry } from "./recorder/store.ts";
import { collectEvidenceCorpus } from "./reflect/evidence.ts";
import { BundleRegistry, type BundleRegistryOptions } from "./registry/registry.ts";
import { atomicWriteJson, canonicalJson, durableUnlink, readJsonIfExists, sha256, withFileLock } from "./storage.ts";
import type { CompiledBundle, EvoStatus, Proposal, ProposalApproval } from "./types.ts";

type ServiceIntentAction = "approve" | "reject" | "defer" | "reopen" | "keep" | "rollback";

interface ServiceIntent {
	schemaVersion: 2;
	action: ServiceIntentAction;
	payloadDigest: string;
	operationId: string;
	stateBeforeDigest: string;
	createdAt: string;
	completedAt?: string;
	completedStateDigest?: string;
}

function assertServiceIntent(
	value: unknown,
	action: ServiceIntentAction,
	payloadDigest: string,
): asserts value is ServiceIntent {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Stored Evo-Pi service intent is invalid");
	}
	const intent = value as Record<string, unknown>;
	if (
		intent.schemaVersion !== 2 ||
		intent.action !== action ||
		intent.payloadDigest !== payloadDigest ||
		typeof intent.operationId !== "string" ||
		!/^[A-Za-z0-9._:-]{1,256}$/.test(intent.operationId) ||
		typeof intent.stateBeforeDigest !== "string" ||
		!isDigest(intent.stateBeforeDigest) ||
		typeof intent.createdAt !== "string" ||
		!Number.isFinite(Date.parse(intent.createdAt)) ||
		(intent.completedAt !== undefined &&
			(typeof intent.completedAt !== "string" || !Number.isFinite(Date.parse(intent.completedAt)))) ||
		(intent.completedStateDigest !== undefined &&
			(typeof intent.completedStateDigest !== "string" || !isDigest(intent.completedStateDigest))) ||
		(intent.completedAt === undefined && intent.completedStateDigest !== undefined)
	) {
		throw new Error("Stored Evo-Pi service intent is invalid");
	}
}

export class EvoService {
	readonly paths: EvoPaths;
	readonly registry: BundleRegistry;

	constructor(paths: EvoPaths = getEvoPaths(), registryOptions: BundleRegistryOptions = {}) {
		this.paths = paths;
		this.registry = new BundleRegistry(paths, registryOptions);
	}

	async init(enabledTools?: string[], migrationSources?: EvoBundleMigrationOptions): Promise<CompiledBundle> {
		await this.registry.recoverPendingTransition();
		await ensureEvoLayout(this.paths);
		const existingDigest = await this.registry.readStableDigest();
		if (existingDigest) return loadCompiledBundle(this.paths, existingDigest);

		const sourceDirectory = await mkdtemp(join(this.paths.root, ".seed-"));
		try {
			const migration = await migratePiDataToBundleSource({
				bundleSourceDirectory: sourceDirectory,
				sources: migrationSources,
				defaultAgentDirectory: inferAgentDirectoryForEvoRoot(this.paths.root),
			});
			const corePromptPaths = migration.assets
				.filter((asset) => asset.kind === "custom-prompt" || asset.kind === "append-prompt")
				.map((asset) => asset.targetPath);
			await atomicWriteJson(join(sourceDirectory, "policy.json"), {
				schemaVersion: 1,
				...(enabledTools ? { enabledTools: [...new Set(enabledTools)].sort() } : {}),
				enabledFeatures: [],
				...(migration.promptPaths.length > 0
					? {
							promptOrder: migration.promptPaths,
							stablePromptPaths: migration.promptPaths,
						}
					: {}),
				coreAssets: corePromptPaths,
				modelRouting: {},
				validation: { requiredChecks: [] },
				...(migration.assets.length > 0 ? { managedSources: migration.assets } : {}),
			});
			const bundle = await compileBundle({
				paths: this.paths,
				sourceDirectory,
				parentDigest: null,
				summary:
					migration.assets.length > 0
						? "Initial Evo-Pi data bundle migrated from Pi resources"
						: "Initial empty Evo-Pi data bundle",
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

	async approve(id: string, expected: ProposalApproval): Promise<Proposal> {
		return this.withIntent("approve", { id, expected }, (idempotencyKey, expectedStateDigest) =>
			approveProposal(this.paths, id, expected, undefined, this.registry, idempotencyKey, expectedStateDigest),
		);
	}

	async reject(id: string, reason: string): Promise<Proposal> {
		return this.withIntent("reject", { id, reason }, (idempotencyKey, expectedStateDigest) =>
			rejectProposal(this.paths, id, reason, this.registry, idempotencyKey, expectedStateDigest),
		);
	}

	async defer(id: string, reason: string, until?: string): Promise<Proposal> {
		return this.withIntent("defer", { id, reason, until: until ?? null }, (idempotencyKey, expectedStateDigest) =>
			deferProposal(this.paths, id, reason, until, this.registry, idempotencyKey, expectedStateDigest),
		);
	}

	async reopen(id: string, reason: string): Promise<Proposal> {
		return this.withIntent("reopen", { id, reason }, (idempotencyKey, expectedStateDigest) =>
			reopenProposal(this.paths, id, reason, this.registry, idempotencyKey, expectedStateDigest),
		);
	}

	async rollback(targetDigest: string | undefined, reason: string): Promise<{ from: string; to: string }> {
		return this.withIntent(
			"rollback",
			{ targetDigest: targetDigest ?? null, reason },
			async (idempotencyKey, expectedStateDigest) => {
				const { from, to } = await this.registry.rollbackProposal(
					targetDigest,
					reason,
					idempotencyKey,
					expectedStateDigest,
				);
				return { from, to };
			},
		);
	}

	async keep(reason: string): Promise<Proposal> {
		return this.withIntent("keep", { reason }, async (idempotencyKey, expectedStateDigest) => {
			const corpus = await collectEvidenceCorpus(this.paths, { mode: "full" });
			return this.registry.keepProposal(reason, idempotencyKey, expectedStateDigest, corpus.evidenceDigest);
		});
	}

	async pause(reason: string): Promise<void> {
		await this.registry.pause(reason);
	}

	async resume(reason: string): Promise<void> {
		await this.registry.resume(reason);
	}

	private async withIntent<T>(
		action: ServiceIntentAction,
		payload: unknown,
		operation: (idempotencyKey: string, expectedStateDigest: string) => Promise<T>,
	): Promise<T> {
		const payloadDigest = sha256(canonicalJson({ action, payload }));
		const intentPath = join(this.paths.intents, `${action}-${payloadDigest}.json`);
		const lockName = `intent-${action}-${payloadDigest}`;
		const selected = await withFileLock(this.paths, lockName, async () => {
			const operationState = await this.registry.getOperationState();
			const existing = await readJsonIfExists<ServiceIntent>(intentPath);
			if (existing) {
				assertServiceIntent(existing, action, payloadDigest);
				const matchesState =
					existing.completedAt === undefined
						? existing.stateBeforeDigest === operationState.digest ||
							existing.operationId === operationState.latestOperationId
						: existing.completedStateDigest === operationState.digest;
				if (matchesState) {
					return { intent: existing, expectedStateDigest: operationState.digest };
				}
				await durableUnlink(intentPath);
			}
			const created: ServiceIntent = {
				schemaVersion: 2,
				action,
				payloadDigest,
				operationId: randomUUID(),
				stateBeforeDigest: operationState.digest,
				createdAt: new Date().toISOString(),
			};
			await atomicWriteJson(intentPath, created);
			return { intent: created, expectedStateDigest: operationState.digest };
		});
		const result = await operation(selected.intent.operationId, selected.expectedStateDigest);
		const completedState = await this.registry.getOperationState();
		await withFileLock(this.paths, lockName, async () => {
			const current = await readJsonIfExists<ServiceIntent>(intentPath);
			const completion = {
				completedAt: new Date().toISOString(),
				...(completedState.latestOperationId === selected.intent.operationId
					? { completedStateDigest: completedState.digest }
					: {}),
			};
			if (!current) {
				await atomicWriteJson(intentPath, { ...selected.intent, ...completion });
				return;
			}
			assertServiceIntent(current, action, payloadDigest);
			if (current.operationId !== selected.intent.operationId) {
				throw new Error("Evo-Pi service intent changed while the operation was running");
			}
			if (!current.completedAt) {
				await atomicWriteJson(intentPath, { ...current, ...completion });
			}
		});
		return result;
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
