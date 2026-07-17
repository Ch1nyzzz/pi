import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { compileBundle, loadCompiledBundle } from "./bundle/compile.ts";
import { isDigest } from "./bundle/schema.ts";
import { storeTrialComparison, trialEvidenceDigest } from "./comparison.ts";
import { ensureEvolutionConfiguration } from "./evolve/config.ts";
import {
	applyInboxDecisions,
	garbageCollectInbox,
	type InboxGcResult,
	initializeInboxLifecycle,
	linkProposalInbox,
	readInboxEntry,
	readInboxLifecycleStates,
	reopenProposalInbox,
	resolveInboxEntry,
	settleProposalInbox,
} from "./inbox.ts";
import { deterministicPreferenceId, PREFERENCES_PATH, readBundlePreferenceMemory } from "./memory/preferences.ts";
import {
	type EvoBundleMigrationOptions,
	inferAgentDirectoryForEvoRoot,
	migratePiDataToBundleSource,
} from "./migration.ts";
import { type EvoPaths, ensureEvoLayout, getEvoPaths } from "./paths.ts";
import {
	approveProposal,
	deferProposal,
	loadProposal,
	proposalApproval,
	rejectProposal,
	reopenProposal,
	stageProposal,
} from "./proposal.ts";
import { createRecorderStore, readSessionLog, resolveStoredPayload, type StoredInboxEntry } from "./recorder/store.ts";
import { collectEvidenceCorpus } from "./reflect/evidence.ts";
import { BundleRegistry, type BundleRegistryOptions } from "./registry/registry.ts";
import { atomicWriteJson, canonicalJson, durableUnlink, readJsonIfExists, sha256, withFileLock } from "./storage.ts";
import type { CompiledBundle, DataApprovalActivation, EvoStatus, Proposal, ProposalApproval } from "./types.ts";

