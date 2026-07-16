import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { isDigest } from "../../bundle/schema.ts";
import type { EvoPaths } from "../../paths.ts";
import {
	appendRegularFileNoFollow,
	atomicWriteRegularFileNoFollow,
	durableUnlinkRegularFileNoFollow,
	ensurePrivateDirectoryNoFollow,
	readRegularFileNoFollow,
} from "../../secure-file.ts";
import { canonicalJson, sha256, withFileLock } from "../../storage.ts";
import type { EvoCapabilityComponentIdentity } from "../capabilities/service.ts";
import { assertEvoComponentId } from "../manifest.ts";

const MEMORY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_FRAGMENTS = 10_000;
const MAX_FRAGMENT_TEXT_CHARACTERS = 32_000;
const MAX_FRAGMENT_METADATA_BYTES = 64 * 1024;
const MAX_RETRIEVE_LIMIT = 100;
const MAX_TRANSACTION_ACTIONS = 16;
const MAX_TRANSACTION_AUDIT_ENTRIES = 16;

export type EvoMemoryNamespaceKind = "stable" | "trial";
export type EvoMemoryAuditOperation =
	| "initialize"
	| "trial-start"
	| "append"
	| "update"
	| "forget"
	| "promote"
	| "rollback";

export type EvoMemoryFaultPoint =
	| "after-outbox-write"
	| "after-pointer-action"
	| "after-audit-append"
	| "before-outbox-remove";

export interface EvoMemoryFragmentInput {
	id: string;
	text: string;
	metadata?: Record<string, unknown>;
}

export interface EvoMemoryFragment {
	id: string;
	text: string;
	metadata: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
}

export interface EvoMemorySnapshot {
	schemaVersion: 1;
	fragments: EvoMemoryFragment[];
}

export interface EvoMemoryReadResult {
	stateDigest: string;
	fragments: EvoMemoryFragment[];
}

export interface EvoMemoryMutationResult {
	stateDigest: string;
	fragment: EvoMemoryFragment | null;
}

export interface EvoMemoryRetrievedFragment extends EvoMemoryFragment {
	score: number;
}

export interface EvoMemoryRetrieveResult {
	stateDigest: string;
	fragments: EvoMemoryRetrievedFragment[];
}

export interface EvoMemoryAuditEntry {
	schemaVersion: 1;
	eventId: string;
	timestamp: string;
	componentId: string;
	artifactDigest: string;
	operation: EvoMemoryAuditOperation;
	namespace: EvoMemoryNamespaceKind;
	bundleDigest: string;
	parentBundleDigest: string | null;
	fragmentId: string | null;
	stateBefore: string | null;
	stateAfter: string | null;
}

export interface EvoMemoryStoreOptions {
	paths: EvoPaths;
	componentId: string;
	artifactDigest: string;
	root?: string;
	now?: () => string;
	randomId?: () => string;
	faultInjection?: (point: EvoMemoryFaultPoint) => void | Promise<void>;
}

export interface EvoMemoryTrialOptions {
	parentBundleDigest: string;
	trialBundleDigest: string;
}

export interface EvoMemoryBundleRollbackOptions {
	rolledBackBundleDigests: readonly string[];
	targetBundleDigest: string;
	targetAncestorBundleDigests: readonly string[];
	targetSelected: boolean;
}

export interface EvoMemoryStableMaterializationOptions {
	targetBundleDigest: string;
	targetAncestorBundleDigests: readonly string[];
}

const COMPONENT_MEMORY_CAPABILITIES = new Set(["memory-read", "memory-write", "retrieve"]);

export function usesEvoComponentMemory(surface: string, capabilities: readonly string[]): boolean {
	return surface === "memory" || capabilities.some((capability) => COMPONENT_MEMORY_CAPABILITIES.has(capability));
}

interface EvoMemoryNamespacePointer {
	schemaVersion: 1;
	kind: EvoMemoryNamespaceKind;
	bundleDigest: string;
	parentBundleDigest: string | null;
	stateDigest: string;
}

type EvoMemoryPointerLocation =
	| { kind: "stable" }
	| { kind: "trial"; bundleDigest: string }
	| { kind: "stable-history"; bundleDigest: string };

interface EvoMemoryPointerAction {
	location: EvoMemoryPointerLocation;
	before: EvoMemoryNamespacePointer | null;
	after: EvoMemoryNamespacePointer | null;
}

interface EvoMemoryTransaction {
	schemaVersion: 1;
	actions: EvoMemoryPointerAction[];
	auditEntries: EvoMemoryAuditEntry[];
}

interface EvoMemoryBundleRollbackState {
	stable?: EvoMemoryNamespacePointer;
	trials: EvoMemoryNamespacePointer[];
	target?: EvoMemoryNamespacePointer;
	targetTrial?: EvoMemoryNamespacePointer;
	targetTrialStateBefore?: string;
}

type EvoMemoryMutation =
	| { operation: "append"; fragment: EvoMemoryFragmentInput; expectedStateDigest?: string }
	| { operation: "update"; fragment: EvoMemoryFragmentInput; expectedStateDigest?: string }
	| { operation: "forget"; id: string; expectedStateDigest?: string };

function asRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
	const allowedKeys = new Set(allowed);
	for (const key of Object.keys(record)) {
		if (!allowedKeys.has(key)) throw new Error(`${label} has unknown key: ${key}`);
	}
}

function requireDigest(value: unknown, label: string): string {
	if (typeof value !== "string" || !isDigest(value)) throw new Error(`${label} must be a sha256 digest`);
	return value;
}

function parseBundleRollbackOptions(options: EvoMemoryBundleRollbackOptions): {
	rolledBackBundleDigests: string[];
	targetBundleDigest: string;
	targetAncestorBundleDigests: string[];
	targetSelected: boolean;
} {
	const targetBundleDigest = requireDigest(options.targetBundleDigest, "rollback target bundle digest");
	if (typeof options.targetSelected !== "boolean") throw new Error("rollback targetSelected must be a boolean");
	if (!Array.isArray(options.rolledBackBundleDigests) || options.rolledBackBundleDigests.length === 0) {
		throw new Error("rollback bundle lineage must not be empty");
	}
	const rolledBackBundleDigests = options.rolledBackBundleDigests.map((digest, index) =>
		requireDigest(digest, `rollback bundle lineage[${index}]`),
	);
	if (new Set(rolledBackBundleDigests).size !== rolledBackBundleDigests.length) {
		throw new Error("rollback bundle lineage must not contain duplicates");
	}
	if (rolledBackBundleDigests.includes(targetBundleDigest)) {
		throw new Error("rollback bundle lineage must not contain its target");
	}
	if (!Array.isArray(options.targetAncestorBundleDigests)) {
		throw new Error("rollback target ancestor lineage must be an array");
	}
	const targetAncestorBundleDigests = options.targetAncestorBundleDigests.map((digest, index) =>
		requireDigest(digest, `rollback target ancestor lineage[${index}]`),
	);
	if (new Set(targetAncestorBundleDigests).size !== targetAncestorBundleDigests.length) {
		throw new Error("rollback target ancestor lineage must not contain duplicates");
	}
	if (
		targetAncestorBundleDigests.includes(targetBundleDigest) ||
		targetAncestorBundleDigests.some((digest) => rolledBackBundleDigests.includes(digest))
	) {
		throw new Error("rollback target ancestor lineage overlaps the rollback lineage");
	}
	return {
		rolledBackBundleDigests,
		targetBundleDigest,
		targetAncestorBundleDigests,
		targetSelected: options.targetSelected,
	};
}

function requireMemoryId(value: unknown, label: string): string {
	if (typeof value !== "string" || !MEMORY_ID_PATTERN.test(value)) throw new Error(`${label} is invalid`);
	return value;
}

