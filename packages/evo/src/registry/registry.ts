import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadCompiledBundle } from "../bundle/compile.ts";
import { isDigest } from "../bundle/schema.ts";
import { loadEvoComponentArtifact } from "../components/artifact.ts";
import { EvoMemoryStore, usesEvoComponentMemory } from "../components/memory/store.ts";
import { type EvoPaths, getEvoPaths } from "../paths.ts";
import { saveProposalRevisionSnapshot, validateEvaluationArtifact } from "../proposal-artifacts.ts";
import {
	appendJsonLine,
	atomicWriteFile,
	atomicWriteJson,
	canonicalJson,
	durableUnlink,
	readJsonIfExists,
	sha256,
	truncateIncompleteFinalLine,
	withFileLock,
} from "../storage.ts";
import type {
	CompiledBundle,
	DataApprovalActivation,
	EvoStatus,
	HistoryEntry,
	Proposal,
	ProposalStatus,
	TrialState,
} from "../types.ts";

async function readTextIfExists(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

export type RegistryTransitionAction =
	| "initialize"
	| "activate-trial"
	| "approve-data"
	| "approve-code"
	| "keep-trial"
	| "direct-keep-trial"
	| "keep-proposal"
	| "rollback"
	| "rollback-proposal"
	| "record-decision"
	| "record-deferral"
	| "record-reopen"
	| "reject-proposal"
	| "defer-proposal"
	| "reopen-proposal"
	| "pause"
	| "resume";

export type RegistryTransitionStep =
	| "prepared"
	| "trial-written"
	| "stable-written"
	| "paused-written"
	| "proposal-written"
	| "snapshot-written"
	| "history-appended"
	| "memory-rolled-back"
	| "trial-cleared"
	| "paused-cleared"
	| "receipt-appended"
	| "committed";

export interface BundleRegistryOptions {
	afterTransitionStep?: (step: RegistryTransitionStep, action: RegistryTransitionAction) => void | Promise<void>;
}

export interface RegistryOperationState {
	digest: string;
	latestOperationId?: string;
}

export interface RegistryMemoryLifecycleState {
	stableDigest: string | undefined;
	trial: TrialState | undefined;
	verifiedBundleLineage: readonly string[];
}

type HistoryTemplate = Omit<HistoryEntry, "eventId" | "timestamp">;

interface PendingTransition {
	schemaVersion: 1;
	operationId: string;
	requestKey: string;
	action: RegistryTransitionAction;
	createdAt: string;
	stableBefore: string | null;
	stableAfter: string | null;
	trialBefore: TrialState | null;
	trialAfter: TrialState | null;
	pausedBefore: string | null;
	pausedAfter: string | null;
	proposalBefore: Proposal | null;
	proposalAfter: Proposal | null;
	history: HistoryEntry[];
}

interface OperationReceipt {
	schemaVersion: 1;
	operationId: string;
	requestKey: string;
	action: RegistryTransitionAction;
	completedAt: string;
	stableBefore: string | null;
	stableAfter: string | null;
	trialBefore: TrialState | null;
	trialAfter: TrialState | null;
	proposalAfter: Proposal | null;
}

interface ProposalTransitionOptions {
	idempotencyKey?: string;
	expectedStateDigest?: string;
	action: "reject-proposal" | "defer-proposal" | "reopen-proposal";
	proposalBefore: Proposal;
	proposalAfter: Proposal;
	reason: string;
}

const TRANSITION_ACTIONS = new Set<RegistryTransitionAction>([
	"initialize",
	"activate-trial",
	"approve-data",
	"approve-code",
	"keep-trial",
	"direct-keep-trial",
	"keep-proposal",
	"rollback",
	"rollback-proposal",
	"record-decision",
	"record-deferral",
	"record-reopen",
	"reject-proposal",
	"defer-proposal",
	"reopen-proposal",
	"pause",
	"resume",
]);
const PROPOSAL_STATUSES = new Set<ProposalStatus>([
	"pending",
	"deferred",
	"approved",
	"rejected",
	"trialing",
	"kept",
	"rolled-back",
]);

function assertTrialState(value: unknown, label: string): asserts value is TrialState | null {
	if (value === null) return;
	if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
	const trial = value as Record<string, unknown>;
	if (
		typeof trial.digest !== "string" ||
		!isDigest(trial.digest) ||
		typeof trial.parent !== "string" ||
		!isDigest(trial.parent) ||
		typeof trial.proposalId !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(trial.proposalId) ||
		typeof trial.startedAt !== "string" ||
		!Number.isFinite(Date.parse(trial.startedAt)) ||
		typeof trial.plan !== "string" ||
		!trial.plan.trim() ||
		(trial.canary !== undefined &&
			(typeof trial.canary !== "object" ||
				trial.canary === null ||
				Array.isArray(trial.canary) ||
				((trial.canary as Record<string, unknown>).customization !== "default" &&
					(trial.canary as Record<string, unknown>).customization !== "custom") ||
				!Number.isSafeInteger((trial.canary as Record<string, unknown>).minimumSamples) ||
				((trial.canary as Record<string, unknown>).minimumSamples as number) <= 0 ||
				!Number.isSafeInteger((trial.canary as Record<string, unknown>).maximumDurationDays) ||
				((trial.canary as Record<string, unknown>).maximumDurationDays as number) <= 0))
	) {
		throw new Error(`${label} is invalid`);
	}
}

function assertProposalState(value: Proposal | null, label: string): void {
	if (value === null) return;
	if (
		value.schemaVersion !== 2 ||
		!/^p-[A-Za-z0-9._-]+$/.test(value.id) ||
		!Number.isSafeInteger(value.revision) ||
		value.revision <= 0 ||
		!isDigest(value.parentBundleDigest) ||
		!isDigest(value.diffDigest) ||
		!PROPOSAL_STATUSES.has(value.status)
	) {
		throw new Error(`${label} is invalid`);
	}
}

function isOperationId(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(value);
}

function assertOperationReceipt(value: OperationReceipt): void {
	if (
		value.schemaVersion !== 1 ||
		!isOperationId(value.operationId) ||
		!isDigest(value.requestKey) ||
		!TRANSITION_ACTIONS.has(value.action) ||
		!Number.isFinite(Date.parse(value.completedAt))
	) {
		throw new Error("registry/receipts.jsonl contains an invalid receipt");
	}
	for (const digest of [value.stableBefore, value.stableAfter]) {
		if (digest !== null && !isDigest(digest)) {
			throw new Error("registry/receipts.jsonl contains an invalid digest");
		}
	}
	assertTrialState(value.trialBefore, "Registry receipt trialBefore");
	assertTrialState(value.trialAfter, "Registry receipt trialAfter");
	assertProposalState(value.proposalAfter, "Registry receipt proposalAfter");
	if (value.trialAfter && value.stableAfter !== value.trialAfter.digest) {
		throw new Error("Registry receipt trial does not match its stable after-image");
	}
}

function receiptFromTransition(transition: PendingTransition): OperationReceipt {
	return {
		schemaVersion: 1,
		operationId: transition.operationId,
		requestKey: transition.requestKey,
		action: transition.action,
		completedAt: transition.createdAt,
		stableBefore: transition.stableBefore,
		stableAfter: transition.stableAfter,
		trialBefore: transition.trialBefore,
		trialAfter: transition.trialAfter,
		proposalAfter: transition.proposalAfter,
	};
}

function assertPendingTransition(value: PendingTransition): void {
	if (
		value.schemaVersion !== 1 ||
		!isOperationId(value.operationId) ||
		!isDigest(value.requestKey) ||
		!TRANSITION_ACTIONS.has(value.action) ||
		!Number.isFinite(Date.parse(value.createdAt)) ||
		!Array.isArray(value.history)
	) {
		throw new Error("registry/transition.json is invalid");
	}
	for (const [label, digest] of [
		["stableBefore", value.stableBefore],
		["stableAfter", value.stableAfter],
	] as const) {
		if (digest !== null && !isDigest(digest)) throw new Error(`Registry transition ${label} is invalid`);
	}
	assertTrialState(value.trialBefore, "Registry transition trialBefore");
	assertTrialState(value.trialAfter, "Registry transition trialAfter");
	assertProposalState(value.proposalBefore, "Registry transition proposalBefore");
	assertProposalState(value.proposalAfter, "Registry transition proposalAfter");
	if ((value.proposalBefore === null) !== (value.proposalAfter === null)) {
		throw new Error("Registry transition proposal before/after images disagree");
	}
	if (
		value.proposalBefore &&
		value.proposalAfter &&
		(value.proposalBefore.id !== value.proposalAfter.id ||
			value.proposalBefore.revision !== value.proposalAfter.revision ||
			value.proposalBefore.diffDigest !== value.proposalAfter.diffDigest)
	) {
		throw new Error("Registry transition proposal identity changed");
	}
	if (value.trialAfter && value.stableAfter !== value.trialAfter.digest) {
		throw new Error("Registry transition trial does not match its stable after-image");
	}
	for (const [index, entry] of value.history.entries()) {
		if (
			entry.eventId !== `${value.operationId}:${index}` ||
			entry.timestamp !== value.createdAt ||
			!entry.reason ||
			(entry.actor !== "human" && entry.actor !== "system")
		) {
			throw new Error("Registry transition history is invalid");
		}
	}
}

function sameState(left: unknown, right: unknown): boolean {
	return canonicalJson(left) === canonicalJson(right);
}

function transitionRequestKey(value: unknown): string {
	return sha256(canonicalJson(value));
}

async function rollbackBundleMemory(
	paths: EvoPaths,
	sourceBundleDigest: string,
	targetBundleDigest: string,
): Promise<void> {
	const lineage: CompiledBundle[] = [];
	let digest = sourceBundleDigest;
	const visited = new Set<string>();
	while (!visited.has(digest)) {
		visited.add(digest);
		const bundle = await loadCompiledBundle(paths, digest);
		lineage.push(bundle);
		if (digest === targetBundleDigest) break;
		if (!bundle.manifest.parentDigest) {
			throw new Error(`Rollback target ${targetBundleDigest} is not in the source bundle lineage`);
		}
		digest = bundle.manifest.parentDigest;
	}
	if (lineage.at(-1)?.digest !== targetBundleDigest) {
		throw new Error(`Rollback target ${targetBundleDigest} is not in the source bundle lineage`);
	}
	const targetIndex = lineage.length - 1;
	const targetAncestorBundleDigests: string[] = [];
	let ancestorDigest = lineage[targetIndex]?.manifest.parentDigest ?? null;
	while (ancestorDigest) {
		if (visited.has(ancestorDigest)) throw new Error("Rollback target ancestor lineage contains a cycle");
		visited.add(ancestorDigest);
		const ancestor = await loadCompiledBundle(paths, ancestorDigest);
		targetAncestorBundleDigests.push(ancestor.digest);
		ancestorDigest = ancestor.manifest.parentDigest;
	}
	const participants = new Map<string, { store: EvoMemoryStore; targetSelected: boolean }>();
	for (const [index, bundle] of lineage.entries()) {
		const selections = [
			...Object.entries(bundle.policy.components ?? {}).map(([surface, selection]) => ({ surface, selection })),
			...(bundle.policy.tools ?? []).map((selection) => ({ surface: "tool", selection })),
			...(bundle.policy.workflows ?? []).map((selection) => ({ surface: "workflow", selection })),
		];
		for (const { surface, selection } of selections) {
			const artifact = await loadEvoComponentArtifact(paths, selection.artifactDigest);
			if (artifact.manifest.id !== selection.id || artifact.manifest.abi !== selection.abi) {
				throw new Error(`Component selection identity changed before memory rollback: ${selection.id}`);
			}
			if (!usesEvoComponentMemory(surface, artifact.manifest.capabilities)) continue;
			const existing = participants.get(artifact.manifest.artifactDigest);
			if (existing) {
				if (index === targetIndex) existing.targetSelected = true;
				continue;
			}
			participants.set(artifact.manifest.artifactDigest, {
				store: new EvoMemoryStore({
					paths,
					componentId: artifact.manifest.id,
					artifactDigest: artifact.manifest.artifactDigest,
				}),
				targetSelected: index === targetIndex,
			});
		}
	}
	const rolledBackBundleDigests = lineage.slice(0, -1).map((bundle) => bundle.digest);
	for (const participant of participants.values()) {
		await participant.store.preflightBundleRollback({
			rolledBackBundleDigests,
			targetBundleDigest,
			targetAncestorBundleDigests,
			targetSelected: participant.targetSelected,
		});
	}
	for (const participant of participants.values()) {
		await participant.store.rollbackBundles({
			rolledBackBundleDigests,
			targetBundleDigest,
			targetAncestorBundleDigests,
			targetSelected: participant.targetSelected,
		});
	}
}

async function assertRequiredApprovalArtifact(
	paths: EvoPaths,
	proposal: Proposal,
	kind: "review" | "replay" | "validation",
): Promise<void> {
	const reference = proposal.artifacts[kind];
	if (!reference) throw new Error(`Proposal ${proposal.id} is missing required ${kind} artifact`);
	await validateEvaluationArtifact({
		paths,
		proposalId: proposal.id,
		revision: proposal.revision,
		diffDigest: proposal.diffDigest,
		kind,
		reference,
	});
}

export class BundleRegistry {
	readonly paths: EvoPaths;
	private readonly options: BundleRegistryOptions;

	constructor(paths: EvoPaths = getEvoPaths(), options: BundleRegistryOptions = {}) {
		this.paths = paths;
		this.options = options;
	}

	private async readStableDigestUnlocked(): Promise<string | undefined> {
		const digest = (await readTextIfExists(this.paths.stable))?.trim();
		if (!digest) return undefined;
		if (!isDigest(digest)) throw new Error("registry/stable contains an invalid digest");
		return digest;
	}

	async readStableDigest(): Promise<string | undefined> {
		return withFileLock(this.paths, "registry", async () => {
			await this.recoverPendingUnlocked();
			return this.readStableDigestUnlocked();
		});
	}

	private async readTrialUnlocked(): Promise<TrialState | undefined> {
		const trial = await readJsonIfExists<TrialState>(this.paths.trial);
		if (!trial) return undefined;
		assertTrialState(trial, "registry/trial.json");
		return trial;
	}

	async readTrial(): Promise<TrialState | undefined> {
		return withFileLock(this.paths, "registry", async () => {
			await this.recoverPendingUnlocked();
			return this.readTrialUnlocked();
		});
	}

	async withMemoryLifecycle<T>(operation: (state: RegistryMemoryLifecycleState) => Promise<T>): Promise<T> {
		return withFileLock(this.paths, "registry", async () => {
			await this.recoverPendingUnlocked();
			const stableDigest = await this.readStableDigestUnlocked();
			const trial = await this.readTrialUnlocked();
			const verifiedBundleLineage: string[] = [];
			const visited = new Set<string>();
			let digest = stableDigest;
			while (digest) {
				if (visited.has(digest)) throw new Error("Active bundle lineage contains a cycle");
				visited.add(digest);
				const bundle = await loadCompiledBundle(this.paths, digest);
				verifiedBundleLineage.push(bundle.digest);
				digest = bundle.manifest.parentDigest ?? undefined;
			}
			if (trial && (verifiedBundleLineage[0] !== trial.digest || verifiedBundleLineage[1] !== trial.parent)) {
				throw new Error("Active trial does not match the verified bundle lineage");
			}
			return operation({
				stableDigest,
				trial,
				verifiedBundleLineage,
			});
		});
	}

	private async readPausedUnlocked(): Promise<string | null> {
		return (await readTextIfExists(this.paths.paused)) ?? null;
	}

	private async readProposal(id: string): Promise<Proposal | null> {
		return (await readJsonIfExists<Proposal>(join(this.paths.proposals, id, "proposal.json"))) ?? null;
	}

	private withProposalLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
		return withFileLock(this.paths, `proposal-${id}`, operation, { staleAfterMs: 4 * 60 * 60 * 1000 });
	}

	private async afterStep(step: RegistryTransitionStep, action: RegistryTransitionAction): Promise<void> {
		await this.options.afterTransitionStep?.(step, action);
	}

	private async readHistory(): Promise<HistoryEntry[]> {
		const content = await readTextIfExists(this.paths.history);
		if (content === undefined || content === "") return [];
		if (!content.endsWith("\n")) throw new Error("registry/history.jsonl has an incomplete final line");
		return content
			.slice(0, -1)
			.split("\n")
			.map((line, index) => {
				let entry: HistoryEntry;
				try {
					entry = JSON.parse(line) as HistoryEntry;
				} catch {
					throw new Error(`registry/history.jsonl line ${index + 1} is invalid JSON`);
				}
				if (!entry.timestamp || !entry.action || !entry.reason) {
					throw new Error(`registry/history.jsonl line ${index + 1} is invalid`);
				}
				return entry;
			});
	}
	private async assertRollbackTargetAllowed(stableDigest: string, targetDigest: string): Promise<void> {
		if (!isDigest(stableDigest) || !isDigest(targetDigest)) throw new Error("Rollback target digest is invalid");
		const wasCommittedStable = (await this.readHistory()).some(
			(entry) =>
				entry.toDigest === targetDigest &&
				(entry.action === "initialize" ||
					entry.action === "trial-start" ||
					entry.action === "proposal-approved" ||
					entry.action === "rollback"),
		);
		if (!wasCommittedStable) {
			throw new Error(`Rollback target ${targetDigest} was never committed as stable`);
		}

		const visited = new Set<string>();
		let cursor = stableDigest;
		while (!visited.has(cursor)) {
			visited.add(cursor);
			const parent = (await loadCompiledBundle(this.paths, cursor)).manifest.parentDigest;
			if (!parent) break;
			if (parent === targetDigest) return;
			cursor = parent;
		}
		throw new Error(`Rollback target ${targetDigest} is not an ancestor of stable bundle ${stableDigest}`);
	}

	private async appendHistoryOnce(entry: HistoryEntry): Promise<void> {
		if (!entry.eventId) throw new Error("Transactional history entries require an eventId");
		const existing = (await this.readHistory()).find((candidate) => candidate.eventId === entry.eventId);
		if (existing) {
			if (!sameState(existing, entry)) throw new Error(`History event ${entry.eventId} has conflicting content`);
			return;
		}
		await appendJsonLine(this.paths.history, entry);
	}

	private async readReceipts(): Promise<OperationReceipt[]> {
		const content = await readTextIfExists(this.paths.receipts);
		if (content === undefined || content === "") return [];
		if (!content.endsWith("\n")) throw new Error("registry/receipts.jsonl has an incomplete final line");
		return content
			.slice(0, -1)
			.split("\n")
			.map((line, index) => {
				let receipt: OperationReceipt;
				try {
					receipt = JSON.parse(line) as OperationReceipt;
				} catch {
					throw new Error(`registry/receipts.jsonl line ${index + 1} is invalid JSON`);
				}
				assertOperationReceipt(receipt);
				return receipt;
			});
	}

	private async appendReceiptOnce(receipt: OperationReceipt): Promise<void> {
		assertOperationReceipt(receipt);
		const existing = (await this.readReceipts()).find((candidate) => candidate.operationId === receipt.operationId);
		if (existing) {
			if (!sameState(existing, receipt)) {
				throw new Error(`Operation receipt ${receipt.operationId} has conflicting content`);
			}
			return;
		}
		await appendJsonLine(this.paths.receipts, receipt);
	}

	private async readMatchingReceipt(
		operationId: string | undefined,
		action: RegistryTransitionAction,
		requestKey: string,
	): Promise<OperationReceipt | undefined> {
		if (operationId === undefined) return undefined;
		if (!isOperationId(operationId)) throw new Error("Invalid idempotency key");
		const receipt = (await this.readReceipts()).find((candidate) => candidate.operationId === operationId);
		if (!receipt) return undefined;
		if (receipt.action !== action || receipt.requestKey !== requestKey) {
			throw new Error(`Idempotency key ${operationId} was already used for another operation`);
		}
		return receipt;
	}

	private async readOperationStateUnlocked(): Promise<RegistryOperationState> {
		const [stable, trial, paused, receipts] = await Promise.all([
			this.readStableDigestUnlocked(),
			this.readTrialUnlocked(),
			this.readPausedUnlocked(),
			this.readReceipts(),
		]);
		const latestOperationId = receipts[receipts.length - 1]?.operationId;
		return {
			digest: transitionRequestKey({
				stable: stable ?? null,
				trial: trial ?? null,
				paused,
				latestOperationId: latestOperationId ?? null,
			}),
			...(latestOperationId ? { latestOperationId } : {}),
		};
	}

	async getOperationState(): Promise<RegistryOperationState> {
		return withFileLock(this.paths, "registry", async () => {
			await this.recoverPendingUnlocked();
			return this.readOperationStateUnlocked();
		});
	}

	private async assertExpectedOperationState(
		expectedStateDigest: string | undefined,
		idempotencyKey: string | undefined,
	): Promise<void> {
		if (expectedStateDigest === undefined) return;
		if (!isDigest(expectedStateDigest)) throw new Error("Invalid expected registry state digest");
		const current = await this.readOperationStateUnlocked();
		if (
			current.digest === expectedStateDigest ||
			(idempotencyKey !== undefined && current.latestOperationId === idempotencyKey)
		)
			return;
		throw new Error("Evo-Pi registry state changed before the operation; retry it against the current state");
	}

	private createTransition(options: {
		action: RegistryTransitionAction;
		requestKey: string;
		operationId?: string;
		stableBefore: string | null;
		stableAfter: string | null;
		trialBefore: TrialState | null;
		trialAfter: TrialState | null;
		pausedBefore: string | null;
		pausedAfter: string | null;
		proposalBefore?: Proposal | null;
		proposalAfter?: Proposal | null;
		history: HistoryTemplate[];
	}): PendingTransition {
		const operationId = options.operationId ?? randomUUID();
		const createdAt = new Date().toISOString();
		const transition: PendingTransition = {
			schemaVersion: 1,
			operationId,
			requestKey: options.requestKey,
			action: options.action,
			createdAt,
			stableBefore: options.stableBefore,
			stableAfter: options.stableAfter,
			trialBefore: options.trialBefore,
			trialAfter: options.trialAfter,
			pausedBefore: options.pausedBefore,
			pausedAfter: options.pausedAfter,
			proposalBefore: options.proposalBefore ?? null,
			proposalAfter: options.proposalAfter ?? null,
			history: options.history.map((entry, index) => ({
				...entry,
				eventId: `${operationId}:${index}`,
				timestamp: createdAt,
			})),
		};
		assertPendingTransition(transition);
		return transition;
	}

	private async assertTransitionState(transition: PendingTransition, allowAfterImage: boolean): Promise<void> {
		const proposalId = transition.proposalBefore?.id ?? transition.proposalAfter?.id;
		const [stable, trial, paused, proposal] = await Promise.all([
			this.readStableDigestUnlocked(),
			this.readTrialUnlocked(),
			this.readPausedUnlocked(),
			proposalId ? this.readProposal(proposalId) : Promise.resolve(null),
		]);
		for (const [label, current, before, after] of [
			["stable", stable ?? null, transition.stableBefore, transition.stableAfter],
			["trial", trial ?? null, transition.trialBefore, transition.trialAfter],
			["paused", paused, transition.pausedBefore, transition.pausedAfter],
			["proposal", proposal, transition.proposalBefore, transition.proposalAfter],
		] as const) {
			if (!sameState(current, before) && (!allowAfterImage || !sameState(current, after))) {
				throw new Error(`Registry transition found unexpected ${label} state; refusing to overwrite it`);
			}
		}
	}

	private async applyTransitionUnlocked(transition: PendingTransition): Promise<void> {
		assertPendingTransition(transition);
		await this.assertTransitionState(transition, true);
		if (transition.action === "rollback" || transition.action === "rollback-proposal") {
			if (!transition.stableBefore || !transition.stableAfter) {
				throw new Error("Rollback transition has incomplete stable state");
			}
			await this.assertRollbackTargetAllowed(transition.stableBefore, transition.stableAfter);
		}
		if (transition.stableAfter) await loadCompiledBundle(this.paths, transition.stableAfter);
		if (
			(transition.action === "rollback" || transition.action === "rollback-proposal") &&
			transition.stableBefore &&
			transition.stableAfter &&
			transition.stableBefore !== transition.stableAfter
		) {
			await rollbackBundleMemory(this.paths, transition.stableBefore, transition.stableAfter);
			await this.afterStep("memory-rolled-back", transition.action);
		}
		const [stable, trial, paused, proposal] = await Promise.all([
			this.readStableDigestUnlocked(),
			this.readTrialUnlocked(),
			this.readPausedUnlocked(),
			transition.proposalAfter ? this.readProposal(transition.proposalAfter.id) : Promise.resolve(null),
		]);

		if (transition.trialAfter && !sameState(trial ?? null, transition.trialAfter)) {
			await atomicWriteJson(this.paths.trial, transition.trialAfter);
			await this.afterStep("trial-written", transition.action);
		}
		if (transition.stableAfter && stable !== transition.stableAfter) {
			await atomicWriteFile(this.paths.stable, `${transition.stableAfter}\n`);
			await this.afterStep("stable-written", transition.action);
		}
		if (transition.pausedAfter !== null && paused !== transition.pausedAfter) {
			await atomicWriteFile(this.paths.paused, transition.pausedAfter);
			await this.afterStep("paused-written", transition.action);
		}
		if (transition.proposalAfter && !sameState(proposal, transition.proposalAfter)) {
			await atomicWriteJson(
				join(this.paths.proposals, transition.proposalAfter.id, "proposal.json"),
				transition.proposalAfter,
			);
			await this.afterStep("proposal-written", transition.action);
		}
		if (transition.proposalAfter) {
			await saveProposalRevisionSnapshot(this.paths, transition.proposalAfter);
			await this.afterStep("snapshot-written", transition.action);
		}
		for (const entry of transition.history) {
			await this.appendHistoryOnce(entry);
			await this.afterStep("history-appended", transition.action);
		}
		if (transition.trialAfter === null) {
			await durableUnlink(this.paths.trial);
			if (trial !== undefined) await this.afterStep("trial-cleared", transition.action);
		}
		if (transition.pausedAfter === null) {
			await durableUnlink(this.paths.paused);
			if (paused !== null) await this.afterStep("paused-cleared", transition.action);
		}
		await this.appendReceiptOnce(receiptFromTransition(transition));
		await this.afterStep("receipt-appended", transition.action);
		await durableUnlink(this.paths.transition);
		await this.afterStep("committed", transition.action);
	}

	private async executeTransitionUnlocked(transition: PendingTransition): Promise<void> {
		await this.assertTransitionState(transition, false);
		await atomicWriteJson(this.paths.transition, transition);
		await this.afterStep("prepared", transition.action);
		await this.applyTransitionUnlocked(transition);
	}

	private async readPendingTransition(): Promise<PendingTransition | undefined> {
		const transition = await readJsonIfExists<PendingTransition>(this.paths.transition);
		if (transition) assertPendingTransition(transition);
		return transition;
	}

	private async recoverPendingUnlocked(): Promise<PendingTransition | undefined> {
		const transition = await this.readPendingTransition();
		if (!transition) return undefined;
		await truncateIncompleteFinalLine(this.paths.history);
		await truncateIncompleteFinalLine(this.paths.receipts);
		const proposalId = transition.proposalBefore?.id ?? transition.proposalAfter?.id;
		if (proposalId) {
			await this.withProposalLock(proposalId, () => this.applyTransitionUnlocked(transition));
		} else {
			await this.applyTransitionUnlocked(transition);
		}
		return transition;
	}

	async recoverPendingTransition(): Promise<void> {
		await withFileLock(this.paths, "registry", async () => {
			await this.recoverPendingUnlocked();
		});
	}

	private async runHistoryTransitionUnlocked(
		action: "record-decision" | "record-deferral" | "record-reopen",
		requestKey: string,
		history: HistoryTemplate[],
	): Promise<void> {
		const recovered = await this.recoverPendingUnlocked();
		if (recovered?.action === action && recovered.requestKey === requestKey) return;
		const [stable, trial, paused] = await Promise.all([
			this.readStableDigestUnlocked(),
			this.readTrialUnlocked(),
			this.readPausedUnlocked(),
		]);
		await this.executeTransitionUnlocked(
			this.createTransition({
				action,
				requestKey,
				stableBefore: stable ?? null,
				stableAfter: stable ?? null,
				trialBefore: trial ?? null,
				trialAfter: trial ?? null,
				pausedBefore: paused,
				pausedAfter: paused,
				history,
			}),
		);
	}

	async initialize(digest: string, reason = "Initialize Evo-Pi registry"): Promise<void> {
		await withFileLock(this.paths, "registry", async () => {
			const requestKey = transitionRequestKey({ action: "initialize", digest, reason });
			const recovered = await this.recoverPendingUnlocked();
			if (recovered?.action === "initialize" && recovered.requestKey === requestKey) return;
			const stable = await this.readStableDigestUnlocked();
			if (stable) throw new Error("Evo-Pi registry is already initialized");
			const trial = await this.readTrialUnlocked();
			if (trial) throw new Error("Uninitialized registry cannot contain a trial");
			await loadCompiledBundle(this.paths, digest);
			const paused = await this.readPausedUnlocked();
			await this.executeTransitionUnlocked(
				this.createTransition({
					action: "initialize",
					requestKey,
					stableBefore: null,
					stableAfter: digest,
					trialBefore: null,
					trialAfter: null,
					pausedBefore: paused,
					pausedAfter: paused,
					history: [{ action: "initialize", actor: "human", toDigest: digest, reason }],
				}),
			);
		});
	}

	async activateTrial(options: { digest: string; proposalId: string; plan: string }): Promise<TrialState> {
		return withFileLock(this.paths, "registry", async () => {
			const requestKey = transitionRequestKey({
				action: "activate-trial",
				digest: options.digest,
				proposalId: options.proposalId,
				plan: options.plan,
			});
			const recovered = await this.recoverPendingUnlocked();
			if (recovered?.action === "activate-trial" && recovered.requestKey === requestKey) {
				if (!recovered.trialAfter) throw new Error("Recovered trial transition has no trial after-image");
				return recovered.trialAfter;
			}
			const stable = await this.readStableDigestUnlocked();
			if (!stable) throw new Error("Evo-Pi registry is not initialized");
			if (await this.readTrialUnlocked()) throw new Error("A trial is already active; keep or rollback it first");
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
			const paused = await this.readPausedUnlocked();
			await this.executeTransitionUnlocked(
				this.createTransition({
					action: "activate-trial",
					requestKey,
					stableBefore: stable,
					stableAfter: options.digest,
					trialBefore: null,
					trialAfter: trial,
					pausedBefore: paused,
					pausedAfter: paused,
					history: [
						{
							action: "trial-start",
							actor: "human",
							fromDigest: stable,
							toDigest: options.digest,
							proposalId: options.proposalId,
							reason: options.plan,
						},
					],
				}),
			);
			return trial;
		});
	}

	async approveDataProposal(options: {
		idempotencyKey?: string;
		expectedStateDigest?: string;
		proposalId: string;
		revision: number;
		diffDigest: string;
		parentDigest: string;
		candidateDigest: string;
		tier: "T0" | "T1" | "T2";
		plan: string;
		activation?: DataApprovalActivation;
		reason: string;
		proposalBefore: Proposal;
		proposalAfter: Proposal;
	}): Promise<{ proposal: Proposal; trial: TrialState | undefined }> {
		const activation: DataApprovalActivation = options.activation ?? { mode: "trial" };
		return withFileLock(this.paths, "registry", async () => {
			const requestKey = transitionRequestKey({
				action: "approve-data",
				proposalId: options.proposalId,
				revision: options.revision,
				diffDigest: options.diffDigest,
				parentDigest: options.parentDigest,
				candidateDigest: options.candidateDigest,
				tier: options.tier,
				plan: options.plan,
				activation,
				reason: options.reason,
			});
			const recovered = await this.recoverPendingUnlocked();
			const receipt = await this.readMatchingReceipt(options.idempotencyKey, "approve-data", requestKey);
			await this.assertExpectedOperationState(options.expectedStateDigest, options.idempotencyKey);
			if (receipt) {
				if (!receipt.proposalAfter) throw new Error("Approval receipt has no proposal after-image");
				return { proposal: receipt.proposalAfter, trial: receipt.trialAfter ?? undefined };
			}
			if (
				options.idempotencyKey === undefined &&
				recovered?.action === "approve-data" &&
				recovered.requestKey === requestKey
			) {
				if (!recovered.proposalAfter) throw new Error("Recovered approval has no proposal after-image");
				return { proposal: recovered.proposalAfter, trial: recovered.trialAfter ?? undefined };
			}
			return this.withProposalLock(options.proposalId, async () => {
				const current = await this.readProposal(options.proposalId);
				if (!sameState(current, options.proposalBefore)) {
					throw new Error("Proposal changed before registry approval; refusing to overwrite it");
				}
				if (
					options.proposalBefore.kind !== "data" ||
					options.proposalBefore.tier !== options.tier ||
					options.proposalBefore.id !== options.proposalId ||
					options.proposalBefore.revision !== options.revision ||
					options.proposalBefore.diffDigest !== options.diffDigest ||
					options.proposalBefore.parentBundleDigest !== options.parentDigest ||
					options.proposalBefore.candidateDigest !== options.candidateDigest
				) {
					throw new Error("Data approval options do not match the proposal");
				}
				if (options.proposalBefore.status !== "pending") {
					throw new Error(`Proposal ${options.proposalId} is ${options.proposalBefore.status}`);
				}
				if (options.tier !== "T0")
					await assertRequiredApprovalArtifact(this.paths, options.proposalBefore, "review");
				if (options.tier === "T2")
					await assertRequiredApprovalArtifact(this.paths, options.proposalBefore, "replay");
				if (activation.mode === "direct") {
					await assertRequiredApprovalArtifact(this.paths, options.proposalBefore, "validation");
				}
				if (activation.mode === "direct" && options.proposalBefore.targetAbi === undefined) {
					throw new Error("Direct activation is limited to an existing host-defined component ABI");
				}
				const direct = options.tier === "T0" || activation.mode === "direct";
				const expectedAfter = {
					...options.proposalBefore,
					status: direct ? ("kept" as const) : ("trialing" as const),
				};
				if (!sameState(options.proposalAfter, expectedAfter)) {
					throw new Error("Data approval proposal after-image is invalid");
				}
				const stable = await this.readStableDigestUnlocked();
				if (!stable) throw new Error("Evo-Pi registry is not initialized");
				if (stable !== options.parentDigest) {
					throw new Error("Proposal parent is no longer stable; regenerate or rebase the proposal");
				}
				if (await this.readTrialUnlocked()) throw new Error("A trial is already active; keep or rollback it first");
				const candidate = await loadCompiledBundle(this.paths, options.candidateDigest);
				if (candidate.manifest.parentDigest !== stable) {
					throw new Error("Candidate bundle parent does not match the stable bundle");
				}
				const trial = direct
					? undefined
					: {
							digest: options.candidateDigest,
							parent: stable,
							proposalId: options.proposalId,
							startedAt: new Date().toISOString(),
							plan: options.plan,
							...(activation.mode === "trial" && activation.canary ? { canary: activation.canary } : {}),
						};
				const paused = await this.readPausedUnlocked();
				const history: HistoryTemplate[] = [];
				if (trial) {
					history.push({
						action: "trial-start",
						actor: "human",
						fromDigest: stable,
						toDigest: options.candidateDigest,
						proposalId: options.proposalId,
						revision: options.revision,
						diffDigest: options.diffDigest,
						candidateDigest: options.candidateDigest,
						reason: options.plan,
					});
				} else if (activation.mode === "direct") {
					history.push({
						action: "human-direct-keep",
						actor: "human",
						fromDigest: stable,
						toDigest: options.candidateDigest,
						proposalId: options.proposalId,
						revision: options.revision,
						diffDigest: options.diffDigest,
						candidateDigest: options.candidateDigest,
						reason: "Human explicitly bypassed Canary after reviewing the exact validated component",
					});
				}
				history.push({
					action: "proposal-approved",
					actor: "human",
					fromDigest: stable,
					toDigest: options.candidateDigest,
					proposalId: options.proposalId,
					revision: options.revision,
					diffDigest: options.diffDigest,
					candidateDigest: options.candidateDigest,
					reason: options.reason,
				});
				await this.executeTransitionUnlocked(
					this.createTransition({
						action: "approve-data",
						requestKey,
						operationId: options.idempotencyKey,
						stableBefore: stable,
						stableAfter: options.candidateDigest,
						trialBefore: null,
						trialAfter: trial ?? null,
						pausedBefore: paused,
						pausedAfter: paused,
						proposalBefore: options.proposalBefore,
						proposalAfter: options.proposalAfter,
						history,
					}),
				);
				return { proposal: options.proposalAfter, trial };
			});
		});
	}

	async approveCodeProposal(options: {
		idempotencyKey?: string;
		proposalId: string;
		expectedStateDigest?: string;
		parentDigest: string;
		revision: number;
		diffDigest: string;
		approvalDigest: string;
		branch: string;
		reason: string;
		proposalBefore: Proposal;
		proposalAfter: Proposal;
	}): Promise<Proposal> {
		return withFileLock(this.paths, "registry", async () => {
			const requestKey = transitionRequestKey({
				action: "approve-code",
				proposalId: options.proposalId,
				parentDigest: options.parentDigest,
				revision: options.revision,
				diffDigest: options.diffDigest,
				approvalDigest: options.approvalDigest,
				branch: options.branch,
				reason: options.reason,
			});
			const recovered = await this.recoverPendingUnlocked();
			const receipt = await this.readMatchingReceipt(options.idempotencyKey, "approve-code", requestKey);
			await this.assertExpectedOperationState(options.expectedStateDigest, options.idempotencyKey);
			if (receipt) {
				if (!receipt.proposalAfter) throw new Error("Approval receipt has no proposal after-image");
				return receipt.proposalAfter;
			}
			if (
				options.idempotencyKey === undefined &&
				recovered?.action === "approve-code" &&
				recovered.requestKey === requestKey
			) {
				if (!recovered.proposalAfter) throw new Error("Recovered approval has no proposal after-image");
				return recovered.proposalAfter;
			}
			return this.withProposalLock(options.proposalId, async () => {
				const current = await this.readProposal(options.proposalId);
				if (!sameState(current, options.proposalBefore)) {
					throw new Error("Proposal changed before registry approval; refusing to overwrite it");
				}
				if (
					options.proposalBefore.id !== options.proposalId ||
					options.proposalBefore.kind !== "code" ||
					options.proposalBefore.tier !== "T2" ||
					options.proposalBefore.codeWorkspace?.branch !== options.branch ||
					options.proposalBefore.revision !== options.revision ||
					options.proposalBefore.diffDigest !== options.diffDigest ||
					options.proposalBefore.parentBundleDigest !== options.parentDigest ||
					options.proposalBefore.approvalDigest !== options.approvalDigest
				) {
					throw new Error("Code approval options do not match the proposal");
				}
				if (options.proposalBefore.status !== "pending") {
					throw new Error(`Proposal ${options.proposalId} is ${options.proposalBefore.status}`);
				}
				if (!options.proposalBefore.replayScenarios[0]) {
					throw new Error(`Code proposal ${options.proposalId} requires a replay scenario`);
				}
				await assertRequiredApprovalArtifact(this.paths, options.proposalBefore, "validation");
				await assertRequiredApprovalArtifact(this.paths, options.proposalBefore, "replay");
				await assertRequiredApprovalArtifact(this.paths, options.proposalBefore, "review");
				if (!sameState(options.proposalAfter, { ...options.proposalBefore, status: "approved" })) {
					throw new Error("Code approval proposal after-image is invalid");
				}
				const stable = await this.readStableDigestUnlocked();
				if (stable !== options.parentDigest) {
					throw new Error("Proposal parent is no longer stable; regenerate or rebase the proposal");
				}
				const trial = await this.readTrialUnlocked();
				const paused = await this.readPausedUnlocked();
				await this.executeTransitionUnlocked(
					this.createTransition({
						action: "approve-code",
						requestKey,
						operationId: options.idempotencyKey,
						stableBefore: stable,
						stableAfter: stable,
						trialBefore: trial ?? null,
						trialAfter: trial ?? null,
						pausedBefore: paused,
						pausedAfter: paused,
						proposalBefore: options.proposalBefore,
						proposalAfter: options.proposalAfter,
						history: [
							{
								action: "proposal-approved",
								actor: "human",
								fromDigest: stable,
								proposalId: options.proposalId,
								revision: options.revision,
								diffDigest: options.diffDigest,
								approvalDigest: options.approvalDigest,
								branch: options.branch,
								reason: options.reason,
							},
						],
					}),
				);
				return options.proposalAfter;
			});
		});
	}

	async keepTrial(reason: string): Promise<TrialState> {
		return withFileLock(this.paths, "registry", async () => {
			const requestKey = transitionRequestKey({ action: "keep-trial", reason });
			const recovered = await this.recoverPendingUnlocked();
			if (recovered?.action === "keep-trial" && recovered.requestKey === requestKey) {
				if (!recovered.trialBefore) throw new Error("Recovered keep transition has no trial before-image");
				return recovered.trialBefore;
			}
			const trial = await this.readTrialUnlocked();
			if (!trial) throw new Error("No trial is active");
			const stable = await this.readStableDigestUnlocked();
			if (stable !== trial.digest) throw new Error("Trial and stable pointer disagree");
			const paused = await this.readPausedUnlocked();
			await this.executeTransitionUnlocked(
				this.createTransition({
					action: "keep-trial",
					requestKey,
					stableBefore: stable,
					stableAfter: stable,
					trialBefore: trial,
					trialAfter: null,
					pausedBefore: paused,
					pausedAfter: paused,
					history: [
						{
							action: "trial-keep",
							actor: "human",
							fromDigest: trial.parent,
							toDigest: trial.digest,
							proposalId: trial.proposalId,
							reason,
						},
					],
				}),
			);
			return trial;
		});
	}

	async directKeepComponentTrial(options: {
		proposalId: string;
		reason: string;
		idempotencyKey?: string;
		expectedStateDigest?: string;
	}): Promise<Proposal> {
		return withFileLock(this.paths, "registry", async () => {
			const requestKey = transitionRequestKey({
				action: "direct-keep-trial",
				proposalId: options.proposalId,
				reason: options.reason,
			});
			const recovered = await this.recoverPendingUnlocked();
			const receipt = await this.readMatchingReceipt(options.idempotencyKey, "direct-keep-trial", requestKey);
			await this.assertExpectedOperationState(options.expectedStateDigest, options.idempotencyKey);
			if (receipt) {
				if (!receipt.proposalAfter) throw new Error("Direct keep receipt has no proposal after-image");
				return receipt.proposalAfter;
			}
			if (
				options.idempotencyKey === undefined &&
				recovered?.action === "direct-keep-trial" &&
				recovered.requestKey === requestKey
			) {
				if (!recovered.proposalAfter) throw new Error("Recovered direct keep has no proposal after-image");
				return recovered.proposalAfter;
			}
			const trial = await this.readTrialUnlocked();
			if (!trial || trial.proposalId !== options.proposalId) {
				throw new Error("The requested component Canary is not active");
			}
			const stable = await this.readStableDigestUnlocked();
			if (stable !== trial.digest) throw new Error("Component Canary and stable pointer disagree");
			return this.withProposalLock(options.proposalId, async () => {
				const proposal = await this.readProposal(options.proposalId);
				if (
					!proposal ||
					proposal.status !== "trialing" ||
					proposal.kind !== "data" ||
					proposal.targetAbi === undefined ||
					proposal.candidateDigest !== trial.digest
				) {
					throw new Error("Active trial is not a component proposal eligible for direct keep");
				}
				await assertRequiredApprovalArtifact(this.paths, proposal, "validation");
				const proposalAfter: Proposal = { ...proposal, status: "kept" };
				const paused = await this.readPausedUnlocked();
				await this.executeTransitionUnlocked(
					this.createTransition({
						action: "direct-keep-trial",
						requestKey,
						operationId: options.idempotencyKey,
						stableBefore: stable,
						stableAfter: stable,
						trialBefore: trial,
						trialAfter: null,
						pausedBefore: paused,
						pausedAfter: paused,
						proposalBefore: proposal,
						proposalAfter,
						history: [
							{
								action: "human-direct-keep",
								actor: "human",
								fromDigest: trial.parent,
								toDigest: trial.digest,
								proposalId: proposal.id,
								revision: proposal.revision,
								diffDigest: proposal.diffDigest,
								candidateDigest: proposal.candidateDigest,
								reason: options.reason,
							},
						],
					}),
				);
				return proposalAfter;
			});
		});
	}

	async keepProposal(
		reason: string,
		idempotencyKey?: string,
		expectedStateDigest?: string,
		expectedEvidenceDigest?: string,
	): Promise<Proposal> {
		return withFileLock(this.paths, "registry", async () => {
			const requestKey = transitionRequestKey({ action: "keep-proposal", reason });
			const recovered = await this.recoverPendingUnlocked();
			const receipt = await this.readMatchingReceipt(idempotencyKey, "keep-proposal", requestKey);
			await this.assertExpectedOperationState(expectedStateDigest, idempotencyKey);
			if (receipt) {
				if (!receipt.proposalAfter) throw new Error("Keep receipt has no proposal after-image");
				return receipt.proposalAfter;
			}
			if (
				idempotencyKey === undefined &&
				recovered?.action === "keep-proposal" &&
				recovered.requestKey === requestKey
			) {
				if (!recovered.proposalAfter) throw new Error("Recovered keep transition has no proposal after-image");
				return recovered.proposalAfter;
			}
			if (!expectedEvidenceDigest || !isDigest(expectedEvidenceDigest)) {
				throw new Error("Keeping a trial requires the current evidence snapshot digest");
			}
			const trial = await this.readTrialUnlocked();
			if (!trial) throw new Error("No trial is active");
			const stable = await this.readStableDigestUnlocked();
			if (stable !== trial.digest) throw new Error("Trial and stable pointer disagree");
			return this.withProposalLock(trial.proposalId, async () => {
				const proposal = await this.readProposal(trial.proposalId);
				if (!proposal) throw new Error(`Proposal ${trial.proposalId} does not exist`);
				if (proposal.status !== "trialing" || proposal.candidateDigest !== trial.digest) {
					throw new Error(`Proposal ${trial.proposalId} does not match the active trial`);
				}
				const retrospective = proposal.artifacts.retrospective;
				if (!retrospective?.evidence) {
					throw new Error(`Proposal ${proposal.id} is missing an evidence-bound retrospective`);
				}
				await validateEvaluationArtifact({
					paths: this.paths,
					proposalId: proposal.id,
					revision: proposal.revision,
					diffDigest: proposal.diffDigest,
					kind: "retrospective",
					reference: retrospective,
				});
				const proposalAfter: Proposal = { ...proposal, status: "kept" };
				if (retrospective.evidence.digest !== expectedEvidenceDigest) {
					throw new Error(`Proposal ${proposal.id} retrospective does not cover current evidence`);
				}
				const paused = await this.readPausedUnlocked();
				await this.executeTransitionUnlocked(
					this.createTransition({
						action: "keep-proposal",
						requestKey,
						operationId: idempotencyKey,
						stableBefore: stable,
						stableAfter: stable,
						trialBefore: trial,
						trialAfter: null,
						pausedBefore: paused,
						pausedAfter: paused,
						proposalBefore: proposal,
						proposalAfter,
						history: [
							{
								action: "trial-keep",
								actor: "human",
								fromDigest: trial.parent,
								toDigest: trial.digest,
								proposalId: trial.proposalId,
								evidenceDigest: retrospective.evidence.digest,
								comparisonDigest: proposal.artifacts.comparison?.evidence?.digest,
								reason,
							},
						],
					}),
				);
				return proposalAfter;
			});
		});
	}

	async rollback(
		targetDigest: string | undefined,
		reason: string,
		proposalId?: string,
	): Promise<{ from: string; to: string }> {
		return withFileLock(this.paths, "registry", async () => {
			const requestKey = transitionRequestKey({
				action: "rollback",
				targetDigest: targetDigest ?? null,
				reason,
				proposalId: proposalId ?? null,
			});
			const recovered = await this.recoverPendingUnlocked();
			if (recovered?.action === "rollback" && recovered.requestKey === requestKey) {
				if (!recovered.stableBefore || !recovered.stableAfter) {
					throw new Error("Recovered rollback transition has incomplete stable state");
				}
				return { from: recovered.stableBefore, to: recovered.stableAfter };
			}
			const stable = await this.readStableDigestUnlocked();
			if (!stable) throw new Error("Evo-Pi registry is not initialized");
			const trial = await this.readTrialUnlocked();
			const currentBundle = await loadCompiledBundle(this.paths, stable);
			const target =
				targetDigest ??
				(trial?.digest === stable ? trial.parent : (currentBundle.manifest.parentDigest ?? undefined));
			if (!target) throw new Error("Current bundle has no parent; provide an explicit rollback digest");
			if (target === stable) throw new Error("Rollback target is already stable");
			await this.assertRollbackTargetAllowed(stable, target);
			await loadCompiledBundle(this.paths, target);
			const paused = await this.readPausedUnlocked();
			await this.executeTransitionUnlocked(
				this.createTransition({
					action: "rollback",
					requestKey,
					stableBefore: stable,
					stableAfter: target,
					trialBefore: trial ?? null,
					trialAfter: null,
					pausedBefore: paused,
					pausedAfter: paused,
					history: [
						{
							action: "rollback",
							actor: "human",
							fromDigest: stable,
							toDigest: target,
							proposalId: trial?.proposalId ?? proposalId,
							reason,
						},
					],
				}),
			);
			return { from: stable, to: target };
		});
	}

	async rollbackProposal(
		targetDigest: string | undefined,
		reason: string,
		idempotencyKey?: string,
		expectedStateDigest?: string,
	): Promise<{ from: string; to: string; proposal?: Proposal }> {
		return withFileLock(this.paths, "registry", async () => {
			const requestKey = transitionRequestKey({
				action: "rollback-proposal",
				targetDigest: targetDigest ?? null,
				reason,
			});
			const recovered = await this.recoverPendingUnlocked();
			const receipt = await this.readMatchingReceipt(idempotencyKey, "rollback-proposal", requestKey);
			await this.assertExpectedOperationState(expectedStateDigest, idempotencyKey);
			if (receipt) {
				if (!receipt.stableBefore || !receipt.stableAfter) {
					throw new Error("Rollback receipt has incomplete stable state");
				}
				return {
					from: receipt.stableBefore,
					to: receipt.stableAfter,
					...(receipt.proposalAfter ? { proposal: receipt.proposalAfter } : {}),
				};
			}
			if (
				idempotencyKey === undefined &&
				recovered?.action === "rollback-proposal" &&
				recovered.requestKey === requestKey
			) {
				if (!recovered.stableBefore || !recovered.stableAfter) {
					throw new Error("Recovered rollback transition has incomplete stable state");
				}
				return {
					from: recovered.stableBefore,
					to: recovered.stableAfter,
					...(recovered.proposalAfter ? { proposal: recovered.proposalAfter } : {}),
				};
			}
			const stable = await this.readStableDigestUnlocked();
			if (!stable) throw new Error("Evo-Pi registry is not initialized");
			const trial = await this.readTrialUnlocked();
			const currentBundle = await loadCompiledBundle(this.paths, stable);
			const target =
				targetDigest ??
				(trial?.digest === stable ? trial.parent : (currentBundle.manifest.parentDigest ?? undefined));
			if (!target) throw new Error("Current bundle has no parent; provide an explicit rollback digest");
			if (target === stable) throw new Error("Rollback target is already stable");
			await this.assertRollbackTargetAllowed(stable, target);
			await loadCompiledBundle(this.paths, target);

			let proposalId = trial?.proposalId;
			if (!proposalId) {
				for (const entry of await readdir(this.paths.proposals, { withFileTypes: true })) {
					if (!entry.isDirectory() || !entry.name.startsWith("p-")) continue;
					const proposal = await this.readProposal(entry.name);
					if (proposal?.status === "kept" && proposal.candidateDigest === stable) {
						proposalId = proposal.id;
						break;
					}
				}
			}
			const paused = await this.readPausedUnlocked();
			const applyRollback = async (
				proposal: Proposal | null,
			): Promise<{ from: string; to: string; proposal?: Proposal }> => {
				if (proposal) {
					const expectedStatus = trial ? "trialing" : "kept";
					if (proposal.status !== expectedStatus || proposal.candidateDigest !== stable) {
						throw new Error(`Proposal ${proposal.id} does not match the rollback source`);
					}
				}
				const proposalAfter = proposal ? ({ ...proposal, status: "rolled-back" } satisfies Proposal) : null;
				await this.executeTransitionUnlocked(
					this.createTransition({
						action: "rollback-proposal",
						requestKey,
						operationId: idempotencyKey,
						stableBefore: stable,
						stableAfter: target,
						trialBefore: trial ?? null,
						trialAfter: null,
						pausedBefore: paused,
						pausedAfter: paused,
						proposalBefore: proposal,
						proposalAfter,
						history: [
							{
								action: "rollback",
								actor: "human",
								fromDigest: stable,
								toDigest: target,
								proposalId: proposal?.id ?? trial?.proposalId,
								evidenceDigest: proposal?.artifacts.retrospective?.evidence?.digest,
								comparisonDigest: proposal?.artifacts.comparison?.evidence?.digest,
								reason,
							},
						],
					}),
				);
				return { from: stable, to: target, ...(proposalAfter ? { proposal: proposalAfter } : {}) };
			};

			if (!proposalId) return applyRollback(null);
			return this.withProposalLock(proposalId, async () => applyRollback(await this.readProposal(proposalId)));
		});
	}

	async recordDecision(options: {
		proposalId: string;
		approved: boolean;
		reason: string;
		revision?: number;
		diffDigest?: string;
	}): Promise<void> {
		await withFileLock(this.paths, "registry", async () => {
			const requestKey = transitionRequestKey({
				action: "record-decision",
				proposalId: options.proposalId,
				approved: options.approved,
				revision: options.revision ?? null,
				diffDigest: options.diffDigest ?? null,
				reason: options.reason,
			});
			await this.runHistoryTransitionUnlocked("record-decision", requestKey, [
				{
					action: options.approved ? "proposal-approved" : "proposal-rejected",
					actor: "human",
					proposalId: options.proposalId,
					revision: options.revision,
					diffDigest: options.diffDigest,
					reason: options.reason,
				},
			]);
		});
	}

	async recordDeferral(options: {
		proposalId: string;
		revision: number;
		diffDigest: string;
		reason: string;
	}): Promise<void> {
		await withFileLock(this.paths, "registry", async () => {
			const requestKey = transitionRequestKey({
				action: "record-deferral",
				proposalId: options.proposalId,
				revision: options.revision,
				diffDigest: options.diffDigest,
				reason: options.reason,
			});
			await this.runHistoryTransitionUnlocked("record-deferral", requestKey, [
				{
					action: "proposal-deferred",
					actor: "human",
					proposalId: options.proposalId,
					revision: options.revision,
					diffDigest: options.diffDigest,
					reason: options.reason,
				},
			]);
		});
	}

	async recordReopen(options: {
		proposalId: string;
		revision: number;
		diffDigest: string;
		reason: string;
	}): Promise<void> {
		await withFileLock(this.paths, "registry", async () => {
			const requestKey = transitionRequestKey({
				action: "record-reopen",
				proposalId: options.proposalId,
				revision: options.revision,
				diffDigest: options.diffDigest,
				reason: options.reason,
			});
			await this.runHistoryTransitionUnlocked("record-reopen", requestKey, [
				{
					action: "proposal-reopened",
					actor: "human",
					proposalId: options.proposalId,
					revision: options.revision,
					diffDigest: options.diffDigest,
					reason: options.reason,
				},
			]);
		});
	}

	async transitionProposal(options: ProposalTransitionOptions): Promise<Proposal> {
		return withFileLock(this.paths, "registry", async () => {
			const requestKey = transitionRequestKey({
				action: options.action,
				proposalId: options.proposalBefore.id,
				revision: options.proposalBefore.revision,
				diffDigest: options.proposalBefore.diffDigest,
				reason: options.reason,
				until: options.action === "defer-proposal" ? (options.proposalAfter.defer?.until ?? null) : null,
			});
			const recovered = await this.recoverPendingUnlocked();
			const receipt = await this.readMatchingReceipt(options.idempotencyKey, options.action, requestKey);
			await this.assertExpectedOperationState(options.expectedStateDigest, options.idempotencyKey);
			if (receipt) {
				if (!receipt.proposalAfter) throw new Error("Decision receipt has no proposal after-image");
				return receipt.proposalAfter;
			}
			if (
				options.idempotencyKey === undefined &&
				recovered?.action === options.action &&
				recovered.requestKey === requestKey
			) {
				if (!recovered.proposalAfter) throw new Error("Recovered decision has no proposal after-image");
				return recovered.proposalAfter;
			}
			return this.withProposalLock(options.proposalBefore.id, async () => {
				const current = await this.readProposal(options.proposalBefore.id);
				if (!sameState(current, options.proposalBefore)) {
					throw new Error("Proposal changed before registry decision; refusing to overwrite it");
				}
				let historyAction: "proposal-rejected" | "proposal-deferred" | "proposal-reopened";
				let expectedAfter: Proposal;
				if (options.action === "reject-proposal") {
					if (options.proposalBefore.status !== "pending" && options.proposalBefore.status !== "deferred") {
						throw new Error(`Proposal ${options.proposalBefore.id} is ${options.proposalBefore.status}`);
					}
					expectedAfter = { ...options.proposalBefore, status: "rejected" };
					delete expectedAfter.defer;
					historyAction = "proposal-rejected";
				} else if (options.action === "defer-proposal") {
					if (options.proposalBefore.status !== "pending") {
						throw new Error(`Proposal ${options.proposalBefore.id} is ${options.proposalBefore.status}`);
					}
					if (!options.proposalAfter.defer || options.proposalAfter.defer.reason !== options.reason) {
						throw new Error("Deferred proposal after-image is invalid");
					}
					expectedAfter = {
						...options.proposalBefore,
						status: "deferred",
						defer: options.proposalAfter.defer,
					};
					historyAction = "proposal-deferred";
				} else {
					if (options.proposalBefore.status !== "deferred") {
						throw new Error(`Proposal ${options.proposalBefore.id} is ${options.proposalBefore.status}`);
					}
					expectedAfter = { ...options.proposalBefore, status: "pending" };
					delete expectedAfter.defer;
					historyAction = "proposal-reopened";
				}
				if (!sameState(expectedAfter, options.proposalAfter)) {
					throw new Error("Proposal decision after-image is invalid");
				}
				const [stable, trial, paused] = await Promise.all([
					this.readStableDigestUnlocked(),
					this.readTrialUnlocked(),
					this.readPausedUnlocked(),
				]);
				await this.executeTransitionUnlocked(
					this.createTransition({
						action: options.action,
						requestKey,
						stableBefore: stable ?? null,
						stableAfter: stable ?? null,
						operationId: options.idempotencyKey,
						trialBefore: trial ?? null,
						trialAfter: trial ?? null,
						pausedBefore: paused,
						pausedAfter: paused,
						proposalBefore: options.proposalBefore,
						proposalAfter: options.proposalAfter,
						history: [
							{
								action: historyAction,
								actor: "human",
								proposalId: options.proposalBefore.id,
								revision: options.proposalBefore.revision,
								diffDigest: options.proposalBefore.diffDigest,
								reason: options.reason,
							},
						],
					}),
				);
				return options.proposalAfter;
			});
		});
	}

	async pause(reason: string): Promise<void> {
		await withFileLock(this.paths, "registry", async () => {
			const requestKey = transitionRequestKey({ action: "pause", reason });
			const recovered = await this.recoverPendingUnlocked();
			if (recovered?.action === "pause" && recovered.requestKey === requestKey) return;
			const [stable, trial, paused] = await Promise.all([
				this.readStableDigestUnlocked(),
				this.readTrialUnlocked(),
				this.readPausedUnlocked(),
			]);
			await this.executeTransitionUnlocked(
				this.createTransition({
					action: "pause",
					requestKey,
					stableBefore: stable ?? null,
					stableAfter: stable ?? null,
					trialBefore: trial ?? null,
					trialAfter: trial ?? null,
					pausedBefore: paused,
					pausedAfter: `${new Date().toISOString()}\t${reason}\n`,
					history: [{ action: "pause", actor: "human", reason }],
				}),
			);
		});
	}

	async resume(reason: string): Promise<void> {
		await withFileLock(this.paths, "registry", async () => {
			const requestKey = transitionRequestKey({ action: "resume", reason });
			const recovered = await this.recoverPendingUnlocked();
			if (recovered?.action === "resume" && recovered.requestKey === requestKey) return;
			const [stable, trial, paused] = await Promise.all([
				this.readStableDigestUnlocked(),
				this.readTrialUnlocked(),
				this.readPausedUnlocked(),
			]);
			await this.executeTransitionUnlocked(
				this.createTransition({
					action: "resume",
					requestKey,
					stableBefore: stable ?? null,
					stableAfter: stable ?? null,
					trialBefore: trial ?? null,
					trialAfter: trial ?? null,
					pausedBefore: paused,
					pausedAfter: null,
					history: [{ action: "resume", actor: "human", reason }],
				}),
			);
		});
	}

	async isPaused(): Promise<boolean> {
		return withFileLock(this.paths, "registry", async () => {
			await this.recoverPendingUnlocked();
			return (await this.readPausedUnlocked()) !== null;
		});
	}

	async getStatus(): Promise<EvoStatus> {
		return withFileLock(this.paths, "registry", async () => {
			await this.recoverPendingUnlocked();
			let pendingProposals = 0;
			let deferredProposals = 0;
			for (const entry of await readdir(this.paths.proposals, { withFileTypes: true })) {
				if (!entry.isDirectory()) continue;
				try {
					const proposal = JSON.parse(
						await readFile(join(this.paths.proposals, entry.name, "proposal.json"), "utf8"),
					) as Proposal;
					if (proposal.status === "pending") pendingProposals++;
					if (proposal.status === "deferred") deferredProposals++;
				} catch (error) {
					if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT")
						throw error;
				}
			}
			const stableDigest = await this.readStableDigestUnlocked();
			return {
				initialized: stableDigest !== undefined,
				stableDigest,
				trial: await this.readTrialUnlocked(),
				pendingProposals,
				deferredProposals,
				paused: (await this.readPausedUnlocked()) !== null,
			};
		});
	}
}