type ServiceIntentAction = "approve" | "reject" | "defer" | "reopen" | "keep" | "direct-keep" | "rollback";

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
		await ensureEvolutionConfiguration(this.paths);
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
		return this.writeInbox(sessionId, "NOTE", "note", text);
	}

	async request(sessionId: string, text: string): Promise<StoredInboxEntry> {
		return this.writeInbox(sessionId, "REQUEST", "request", text);
	}

	async preference(sessionId: string, text: string): Promise<StoredInboxEntry> {
		const normalized = text.trim();
		const inbox = await this.writeInbox(sessionId, "PREFERENCE", "preference", normalized);
		await applyInboxDecisions(
			this.paths,
			[
				{
					file: inbox.fileName,
					kind: "preference",
					instruction: normalized,
					reason: "User explicitly recorded a durable preference",
				},
			],
			new Set([inbox.fileName]),
		);
		await this.materializePreference(inbox.fileName);
		return inbox;
	}

	async materializePreference(file: string): Promise<Proposal | undefined> {
		const [entry, states, stable] = await Promise.all([
			readInboxEntry(this.paths, file),
			readInboxLifecycleStates(this.paths),
			this.registry.readStableDigest(),
		]);
		if (!stable) throw new Error("Evo-Pi registry is not initialized");
		const state = states.get(file) ?? (await initializeInboxLifecycle(this.paths, file));
		if (state.kind !== "preference" || !state.instruction) {
			throw new Error("Inbox entry is not an explicitly classified durable preference");
		}
		if (!entry.text.includes(state.instruction)) {
			throw new Error("Durable preference instruction is not an exact inbox substring");
		}
		const events = await readSessionLog(this.paths, entry.sessionId);
		const feedback = [...events]
			.reverse()
			.find((event) => event.type === "explicit_feedback" && event.inboxFile === file);
		if (!feedback || feedback.type !== "explicit_feedback") {
			throw new Error("Explicit durable preference has no recorder evidence event");
		}
		const quote = await resolveStoredPayload(this.paths, feedback.text);
		if (typeof quote !== "string" || !quote.includes(state.instruction)) {
			throw new Error("Recorder evidence does not contain the durable preference instruction");
		}
		const parent = await loadCompiledBundle(this.paths, stable);
		const memory = await readBundlePreferenceMemory(parent);
		if (memory.preferences.some((preference) => preference.instruction === state.instruction)) {
			await resolveInboxEntry(this.paths, file, "Preference was already active", "materialized");
			await garbageCollectInbox(this.paths);
			return undefined;
		}
		const id = deterministicPreferenceId(state.instruction);
		if (memory.preferences.some((preference) => preference.id === id)) {
			throw new Error(`Durable preference id collision: ${id}`);
		}
		const candidateMemory = {
			schemaVersion: 1 as const,
			preferences: [
				...memory.preferences,
				{
					id,
					instruction: state.instruction,
					source: { sessionId: entry.sessionId, sequence: feedback.sequence, quote },
					addedAt: new Date().toISOString(),
				},
			],
		};
		const proposal = await stageProposal({
			paths: this.paths,
			parentDigest: stable,
			draft: {
				motivation: "Materialize an explicit user-authored durable preference.",
				expectedEffect: "The trusted harness applies the preference across future sessions.",
				risk: "The user can remove the preference through the same trusted control path.",
				verifyPlan: "Compile the bundle and verify exact append-only preference provenance.",
				trialPlan: "No semantic experiment is required for an explicit user configuration change.",
				source: "explicit-request",
				evidence: [{ sessionId: entry.sessionId, sequence: feedback.sequence, quote }],
				inboxReferences: [file],
				replayScenarios: [],
				changes: [
					{
						path: PREFERENCES_PATH,
						content: `${JSON.stringify(candidateMemory, undefined, "\t")}\n`,
					},
				],
			},
			observationsMarkdown: "# Explicit durable preference\n\nMaterialized directly from exact user evidence.",
		});
		if (proposal.tier !== "T0") throw new Error("Explicit durable preference did not classify as T0");
		return this.approve(proposal.id, proposalApproval(proposal));
	}

	async forgetPreference(sessionId: string, preferenceId: string): Promise<StoredInboxEntry> {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(preferenceId)) {
			throw new Error("Preference id is invalid");
		}
		return this.writeInbox(
			sessionId,
			"REQUEST",
			"request",
			`Remove the active durable preference with id ${preferenceId}`,
		);
	}

	async gcInbox(dryRun = false): Promise<InboxGcResult> {
		return garbageCollectInbox(this.paths, dryRun);
	}

	async resolveInbox(file: string, reason: string): Promise<void> {
		await resolveInboxEntry(this.paths, file, reason);
		await garbageCollectInbox(this.paths);
	}

	async approve(id: string, expected: ProposalApproval): Promise<Proposal> {
		const proposal = await this.withIntent("approve", { id, expected }, (idempotencyKey, expectedStateDigest) =>
			approveProposal(this.paths, id, expected, undefined, this.registry, idempotencyKey, expectedStateDigest),
		);
		if (proposal.status === "kept") {
			await settleProposalInbox(this.paths, proposal);
			await garbageCollectInbox(this.paths);
		} else {
			await linkProposalInbox(this.paths, proposal);
		}
		return proposal;
	}

	async approveComponent(
		id: string,
		expected: ProposalApproval,
		activation: DataApprovalActivation,
	): Promise<Proposal> {
		const proposal = await this.withIntent(
			"approve",
			{ id, expected, activation },
			(idempotencyKey, expectedStateDigest) =>
				approveProposal(
					this.paths,
					id,
					expected,
					undefined,
					this.registry,
					idempotencyKey,
					expectedStateDigest,
					activation,
				),
		);
		if (proposal.status === "kept") {
			await settleProposalInbox(this.paths, proposal);
			await garbageCollectInbox(this.paths);
		} else {
			await linkProposalInbox(this.paths, proposal);
		}
		return proposal;
	}

	async reject(id: string, reason: string): Promise<Proposal> {
		const proposal = await this.withIntent("reject", { id, reason }, (idempotencyKey, expectedStateDigest) =>
			rejectProposal(this.paths, id, reason, this.registry, idempotencyKey, expectedStateDigest),
		);
		await reopenProposalInbox(this.paths, proposal, "Linked proposal was rejected; input remains open");
		return proposal;
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
				const trial = await this.registry.readTrial();
				if (trial) {
					await storeTrialComparison(this.paths, await loadProposal(this.paths, trial.proposalId), trial);
				}
				const { from, to } = await this.registry.rollbackProposal(
					targetDigest,
					reason,
					idempotencyKey,
					expectedStateDigest,
				);
				if (trial) {
					await reopenProposalInbox(
						this.paths,
						await loadProposal(this.paths, trial.proposalId),
						"Trial rolled back; linked input reopened",
					);
				}
				return { from, to };
			},
		);
	}

	async directKeepComponentTrial(proposalId: string, reason: string): Promise<Proposal> {
		const proposal = await this.withIntent(
			"direct-keep",
			{ proposalId, reason },
			(idempotencyKey, expectedStateDigest) =>
				this.registry.directKeepComponentTrial({
					proposalId,
					reason,
					idempotencyKey,
					expectedStateDigest,
				}),
		);
		await settleProposalInbox(this.paths, proposal);
		await garbageCollectInbox(this.paths);
		return proposal;
	}

	async keep(reason: string): Promise<Proposal> {
		return this.withIntent("keep", { reason }, async (idempotencyKey, expectedStateDigest) => {
			const trial = await this.registry.readTrial();
			let evidenceDigest: string | undefined;
			if (trial) {
				const proposal = await loadProposal(this.paths, trial.proposalId);
				const [corpus, storedComparison] = await Promise.all([
					collectEvidenceCorpus(this.paths, { mode: "full", completedSessionsOnly: true }),
					storeTrialComparison(this.paths, proposal, trial),
				]);
				evidenceDigest = trialEvidenceDigest(corpus.evidenceDigest, storedComparison.comparison.evidenceDigest);
			} else {
				const stable = await this.registry.readStableDigest();
				const completed = (await this.listProposals()).find(
					(proposal) => proposal.status === "kept" && proposal.candidateDigest === stable,
				);
				evidenceDigest = completed?.artifacts.retrospective?.evidence?.digest;
			}
			const proposal = await this.registry.keepProposal(reason, idempotencyKey, expectedStateDigest, evidenceDigest);
			await settleProposalInbox(this.paths, proposal);
			await garbageCollectInbox(this.paths);
			return proposal;
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

	private async writeInbox(
		sessionId: string,
		label: "NOTE" | "REQUEST" | "PREFERENCE",
		kind: "note" | "request" | "preference",
		text: string,
	): Promise<StoredInboxEntry> {
		const normalized = text.trim();
		if (!normalized) throw new Error(`${label.toLowerCase()} text must not be empty`);
		const store = await createRecorderStore({
			paths: this.paths,
			sessionId,
			bundleDigest: await this.registry.readStableDigest(),
		});
		const inbox = await store.writeInbox(`${label}: ${normalized}`, "extension", kind);
		await initializeInboxLifecycle(this.paths, inbox.fileName);
		if (kind === "preference") {
			await store.append({
				type: "explicit_feedback",
				source: "extension",
				text: await store.storePayload(normalized),
				inboxFile: inbox.fileName,
			});
		}
		return inbox;
	}
}