function requireTimestamp(value: unknown, label: string): string {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
		throw new Error(`${label} must be an ISO timestamp`);
	}
	return value;
}

function jsonRecord(value: unknown, label: string): Record<string, unknown> {
	const record = asRecord(value, label);
	const normalized = JSON.parse(canonicalJson(record)) as unknown;
	const result = asRecord(normalized, label);
	if (Buffer.byteLength(canonicalJson(result), "utf8") > MAX_FRAGMENT_METADATA_BYTES) {
		throw new Error(`${label} exceeds the metadata byte limit`);
	}
	return result;
}

export function parseEvoMemoryFragmentInput(value: unknown, label = "memory fragment"): EvoMemoryFragmentInput {
	const fragment = asRecord(value, label);
	rejectUnknownKeys(fragment, ["id", "text", "metadata"], label);
	const id = requireMemoryId(fragment.id, `${label}.id`);
	if (
		typeof fragment.text !== "string" ||
		!fragment.text.trim() ||
		fragment.text !== fragment.text.trim() ||
		fragment.text.length > MAX_FRAGMENT_TEXT_CHARACTERS
	) {
		throw new Error(`${label}.text must be trimmed and contain 1-${MAX_FRAGMENT_TEXT_CHARACTERS} characters`);
	}
	return {
		id,
		text: fragment.text,
		...(fragment.metadata === undefined ? {} : { metadata: jsonRecord(fragment.metadata, `${label}.metadata`) }),
	};
}

function parseFragment(value: unknown, label: string): EvoMemoryFragment {
	const fragment = asRecord(value, label);
	rejectUnknownKeys(fragment, ["id", "text", "metadata", "createdAt", "updatedAt"], label);
	const input = parseEvoMemoryFragmentInput(
		{ id: fragment.id, text: fragment.text, metadata: fragment.metadata },
		label,
	);
	return {
		...input,
		metadata: input.metadata ?? {},
		createdAt: requireTimestamp(fragment.createdAt, `${label}.createdAt`),
		updatedAt: requireTimestamp(fragment.updatedAt, `${label}.updatedAt`),
	};
}

function parseSnapshot(value: unknown, label: string): EvoMemorySnapshot {
	const snapshot = asRecord(value, label);
	rejectUnknownKeys(snapshot, ["schemaVersion", "fragments"], label);
	if (snapshot.schemaVersion !== 1) throw new Error(`${label}.schemaVersion must be 1`);
	if (!Array.isArray(snapshot.fragments) || snapshot.fragments.length > MAX_FRAGMENTS) {
		throw new Error(`${label}.fragments must contain at most ${MAX_FRAGMENTS} entries`);
	}
	const fragments = snapshot.fragments.map((fragment, index) =>
		parseFragment(fragment, `${label}.fragments[${index}]`),
	);
	if (new Set(fragments.map((fragment) => fragment.id)).size !== fragments.length) {
		throw new Error(`${label}.fragments contains duplicate ids`);
	}
	const sorted = [...fragments].sort((left, right) => left.id.localeCompare(right.id));
	if (fragments.some((fragment, index) => fragment.id !== sorted[index]?.id)) {
		throw new Error(`${label}.fragments must be sorted by id`);
	}
	return { schemaVersion: 1, fragments };
}

function parsePointer(value: unknown, label: string): EvoMemoryNamespacePointer {
	const pointer = asRecord(value, label);
	rejectUnknownKeys(pointer, ["schemaVersion", "kind", "bundleDigest", "parentBundleDigest", "stateDigest"], label);
	if (pointer.schemaVersion !== 1) throw new Error(`${label}.schemaVersion must be 1`);
	if (pointer.kind !== "stable" && pointer.kind !== "trial") throw new Error(`${label}.kind is invalid`);
	const bundleDigest = requireDigest(pointer.bundleDigest, `${label}.bundleDigest`);
	const stateDigest = requireDigest(pointer.stateDigest, `${label}.stateDigest`);
	let parentBundleDigest: string | null;
	if (pointer.kind === "stable") {
		if (pointer.parentBundleDigest !== null) throw new Error(`${label}.parentBundleDigest must be null for stable`);
		parentBundleDigest = null;
	} else {
		parentBundleDigest = requireDigest(pointer.parentBundleDigest, `${label}.parentBundleDigest`);
		if (parentBundleDigest === bundleDigest) throw new Error(`${label} trial must differ from its parent bundle`);
	}
	return { schemaVersion: 1, kind: pointer.kind, bundleDigest, parentBundleDigest, stateDigest };
}

const AUDIT_OPERATIONS = new Set<EvoMemoryAuditOperation>([
	"initialize",
	"trial-start",
	"append",
	"update",
	"forget",
	"promote",
	"rollback",
]);

function parseAuditEntry(value: unknown, label: string): EvoMemoryAuditEntry {
	const entry = asRecord(value, label);
	rejectUnknownKeys(
		entry,
		[
			"schemaVersion",
			"eventId",
			"timestamp",
			"componentId",
			"artifactDigest",
			"operation",
			"namespace",
			"bundleDigest",
			"parentBundleDigest",
			"fragmentId",
			"stateBefore",
			"stateAfter",
		],
		label,
	);
	if (entry.schemaVersion !== 1) throw new Error(`${label}.schemaVersion must be 1`);
	if (typeof entry.eventId !== "string" || !MEMORY_ID_PATTERN.test(entry.eventId)) {
		throw new Error(`${label}.eventId is invalid`);
	}
	if (typeof entry.componentId !== "string") throw new Error(`${label}.componentId must be a string`);
	assertEvoComponentId(entry.componentId, `${label}.componentId`);
	if (typeof entry.operation !== "string" || !AUDIT_OPERATIONS.has(entry.operation as EvoMemoryAuditOperation)) {
		throw new Error(`${label}.operation is invalid`);
	}
	if (entry.namespace !== "stable" && entry.namespace !== "trial") {
		throw new Error(`${label}.namespace is invalid`);
	}
	const optionalDigest = (field: "parentBundleDigest" | "stateBefore" | "stateAfter"): string | null =>
		entry[field] === null ? null : requireDigest(entry[field], `${label}.${field}`);
	return {
		schemaVersion: 1,
		eventId: entry.eventId,
		timestamp: requireTimestamp(entry.timestamp, `${label}.timestamp`),
		componentId: entry.componentId,
		artifactDigest: requireDigest(entry.artifactDigest, `${label}.artifactDigest`),
		operation: entry.operation as EvoMemoryAuditOperation,
		namespace: entry.namespace,
		bundleDigest: requireDigest(entry.bundleDigest, `${label}.bundleDigest`),
		parentBundleDigest: optionalDigest("parentBundleDigest"),
		fragmentId: entry.fragmentId === null ? null : requireMemoryId(entry.fragmentId, `${label}.fragmentId`),
		stateBefore: optionalDigest("stateBefore"),
		stateAfter: optionalDigest("stateAfter"),
	};
}

function pointerEquals(
	left: EvoMemoryNamespacePointer | null | undefined,
	right: EvoMemoryNamespacePointer | null | undefined,
): boolean {
	return canonicalJson(left ?? null) === canonicalJson(right ?? null);
}

function parsePointerLocation(value: unknown, label: string): EvoMemoryPointerLocation {
	const location = asRecord(value, label);
	if (location.kind === "stable") {
		rejectUnknownKeys(location, ["kind"], label);
		return { kind: "stable" };
	}
	if (location.kind === "trial" || location.kind === "stable-history") {
		rejectUnknownKeys(location, ["kind", "bundleDigest"], label);
		return {
			kind: location.kind,
			bundleDigest: requireDigest(location.bundleDigest, `${label}.bundleDigest`),
		};
	}
	throw new Error(`${label}.kind is invalid`);
}

function assertPointerMatchesLocation(
	pointer: EvoMemoryNamespacePointer | null,
	location: EvoMemoryPointerLocation,
	label: string,
): void {
	if (!pointer) return;
	if (location.kind === "stable") {
		if (pointer.kind !== "stable") throw new Error(`${label} must contain a stable pointer`);
		return;
	}
	if (location.kind === "trial") {
		if (pointer.kind !== "trial" || pointer.bundleDigest !== location.bundleDigest) {
			throw new Error(`${label} does not match its trial location`);
		}
		return;
	}
	if (pointer.kind !== "stable" || pointer.bundleDigest !== location.bundleDigest) {
		throw new Error(`${label} does not match its stable history location`);
	}
}

function parsePointerAction(value: unknown, label: string): EvoMemoryPointerAction {
	const action = asRecord(value, label);
	rejectUnknownKeys(action, ["location", "before", "after"], label);
	const location = parsePointerLocation(action.location, `${label}.location`);
	const before = action.before === null ? null : parsePointer(action.before, `${label}.before`);
	const after = action.after === null ? null : parsePointer(action.after, `${label}.after`);
	if (!before && !after) throw new Error(`${label} must change a pointer`);
	if (pointerEquals(before, after)) throw new Error(`${label} must change pointer state`);
	assertPointerMatchesLocation(before, location, `${label}.before`);
	assertPointerMatchesLocation(after, location, `${label}.after`);
	return { location, before, after };
}

function parseTransaction(value: unknown, label: string): EvoMemoryTransaction {
	const transaction = asRecord(value, label);
	rejectUnknownKeys(transaction, ["schemaVersion", "actions", "auditEntries"], label);
	if (transaction.schemaVersion !== 1) throw new Error(`${label}.schemaVersion must be 1`);
	if (!Array.isArray(transaction.actions) || transaction.actions.length > MAX_TRANSACTION_ACTIONS) {
		throw new Error(`${label}.actions must contain at most ${MAX_TRANSACTION_ACTIONS} entries`);
	}
	if (!Array.isArray(transaction.auditEntries) || transaction.auditEntries.length > MAX_TRANSACTION_AUDIT_ENTRIES) {
		throw new Error(`${label}.auditEntries must contain at most ${MAX_TRANSACTION_AUDIT_ENTRIES} entries`);
	}
	const actions = transaction.actions.map((action, index) => parsePointerAction(action, `${label}.actions[${index}]`));
	const auditEntries = transaction.auditEntries.map((entry, index) =>
		parseAuditEntry(entry, `${label}.auditEntries[${index}]`),
	);
	if (actions.length === 0 && auditEntries.length === 0) throw new Error(`${label} must not be empty`);
	if (new Set(auditEntries.map((entry) => entry.eventId)).size !== auditEntries.length) {
		throw new Error(`${label}.auditEntries contains duplicate event ids`);
	}
	return { schemaVersion: 1, actions, auditEntries };
}

function fileMissing(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function readRegularFileIfExists(path: string, label: string): Promise<string | undefined> {
	try {
		return (await readRegularFileNoFollow(path, label)).toString("utf8");
	} catch (error) {
		if (fileMissing(error)) return undefined;
		throw error;
	}
}

async function atomicWriteJsonNoFollow(path: string, value: unknown, label: string): Promise<void> {
	await atomicWriteRegularFileNoFollow(path, `${JSON.stringify(value, undefined, "\t")}\n`, label);
}

function cloneFragment(fragment: EvoMemoryFragment): EvoMemoryFragment {
	return parseFragment(JSON.parse(canonicalJson(fragment)) as unknown, "memory fragment");
}

function tokenize(value: string): Set<string> {
	return new Set(
		value
			.toLocaleLowerCase("en-US")
			.split(/[^\p{L}\p{N}]+/u)
			.filter(Boolean),
	);
}

export class EvoMemoryStore {
	readonly componentId: string;
	readonly artifactDigest: string;
	readonly root: string;
	private readonly paths: EvoPaths;
	private readonly namespaceRoot: string;
	private readonly objectsRoot: string;
	private readonly stableHistoryRoot: string;
	private readonly trialsRoot: string;
	private readonly stablePath: string;
	private readonly auditPath: string;
	private readonly transactionPath: string;
	private readonly lockName: string;
	private readonly layoutAnchor: string | undefined;
	private readonly now: () => string;
	private readonly randomId: () => string;
	private readonly faultInjection: ((point: EvoMemoryFaultPoint) => void | Promise<void>) | undefined;

	constructor(options: EvoMemoryStoreOptions) {
		assertEvoComponentId(options.componentId);
		if (!isDigest(options.artifactDigest)) throw new Error("artifactDigest must be a sha256 digest");
		this.paths = options.paths;
		this.componentId = options.componentId;
		this.artifactDigest = options.artifactDigest;
		this.root = resolve(options.root ?? join(options.paths.root, "component-memory"));
		this.layoutAnchor = options.root === undefined ? resolve(options.paths.root) : undefined;
		this.namespaceRoot = join(this.root, "namespaces", this.componentId, this.artifactDigest);
		this.objectsRoot = join(this.namespaceRoot, "objects", "sha256");
		this.stableHistoryRoot = join(this.namespaceRoot, "stable-history");
		this.trialsRoot = join(this.namespaceRoot, "trials");
		this.stablePath = join(this.namespaceRoot, "stable.json");
		this.auditPath = join(this.namespaceRoot, "audit.jsonl");
		this.transactionPath = join(this.namespaceRoot, "transaction.json");
		this.lockName = `memory-${sha256(`${this.componentId}\0${this.artifactDigest}`).slice(0, 32)}`;
		this.now = options.now ?? (() => new Date().toISOString());
		this.randomId = options.randomId ?? randomUUID;
		this.faultInjection = options.faultInjection;
	}

	private async ensureLayout(): Promise<void> {
		if (!this.layoutAnchor) {
			await ensurePrivateDirectoryNoFollow(this.root, "component memory root");
		}
		const trustedRoot = this.layoutAnchor ?? this.root;
		for (const directory of [
			this.root,
			join(this.root, "namespaces"),
			this.namespaceRoot,
			this.objectsRoot,
			this.stableHistoryRoot,
			this.trialsRoot,
		]) {
			await ensurePrivateDirectoryNoFollow(directory, "component memory directory", trustedRoot);
		}
	}

	private trialPath(bundleDigest: string): string {
		return join(this.trialsRoot, `${requireDigest(bundleDigest, "trial bundle digest")}.json`);
	}

	private stableHistoryPath(bundleDigest: string): string {
		return join(this.stableHistoryRoot, `${requireDigest(bundleDigest, "stable bundle digest")}.json`);
	}

	private pointerPath(kind: EvoMemoryNamespaceKind, bundleDigest: string): string {
		return kind === "stable" ? this.stablePath : this.trialPath(bundleDigest);
	}

	private async readPointer(path: string, label: string): Promise<EvoMemoryNamespacePointer | undefined> {
		const content = await readRegularFileIfExists(path, label);
		if (content === undefined) return undefined;
		let value: unknown;
		try {
			value = JSON.parse(content) as unknown;
		} catch (error) {
			throw new Error(`${label} contains invalid JSON`, { cause: error });
		}
		return parsePointer(value, label);
	}

	private async writeSnapshot(snapshot: EvoMemorySnapshot): Promise<string> {
		const parsed = parseSnapshot(snapshot, "memory snapshot");
		const digest = sha256(canonicalJson(parsed));
		const path = join(this.objectsRoot, `${digest}.json`);
		const existing = await readRegularFileIfExists(path, `memory object ${digest}`);
		if (existing !== undefined) {
			let value: unknown;
			try {
				value = JSON.parse(existing) as unknown;
			} catch (error) {
				throw new Error(`memory object ${digest} contains invalid JSON`, { cause: error });
			}
			const persisted = parseSnapshot(value, `memory object ${digest}`);
			if (sha256(canonicalJson(persisted)) !== digest)
				throw new Error(`memory object ${digest} failed digest verification`);
			return digest;
		}
		await atomicWriteJsonNoFollow(path, parsed, `memory object ${digest}`);
		return digest;
	}

	private async readSnapshot(stateDigest: string): Promise<EvoMemorySnapshot> {
		const digest = requireDigest(stateDigest, "memory state digest");
		const label = `memory object ${digest}`;
		const content = await readRegularFileIfExists(join(this.objectsRoot, `${digest}.json`), label);
		if (content === undefined) throw new Error(`${label} does not exist`);
		let value: unknown;
		try {
			value = JSON.parse(content) as unknown;
		} catch (error) {
			throw new Error(`${label} contains invalid JSON`, { cause: error });
		}
		const snapshot = parseSnapshot(value, label);
		if (sha256(canonicalJson(snapshot)) !== digest) throw new Error(`${label} failed digest verification`);
		return snapshot;
	}

	private timestamp(): string {
		return requireTimestamp(this.now(), "memory timestamp");
	}

	private eventId(): string {
		return requireMemoryId(this.randomId(), "memory audit event id");
	}

	private createAuditEntry(
		operation: EvoMemoryAuditOperation,
		pointer: EvoMemoryNamespacePointer,
		fragmentId: string | null,
		stateBefore: string | null,
		stateAfter: string | null,
	): EvoMemoryAuditEntry {
		return {
			schemaVersion: 1,
			eventId: this.eventId(),
			timestamp: this.timestamp(),
			componentId: this.componentId,
			artifactDigest: this.artifactDigest,
			operation,
			namespace: pointer.kind,
			bundleDigest: pointer.bundleDigest,
			parentBundleDigest: pointer.parentBundleDigest,
			fragmentId,
			stateBefore,
			stateAfter,
		};
	}

	private async repairAuditTail(): Promise<void> {
		const content = await readRegularFileIfExists(this.auditPath, "memory audit log");
		if (content === undefined || !content || content.endsWith("\n")) return;
		const finalNewline = content.lastIndexOf("\n");
		await atomicWriteRegularFileNoFollow(this.auditPath, content.slice(0, finalNewline + 1), "memory audit log");
	}

	private async readAuditEntries(): Promise<EvoMemoryAuditEntry[]> {
		await this.repairAuditTail();
		const content = await readRegularFileIfExists(this.auditPath, "memory audit log");
		if (content === undefined || !content.trim()) return [];
		const entries = content
			.trimEnd()
			.split("\n")
			.map((line, index) => {
				let value: unknown;
				try {
					value = JSON.parse(line) as unknown;
				} catch (error) {
					throw new Error(`memory audit log line ${index + 1} contains invalid JSON`, { cause: error });
				}
				return parseAuditEntry(value, `memory audit log line ${index + 1}`);
			});
		const eventIds = new Set<string>();
		for (const entry of entries) {
			if (eventIds.has(entry.eventId)) throw new Error(`memory audit log repeats event id ${entry.eventId}`);
			eventIds.add(entry.eventId);
		}
		return entries;
	}

	private async appendAuditEntriesOnce(entries: readonly EvoMemoryAuditEntry[]): Promise<void> {
		const existing = new Map((await this.readAuditEntries()).map((entry) => [entry.eventId, entry]));
		for (const entry of entries) {
			if (entry.componentId !== this.componentId || entry.artifactDigest !== this.artifactDigest) {
				throw new Error("Memory transaction audit identity does not match this store");
			}
			const persisted = existing.get(entry.eventId);
			if (persisted) {
				if (canonicalJson(persisted) !== canonicalJson(entry)) {
					throw new Error(`Memory audit event id ${entry.eventId} has conflicting content`);
				}
				continue;
			}
			await appendRegularFileNoFollow(this.auditPath, `${JSON.stringify(entry)}\n`, "memory audit log");
			existing.set(entry.eventId, entry);
			await this.faultInjection?.("after-audit-append");
		}
	}

	private pointerLocationPath(location: EvoMemoryPointerLocation): { path: string; label: string } {
		if (location.kind === "stable") return { path: this.stablePath, label: "stable memory pointer" };
		if (location.kind === "trial") {
			return { path: this.trialPath(location.bundleDigest), label: "trial memory pointer" };
		}
		return {
			path: this.stableHistoryPath(location.bundleDigest),
			label: "stable memory history pointer",
		};
	}

	private async applyPointerAction(action: EvoMemoryPointerAction): Promise<void> {
		const { path, label } = this.pointerLocationPath(action.location);
		const current = (await this.readPointer(path, label)) ?? null;
		if (pointerEquals(current, action.after)) return;
		if (!pointerEquals(current, action.before)) {
			throw new Error(`${label} changed outside its pending memory transaction`);
		}
		if (action.after) await atomicWriteJsonNoFollow(path, action.after, label);
		else await durableUnlinkRegularFileNoFollow(path, label);
	}

	private async readPendingTransaction(): Promise<EvoMemoryTransaction | undefined> {
		const content = await readRegularFileIfExists(this.transactionPath, "memory transaction outbox");
		if (content === undefined) return undefined;
		let value: unknown;
		try {
			value = JSON.parse(content) as unknown;
		} catch (error) {
			throw new Error("memory transaction outbox contains invalid JSON", { cause: error });
		}
		return parseTransaction(value, "memory transaction outbox");
	}

	private async recoverPendingTransaction(): Promise<void> {
		const transaction = await this.readPendingTransaction();
		if (!transaction) return;
		const existingAudit = new Map((await this.readAuditEntries()).map((entry) => [entry.eventId, entry]));
		for (const entry of transaction.auditEntries) {
			if (entry.componentId !== this.componentId || entry.artifactDigest !== this.artifactDigest) {
				throw new Error("Memory transaction audit identity does not match this store");
			}
			const existing = existingAudit.get(entry.eventId);
			if (existing && canonicalJson(existing) !== canonicalJson(entry)) {
				throw new Error(`Memory audit event id ${entry.eventId} has conflicting content`);
			}
		}
		for (const action of transaction.actions) {
			await this.applyPointerAction(action);
			await this.faultInjection?.("after-pointer-action");
		}
		await this.appendAuditEntriesOnce(transaction.auditEntries);
		await this.faultInjection?.("before-outbox-remove");
		await durableUnlinkRegularFileNoFollow(this.transactionPath, "memory transaction outbox");
	}

	private async commitTransaction(
		actions: readonly EvoMemoryPointerAction[],
		auditEntries: readonly EvoMemoryAuditEntry[],
	): Promise<void> {
		if (actions.length === 0 && auditEntries.length === 0) return;
		if (await this.readPendingTransaction()) throw new Error("A memory transaction is already pending");
		const transaction = parseTransaction({ schemaVersion: 1, actions, auditEntries }, "memory transaction outbox");
		await atomicWriteJsonNoFollow(this.transactionPath, transaction, "memory transaction outbox");
		await this.faultInjection?.("after-outbox-write");
		await this.recoverPendingTransaction();
	}

	private async withMemoryLock<T>(operation: () => Promise<T>): Promise<T> {
		return withFileLock(this.paths, this.lockName, async () => {
			await this.ensureLayout();
			await this.recoverPendingTransaction();
			return operation();
		});
	}

	private async stableHistoryAction(pointer: EvoMemoryNamespacePointer): Promise<EvoMemoryPointerAction | undefined> {
		if (pointer.kind !== "stable") throw new Error("Only stable memory pointers can be archived");
		const location: EvoMemoryPointerLocation = { kind: "stable-history", bundleDigest: pointer.bundleDigest };
		const { path, label } = this.pointerLocationPath(location);
		const existing = (await this.readPointer(path, label)) ?? null;
		if (pointerEquals(existing, pointer)) return undefined;
		if (existing) throw new Error("Stable memory history conflicts with the pending checkpoint");
		return { location, before: null, after: pointer };
	}

	private async resolveStableCheckpoint(bundleDigest: string): Promise<EvoMemoryNamespacePointer | undefined> {
		const digest = requireDigest(bundleDigest, "stable checkpoint bundle digest");
		const archived = await this.readPointer(this.stableHistoryPath(digest), "stable memory history pointer");
		if (archived) {
			if (archived.kind !== "stable" || archived.bundleDigest !== digest) {
				throw new Error("Stable memory history pointer does not match its bundle");
			}
			await this.readSnapshot(archived.stateDigest);
			return archived;
		}
		const audit = await this.readAuditEntries();
		for (let index = audit.length - 1; index >= 0; index--) {
			const entry = audit[index];
			if (
				entry?.operation !== "promote" ||
				entry.namespace !== "trial" ||
				entry.parentBundleDigest !== digest ||
				entry.stateBefore === null
			) {
				continue;
			}
			await this.readSnapshot(entry.stateBefore);
			return {
				schemaVersion: 1,
				kind: "stable",
				bundleDigest: digest,
				parentBundleDigest: null,
				stateDigest: entry.stateBefore,
			};
		}
		return undefined;
	}

	private async createPromoteAuditEntryOnce(
		trial: EvoMemoryNamespacePointer,
		stateBefore: string,
		stateAfter: string,
	): Promise<EvoMemoryAuditEntry | undefined> {
		const existing = (await this.readAuditEntries()).some(
			(entry) =>
				entry.operation === "promote" &&
				entry.namespace === "trial" &&
				entry.bundleDigest === trial.bundleDigest &&
				entry.parentBundleDigest === trial.parentBundleDigest &&
				entry.stateBefore === stateBefore &&
				entry.stateAfter === stateAfter,
		);
		return existing ? undefined : this.createAuditEntry("promote", trial, null, stateBefore, stateAfter);
	}

	private async hasUnresolvedTrialAudit(bundleDigest: string): Promise<boolean> {
		let unresolved = false;
		for (const entry of await this.readAuditEntries()) {
			if (entry.namespace !== "trial" || entry.bundleDigest !== bundleDigest) continue;
			if (entry.operation === "trial-start") unresolved = true;
			if (entry.operation === "promote" || entry.operation === "rollback") unresolved = false;
		}
		return unresolved;
	}

	private async readBundleRollbackState(options: {
		rolledBackBundleDigests: string[];
		targetBundleDigest: string;
		targetAncestorBundleDigests: string[];
		targetSelected: boolean;
	}): Promise<EvoMemoryBundleRollbackState> {
		const stable = await this.readPointer(this.stablePath, "stable memory pointer");
		const trials: EvoMemoryNamespacePointer[] = [];
		for (const digest of options.rolledBackBundleDigests) {
			const trial = await this.readPointer(this.trialPath(digest), "trial memory pointer");
			if (!trial) continue;
			if (trial.kind !== "trial" || trial.bundleDigest !== digest) {
				throw new Error("Trial memory does not match the registry rollback lineage");
			}
			await this.readSnapshot(trial.stateDigest);
			trials.push(trial);
		}
		const targetTrial = options.targetSelected
			? await this.readPointer(this.trialPath(options.targetBundleDigest), "rollback target trial memory pointer")
			: undefined;
		if (targetTrial) {
			if (targetTrial.kind !== "trial" || targetTrial.bundleDigest !== options.targetBundleDigest) {
				throw new Error("Target trial memory does not match the registry rollback target");
			}
			if (targetTrial.parentBundleDigest !== options.targetAncestorBundleDigests[0]) {
				throw new Error("Target trial memory parent does not match the verified target lineage");
			}
			await this.readSnapshot(targetTrial.stateDigest);
		}
		if (!stable) {
			if (trials.length > 0 || targetTrial) throw new Error("Trial memory exists without a stable parent");
			return { trials };
		}
		await this.readSnapshot(stable.stateDigest);
		const allowedStableDigests = new Set([
			...options.rolledBackBundleDigests,
			options.targetBundleDigest,
			...options.targetAncestorBundleDigests,
		]);
		if (!allowedStableDigests.has(stable.bundleDigest)) {
			throw new Error("Stable memory points outside the registry rollback lineage");
		}
		if (!options.targetSelected) return { stable, trials };
		if (stable.bundleDigest === options.targetBundleDigest) {
			if (!targetTrial) return { stable, trials, target: stable };
			if (targetTrial.stateDigest !== stable.stateDigest) {
				throw new Error("Rollback target stable memory disagrees with its remaining trial pointer");
			}
			const parentBundleDigest = targetTrial.parentBundleDigest;
			if (!parentBundleDigest) throw new Error("Rollback target trial memory is missing its parent bundle");
			const parent = await this.resolveStableCheckpoint(parentBundleDigest);
			if (!parent) throw new Error("Rollback target trial memory is missing its parent checkpoint");
			return {
				stable,
				trials,
				target: stable,
				targetTrial,
				targetTrialStateBefore: parent.stateDigest,
			};
		}
		if (targetTrial) {
			if (targetTrial.parentBundleDigest !== stable.bundleDigest) {
				throw new Error("Rollback target trial parent no longer matches stable memory");
			}
			return {
				stable,
				trials,
				target: {
					schemaVersion: 1,
					kind: "stable",
					bundleDigest: options.targetBundleDigest,
					parentBundleDigest: null,
					stateDigest: targetTrial.stateDigest,
				},
				targetTrial,
				targetTrialStateBefore: stable.stateDigest,
			};
		}
		if (await this.hasUnresolvedTrialAudit(options.targetBundleDigest)) {
			throw new Error(`Trial memory audit is unresolved for rollback target ${options.targetBundleDigest}`);
		}
		const target = await this.resolveStableCheckpoint(options.targetBundleDigest);
		if (target) return { stable, trials, target };
		if (options.targetAncestorBundleDigests.includes(stable.bundleDigest)) {
			return {
				stable,
				trials,
				target: {
					schemaVersion: 1,
					kind: "stable",
					bundleDigest: options.targetBundleDigest,
					parentBundleDigest: null,
					stateDigest: stable.stateDigest,
				},
			};
		}
		throw new Error(`Stable memory history is not initialized for rollback target ${options.targetBundleDigest}`);
	}

	async initializeStable(bundleDigest: string): Promise<EvoMemoryNamespace> {
		const digest = requireDigest(bundleDigest, "stable bundle digest");
		await this.withMemoryLock(async () => {
			const existing = await this.readPointer(this.stablePath, "stable memory pointer");
			if (existing) {
				if (existing.kind !== "stable" || existing.bundleDigest !== digest) {
					throw new Error("Stable memory is already initialized for a different bundle");
				}
				await this.readSnapshot(existing.stateDigest);
				return;
			}
			const stateDigest = await this.writeSnapshot({ schemaVersion: 1, fragments: [] });
			const pointer: EvoMemoryNamespacePointer = {
				schemaVersion: 1,
				kind: "stable",
				bundleDigest: digest,
				parentBundleDigest: null,
				stateDigest,
			};
			await this.commitTransaction(
				[{ location: { kind: "stable" }, before: null, after: pointer }],
				[this.createAuditEntry("initialize", pointer, null, null, stateDigest)],
			);
		});
		return new EvoMemoryNamespace(this, "stable", digest);
	}

	async openStable(bundleDigest: string): Promise<EvoMemoryNamespace> {
		const digest = requireDigest(bundleDigest, "stable bundle digest");
		await this.withMemoryLock(async () => {
			const pointer = await this.readPointer(this.stablePath, "stable memory pointer");
			if (!pointer || pointer.kind !== "stable" || pointer.bundleDigest !== digest) {
				throw new Error("Stable memory is not initialized for this bundle");
			}
			await this.readSnapshot(pointer.stateDigest);
		});
		return new EvoMemoryNamespace(this, "stable", digest);
	}

	async beginTrial(options: EvoMemoryTrialOptions): Promise<EvoMemoryNamespace> {
		const parentBundleDigest = requireDigest(options.parentBundleDigest, "trial parent bundle digest");
		const trialBundleDigest = requireDigest(options.trialBundleDigest, "trial bundle digest");
		if (parentBundleDigest === trialBundleDigest) throw new Error("Trial bundle must differ from its parent");
		await this.withMemoryLock(async () => {
			const stable = await this.readPointer(this.stablePath, "stable memory pointer");
			if (!stable || stable.kind !== "stable" || stable.bundleDigest !== parentBundleDigest) {
				throw new Error("Trial parent does not match stable memory");
			}
			await this.readSnapshot(stable.stateDigest);
			const path = this.trialPath(trialBundleDigest);
			const existing = await this.readPointer(path, "trial memory pointer");
			if (existing) {
				if (
					existing.kind !== "trial" ||
					existing.bundleDigest !== trialBundleDigest ||
					existing.parentBundleDigest !== parentBundleDigest
				) {
					throw new Error("Existing trial memory does not match the requested trial");
				}
				return;
			}
			const pointer: EvoMemoryNamespacePointer = {
				schemaVersion: 1,
				kind: "trial",
				bundleDigest: trialBundleDigest,
				parentBundleDigest,
				stateDigest: stable.stateDigest,
			};
			await this.commitTransaction(
				[
					{
						location: { kind: "trial", bundleDigest: trialBundleDigest },
						before: null,
						after: pointer,
					},
				],
				[this.createAuditEntry("trial-start", pointer, null, stable.stateDigest, stable.stateDigest)],
			);
		});
		return new EvoMemoryNamespace(this, "trial", trialBundleDigest);
	}

	async openTrial(trialBundleDigest: string): Promise<EvoMemoryNamespace> {
		const digest = requireDigest(trialBundleDigest, "trial bundle digest");
		await this.withMemoryLock(async () => {
			const pointer = await this.readPointer(this.trialPath(digest), "trial memory pointer");
			if (!pointer || pointer.kind !== "trial" || pointer.bundleDigest !== digest) {
				throw new Error("Trial memory is not initialized for this bundle");
			}
			await this.readSnapshot(pointer.stateDigest);
		});
		return new EvoMemoryNamespace(this, "trial", digest);
	}

	async promoteTrial(trialBundleDigest: string): Promise<EvoMemoryNamespace> {
		const digest = requireDigest(trialBundleDigest, "trial bundle digest");
		await this.withMemoryLock(async () => {
			const trial = await this.readPointer(this.trialPath(digest), "trial memory pointer");
			const stable = await this.readPointer(this.stablePath, "stable memory pointer");
			if (!trial) {
				if (!stable || stable.kind !== "stable" || stable.bundleDigest !== digest) {
					throw new Error("Trial memory is not initialized for this bundle");
				}
				await this.readSnapshot(stable.stateDigest);
				return;
			}
			if (trial.kind !== "trial" || trial.bundleDigest !== digest) {
				throw new Error("Trial memory does not match the promoted bundle");
			}
			if (!stable || stable.kind !== "stable") {
				throw new Error("Trial parent no longer matches stable memory");
			}
			await this.readSnapshot(trial.stateDigest);
			const parentBundleDigest = trial.parentBundleDigest;
			if (!parentBundleDigest) throw new Error("Trial memory is missing its parent bundle");
			if (stable.bundleDigest === digest) {
				if (stable.stateDigest !== trial.stateDigest) {
					throw new Error("Promoted stable memory disagrees with its remaining trial pointer");
				}
				const parent = await this.resolveStableCheckpoint(parentBundleDigest);
				if (!parent) throw new Error("Promoted memory is missing its parent checkpoint");
				const auditEntry = await this.createPromoteAuditEntryOnce(trial, parent.stateDigest, trial.stateDigest);
				await this.commitTransaction(
					[
						{
							location: { kind: "trial", bundleDigest: digest },
							before: trial,
							after: null,
						},
					],
					auditEntry ? [auditEntry] : [],
				);
				return;
			}
			if (stable.bundleDigest !== parentBundleDigest) {
				throw new Error("Trial parent no longer matches stable memory");
			}
			await this.readSnapshot(stable.stateDigest);
			const promoted: EvoMemoryNamespacePointer = {
				schemaVersion: 1,
				kind: "stable",
				bundleDigest: trial.bundleDigest,
				parentBundleDigest: null,
				stateDigest: trial.stateDigest,
			};
			const historyAction = await this.stableHistoryAction(stable);
			const auditEntry = await this.createPromoteAuditEntryOnce(trial, stable.stateDigest, trial.stateDigest);
			const actions: EvoMemoryPointerAction[] = [
				...(historyAction ? [historyAction] : []),
				{ location: { kind: "stable" }, before: stable, after: promoted },
				{ location: { kind: "trial", bundleDigest: digest }, before: trial, after: null },
			];
			await this.commitTransaction(actions, auditEntry ? [auditEntry] : []);
		});
		return new EvoMemoryNamespace(this, "stable", digest);
	}

	async materializeStableForBundle(options: EvoMemoryStableMaterializationOptions): Promise<EvoMemoryNamespace> {
		const targetBundleDigest = requireDigest(options.targetBundleDigest, "materialized stable bundle digest");
		if (!Array.isArray(options.targetAncestorBundleDigests)) {
			throw new Error("materialized stable ancestor lineage must be an array");
		}
		const targetAncestorBundleDigests = options.targetAncestorBundleDigests.map((digest, index) =>
			requireDigest(digest, `materialized stable ancestor lineage[${index}]`),
		);
		if (new Set(targetAncestorBundleDigests).size !== targetAncestorBundleDigests.length) {
			throw new Error("materialized stable ancestor lineage must not contain duplicates");
		}
		if (targetAncestorBundleDigests.includes(targetBundleDigest)) {
			throw new Error("materialized stable ancestor lineage must not contain its target");
		}
		await this.withMemoryLock(async () => {
			let stable = await this.readPointer(this.stablePath, "stable memory pointer");
			if (!stable) {
				for (const digest of [targetBundleDigest, ...targetAncestorBundleDigests]) {
					if (await this.readPointer(this.trialPath(digest), "materialized lineage trial memory pointer")) {
						throw new Error("Trial memory exists without a stable parent");
					}
				}
				const stateDigest = await this.writeSnapshot({ schemaVersion: 1, fragments: [] });
				const initialized: EvoMemoryNamespacePointer = {
					schemaVersion: 1,
					kind: "stable",
					bundleDigest: targetBundleDigest,
					parentBundleDigest: null,
					stateDigest,
				};
				await this.commitTransaction(
					[{ location: { kind: "stable" }, before: null, after: initialized }],
					[this.createAuditEntry("initialize", initialized, null, null, stateDigest)],
				);
				return;
			}
			if (stable.kind !== "stable") throw new Error("Stable memory pointer has the wrong namespace kind");
			await this.readSnapshot(stable.stateDigest);
			const stableAncestorIndex =
				stable.bundleDigest === targetBundleDigest ? -1 : targetAncestorBundleDigests.indexOf(stable.bundleDigest);
			if (stable.bundleDigest !== targetBundleDigest && stableAncestorIndex < 0) {
				throw new Error("Stable memory points outside the registry-verified materialization lineage");
			}

			const remainingStableTrial = await this.readPointer(
				this.trialPath(stable.bundleDigest),
				"remaining promoted trial memory pointer",
			);
			if (remainingStableTrial) {
				const expectedParentBundleDigest =
					stable.bundleDigest === targetBundleDigest
						? targetAncestorBundleDigests[0]
						: targetAncestorBundleDigests[stableAncestorIndex + 1];
				if (
					remainingStableTrial.kind !== "trial" ||
					remainingStableTrial.bundleDigest !== stable.bundleDigest ||
					remainingStableTrial.parentBundleDigest !== expectedParentBundleDigest ||
					remainingStableTrial.stateDigest !== stable.stateDigest
				) {
					throw new Error("Remaining promoted trial memory does not match the registry-verified lineage");
				}
				if (!expectedParentBundleDigest) {
					throw new Error("Remaining promoted trial memory has no verified parent");
				}
				const parent = await this.resolveStableCheckpoint(expectedParentBundleDigest);
				if (!parent) throw new Error("Remaining promoted trial memory is missing its parent checkpoint");
				const auditEntry = await this.createPromoteAuditEntryOnce(
					remainingStableTrial,
					parent.stateDigest,
					remainingStableTrial.stateDigest,
				);
				await this.commitTransaction(
					[
						{
							location: { kind: "trial", bundleDigest: remainingStableTrial.bundleDigest },
							before: remainingStableTrial,
							after: null,
						},
					],
					auditEntry ? [auditEntry] : [],
				);
			}
			if (stable.bundleDigest === targetBundleDigest) return;

			const materializedBundleDigests = [
				...targetAncestorBundleDigests.slice(0, stableAncestorIndex).reverse(),
				targetBundleDigest,
			];
			for (const bundleDigest of materializedBundleDigests) {
				let trial = await this.readPointer(
					this.trialPath(bundleDigest),
					"materialized lineage trial memory pointer",
				);
				if (trial) {
					if (
						trial.kind !== "trial" ||
						trial.bundleDigest !== bundleDigest ||
						trial.parentBundleDigest !== stable.bundleDigest
					) {
						throw new Error("Materialized trial memory does not match the registry-verified lineage");
					}
					await this.readSnapshot(trial.stateDigest);
				} else {
					trial = {
						schemaVersion: 1,
						kind: "trial",
						bundleDigest,
						parentBundleDigest: stable.bundleDigest,
						stateDigest: stable.stateDigest,
					};
					await this.commitTransaction(
						[
							{
								location: { kind: "trial", bundleDigest },
								before: null,
								after: trial,
							},
						],
						[this.createAuditEntry("trial-start", trial, null, stable.stateDigest, stable.stateDigest)],
					);
				}
				const promoted: EvoMemoryNamespacePointer = {
					schemaVersion: 1,
					kind: "stable",
					bundleDigest,
					parentBundleDigest: null,
					stateDigest: trial.stateDigest,
				};
				const historyAction = await this.stableHistoryAction(stable);
				const auditEntry = await this.createPromoteAuditEntryOnce(trial, stable.stateDigest, trial.stateDigest);
				const actions: EvoMemoryPointerAction[] = [
					...(historyAction ? [historyAction] : []),
					{ location: { kind: "stable" }, before: stable, after: promoted },
					{ location: { kind: "trial", bundleDigest }, before: trial, after: null },
				];
				await this.commitTransaction(actions, auditEntry ? [auditEntry] : []);
				stable = promoted;
			}
		});
		return new EvoMemoryNamespace(this, "stable", targetBundleDigest);
	}

	async preflightBundleRollback(options: EvoMemoryBundleRollbackOptions): Promise<void> {
		const parsed = parseBundleRollbackOptions(options);
		await this.withMemoryLock(async () => {
			await this.readBundleRollbackState(parsed);
		});
	}

	async rollbackBundles(options: EvoMemoryBundleRollbackOptions): Promise<void> {
		const parsed = parseBundleRollbackOptions(options);
		await this.withMemoryLock(async () => {
			const state = await this.readBundleRollbackState(parsed);
			const stateAfter = state.target?.stateDigest ?? null;
			for (const trial of state.trials) {
				await this.commitTransaction(
					[
						{
							location: { kind: "trial", bundleDigest: trial.bundleDigest },
							before: trial,
							after: null,
						},
					],
					[this.createAuditEntry("rollback", trial, null, trial.stateDigest, stateAfter)],
				);
			}
			if (!state.stable) return;
			if (!parsed.targetSelected) {
				const historyAction = await this.stableHistoryAction(state.stable);
				const actions: EvoMemoryPointerAction[] = [
					...(historyAction ? [historyAction] : []),
					{ location: { kind: "stable" }, before: state.stable, after: null },
				];
				await this.commitTransaction(actions, [
					this.createAuditEntry("rollback", state.stable, null, state.stable.stateDigest, null),
				]);
				return;
			}
			if (state.stable.bundleDigest === parsed.targetBundleDigest) {
				if (state.targetTrial) {
					if (!state.targetTrialStateBefore) {
						throw new Error("Rollback target trial memory lost its validated parent state");
					}
					const auditEntry = await this.createPromoteAuditEntryOnce(
						state.targetTrial,
						state.targetTrialStateBefore,
						state.targetTrial.stateDigest,
					);
					await this.commitTransaction(
						[
							{
								location: { kind: "trial", bundleDigest: state.targetTrial.bundleDigest },
								before: state.targetTrial,
								after: null,
							},
						],
						auditEntry ? [auditEntry] : [],
					);
				}
				return;
			}
			if (!state.target) throw new Error("Memory rollback target disappeared after preflight");
			const targetHistoryAction = await this.stableHistoryAction(state.target);
			const stableHistoryAction = await this.stableHistoryAction(state.stable);
			const actions: EvoMemoryPointerAction[] = [
				...(targetHistoryAction ? [targetHistoryAction] : []),
				...(stableHistoryAction ? [stableHistoryAction] : []),
				{ location: { kind: "stable" }, before: state.stable, after: state.target },
			];
			let auditEntry: EvoMemoryAuditEntry | undefined;
			if (state.targetTrial) {
				if (!state.targetTrialStateBefore) {
					throw new Error("Rollback target trial memory lost its validated parent state");
				}
				auditEntry = await this.createPromoteAuditEntryOnce(
					state.targetTrial,
					state.targetTrialStateBefore,
					state.targetTrial.stateDigest,
				);
				actions.push({
					location: { kind: "trial", bundleDigest: state.targetTrial.bundleDigest },
					before: state.targetTrial,
					after: null,
				});
			} else {
				auditEntry = this.createAuditEntry(
					"rollback",
					state.stable,
					null,
					state.stable.stateDigest,
					state.target.stateDigest,
				);
			}
			await this.commitTransaction(actions, auditEntry ? [auditEntry] : []);
		});
	}

	async rollbackTrial(trialBundleDigest: string): Promise<EvoMemoryNamespace> {
		const digest = requireDigest(trialBundleDigest, "trial bundle digest");
		let stableDigest = "";
		await this.withMemoryLock(async () => {
			const trial = await this.readPointer(this.trialPath(digest), "trial memory pointer");
			if (!trial || trial.kind !== "trial" || trial.bundleDigest !== digest) {
				throw new Error("Trial memory is not initialized for this bundle");
			}
			const stable = await this.readPointer(this.stablePath, "stable memory pointer");
			if (!stable || stable.kind !== "stable" || stable.bundleDigest !== trial.parentBundleDigest) {
				throw new Error("Trial parent no longer matches stable memory");
			}
			await this.commitTransaction(
				[
					{
						location: { kind: "trial", bundleDigest: digest },
						before: trial,
						after: null,
					},
				],
				[this.createAuditEntry("rollback", trial, null, trial.stateDigest, stable.stateDigest)],
			);
			stableDigest = stable.bundleDigest;
		});
		return new EvoMemoryNamespace(this, "stable", stableDigest);
	}

	async readAudit(): Promise<EvoMemoryAuditEntry[]> {
		return this.withMemoryLock(() => this.readAuditEntries());
	}

	async readNamespace(kind: EvoMemoryNamespaceKind, bundleDigest: string): Promise<EvoMemoryReadResult> {
		const digest = requireDigest(bundleDigest, `${kind} bundle digest`);
		return this.withMemoryLock(async () => {
			const pointer = await this.readPointer(this.pointerPath(kind, digest), `${kind} memory pointer`);
			if (!pointer || pointer.kind !== kind || pointer.bundleDigest !== digest) {
				throw new Error(`${kind} memory is not initialized for this bundle`);
			}
			const snapshot = await this.readSnapshot(pointer.stateDigest);
			return { stateDigest: pointer.stateDigest, fragments: snapshot.fragments.map(cloneFragment) };
		});
	}

	async mutateNamespace(
		kind: EvoMemoryNamespaceKind,
		bundleDigest: string,
		mutation: EvoMemoryMutation,
	): Promise<EvoMemoryMutationResult> {
		const digest = requireDigest(bundleDigest, `${kind} bundle digest`);
		if (mutation.expectedStateDigest !== undefined) {
			requireDigest(mutation.expectedStateDigest, "expected memory state digest");
		}
		return this.withMemoryLock(async () => {
			const path = this.pointerPath(kind, digest);
			const pointer = await this.readPointer(path, `${kind} memory pointer`);
			if (!pointer || pointer.kind !== kind || pointer.bundleDigest !== digest) {
				throw new Error(`${kind} memory is not initialized for this bundle`);
			}
			if (mutation.expectedStateDigest !== undefined && mutation.expectedStateDigest !== pointer.stateDigest) {
				throw new Error("Memory state changed since the component read it");
			}
			const snapshot = await this.readSnapshot(pointer.stateDigest);
			const fragments = snapshot.fragments.map(cloneFragment);
			const timestamp = this.timestamp();
			let fragment: EvoMemoryFragment | null;
			let fragmentId: string;
			if (mutation.operation === "forget") {
				fragmentId = requireMemoryId(mutation.id, "memory fragment id");
				const index = fragments.findIndex((entry) => entry.id === fragmentId);
				if (index < 0) throw new Error(`Memory fragment does not exist: ${fragmentId}`);
				fragment = fragments[index] ?? null;
				fragments.splice(index, 1);
			} else {
				const input = parseEvoMemoryFragmentInput(mutation.fragment);
				fragmentId = input.id;
				const index = fragments.findIndex((entry) => entry.id === input.id);
				if (mutation.operation === "append" && index >= 0) {
					throw new Error(`Memory fragment already exists: ${input.id}`);
				}
				if (mutation.operation === "update" && index < 0) {
					throw new Error(`Memory fragment does not exist: ${input.id}`);
				}
				fragment = {
					id: input.id,
					text: input.text,
					metadata: input.metadata ?? {},
					createdAt: index < 0 ? timestamp : (fragments[index]?.createdAt ?? timestamp),
					updatedAt: timestamp,
				};
				if (index < 0) fragments.push(fragment);
				else fragments[index] = fragment;
			}
			fragments.sort((left, right) => left.id.localeCompare(right.id));
			const stateDigest = await this.writeSnapshot({ schemaVersion: 1, fragments });
			const nextPointer: EvoMemoryNamespacePointer = { ...pointer, stateDigest };
			const location: EvoMemoryPointerLocation =
				kind === "stable" ? { kind: "stable" } : { kind: "trial", bundleDigest: digest };
			await this.commitTransaction(
				pointerEquals(pointer, nextPointer) ? [] : [{ location, before: pointer, after: nextPointer }],
				[this.createAuditEntry(mutation.operation, pointer, fragmentId, pointer.stateDigest, stateDigest)],
			);
			return { stateDigest, fragment: fragment ? cloneFragment(fragment) : null };
		});
	}
}

export class EvoMemoryNamespace {
	readonly kind: EvoMemoryNamespaceKind;
	readonly bundleDigest: string;
	private readonly store: EvoMemoryStore;

	constructor(store: EvoMemoryStore, kind: EvoMemoryNamespaceKind, bundleDigest: string) {
		this.store = store;
		this.kind = kind;
		this.bundleDigest = requireDigest(bundleDigest, `${kind} bundle digest`);
	}

	assertComponent(component: EvoCapabilityComponentIdentity): void {
		if (component.id !== this.store.componentId || component.artifactDigest !== this.store.artifactDigest) {
			throw new Error("Memory namespace is not assigned to this component artifact");
		}
	}

	read(): Promise<EvoMemoryReadResult> {
		return this.store.readNamespace(this.kind, this.bundleDigest);
	}

	append(fragment: EvoMemoryFragmentInput, expectedStateDigest?: string): Promise<EvoMemoryMutationResult> {
		return this.store.mutateNamespace(this.kind, this.bundleDigest, {
			operation: "append",
			fragment,
			...(expectedStateDigest === undefined ? {} : { expectedStateDigest }),
		});
	}

	update(fragment: EvoMemoryFragmentInput, expectedStateDigest?: string): Promise<EvoMemoryMutationResult> {
		return this.store.mutateNamespace(this.kind, this.bundleDigest, {
			operation: "update",
			fragment,
			...(expectedStateDigest === undefined ? {} : { expectedStateDigest }),
		});
	}

	forget(id: string, expectedStateDigest?: string): Promise<EvoMemoryMutationResult> {
		return this.store.mutateNamespace(this.kind, this.bundleDigest, {
			operation: "forget",
			id,
			...(expectedStateDigest === undefined ? {} : { expectedStateDigest }),
		});
	}

	async retrieve(query: string, limit = 10): Promise<EvoMemoryRetrieveResult> {
		if (typeof query !== "string" || !query.trim() || query !== query.trim() || query.length > 8_000) {
			throw new Error("retrieve query must be a trimmed non-empty string of at most 8000 characters");
		}
		if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_RETRIEVE_LIMIT) {
			throw new Error(`retrieve limit must be an integer from 1 to ${MAX_RETRIEVE_LIMIT}`);
		}
		const state = await this.read();
		const queryTokens = tokenize(query);
		const fragments = state.fragments
			.map((fragment): EvoMemoryRetrievedFragment => {
				const fragmentTokens = tokenize(`${fragment.text}\n${canonicalJson(fragment.metadata)}`);
				let score = 0;
				for (const token of queryTokens) if (fragmentTokens.has(token)) score += 1;
				return { ...fragment, score };
			})
			.filter((fragment) => fragment.score > 0)
			.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
			.slice(0, limit);
		return { stateDigest: state.stateDigest, fragments };
	}
}
