import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { EvoPaths } from "./paths.ts";
import { ensureEvoLayout } from "./paths.ts";
import type { RecorderInboxEntry, RecorderInboxKind } from "./recorder/schema.ts";
import { appendJsonLine, durableUnlink, sha256, withFileLock } from "./storage.ts";
import type { Proposal } from "./types.ts";

export type InboxKind = "unclassified" | "preference" | "request" | "note" | "task-local";
export type InboxStatus = "open" | "linked" | "materialized" | "fulfilled" | "dismissed" | "superseded";

export interface InboxLifecycleEvent {
	schemaVersion: 1;
	id: string;
	file: string;
	timestamp: string;
	kind: InboxKind;
	status: InboxStatus;
	reason: string;
	summary?: string;
	/** Exact user-authored durable instruction after preference classification. */
	instruction?: string;
	proposalId?: string;
	bundleDigest?: string;
	sourceDigest?: string;
	payloadDeletedAt?: string;
}

export interface InboxLifecycleState extends InboxLifecycleEvent {
	initialized: boolean;
}

export interface InboxDecision {
	file: string;
	kind: "preference" | "request" | "note" | "task-local";
	reason: string;
	instruction?: string;
}

export interface InboxGcResult {
	dryRun: boolean;
	files: string[];
}

const TERMINAL_STATUSES = new Set<InboxStatus>(["materialized", "fulfilled", "dismissed", "superseded"]);
const FILE_PATTERN = /^[^/\\\0]+\.json$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertFileName(file: string): void {
	if (!FILE_PATTERN.test(file) || basename(file) !== file) throw new Error(`Invalid inbox file: ${file}`);
}

function inferEntryKind(entry: RecorderInboxEntry): RecorderInboxKind {
	if (entry.kind) return entry.kind;
	const text = entry.text.trimStart();
	if (text.startsWith("REQUEST:")) return "request";
	if (text.startsWith("NOTE:")) return "note";
	if (text.startsWith("PREFERENCE:")) return "preference";
	return "candidate";
}

function lifecycleKind(kind: RecorderInboxKind): InboxKind {
	return kind === "candidate" ? "unclassified" : kind;
}

export function parseRecorderInboxEntry(value: unknown, file: string): RecorderInboxEntry {
	assertFileName(file);
	if (!isRecord(value)) throw new Error(`Inbox entry is invalid: ${file}`);
	if (
		value.schemaVersion !== 1 ||
		typeof value.id !== "string" ||
		!value.id ||
		typeof value.timestamp !== "string" ||
		!Number.isFinite(Date.parse(value.timestamp)) ||
		typeof value.sessionId !== "string" ||
		!value.sessionId ||
		(value.source !== "interactive" && value.source !== "rpc" && value.source !== "extension") ||
		typeof value.text !== "string" ||
		!value.text.trim() ||
		(value.kind !== undefined &&
			value.kind !== "candidate" &&
			value.kind !== "preference" &&
			value.kind !== "request" &&
			value.kind !== "note")
	) {
		throw new Error(`Inbox entry is invalid: ${file}`);
	}
	return value as unknown as RecorderInboxEntry;
}

export async function readInboxEntry(paths: EvoPaths, file: string): Promise<RecorderInboxEntry> {
	assertFileName(file);
	return parseRecorderInboxEntry(JSON.parse(await readFile(join(paths.inbox, file), "utf8")), file);
}

function parseLifecycleEvent(value: unknown, line: number): InboxLifecycleEvent {
	if (!isRecord(value)) throw new Error(`Invalid inbox history event at line ${line}`);
	const kind = value.kind;
	const status = value.status;
	if (
		value.schemaVersion !== 1 ||
		typeof value.id !== "string" ||
		!value.id ||
		typeof value.file !== "string" ||
		typeof value.timestamp !== "string" ||
		!Number.isFinite(Date.parse(value.timestamp)) ||
		(kind !== "unclassified" &&
			kind !== "preference" &&
			kind !== "request" &&
			kind !== "note" &&
			kind !== "task-local") ||
		(status !== "open" &&
			status !== "linked" &&
			status !== "materialized" &&
			status !== "fulfilled" &&
			status !== "dismissed" &&
			status !== "superseded") ||
		typeof value.reason !== "string" ||
		!value.reason.trim() ||
		(value.summary !== undefined && (typeof value.summary !== "string" || !value.summary.trim())) ||
		(value.instruction !== undefined && (typeof value.instruction !== "string" || !value.instruction.trim())) ||
		(value.proposalId !== undefined && typeof value.proposalId !== "string") ||
		(value.bundleDigest !== undefined && typeof value.bundleDigest !== "string") ||
		(value.sourceDigest !== undefined && typeof value.sourceDigest !== "string") ||
		(value.payloadDeletedAt !== undefined &&
			(typeof value.payloadDeletedAt !== "string" || !Number.isFinite(Date.parse(value.payloadDeletedAt))))
	) {
		throw new Error(`Invalid inbox history event at line ${line}`);
	}
	assertFileName(value.file);
	return value as unknown as InboxLifecycleEvent;
}

async function readStatesUnlocked(paths: EvoPaths): Promise<Map<string, InboxLifecycleState>> {
	let content: string;
	try {
		content = await readFile(paths.inboxHistory, "utf8");
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return new Map();
		throw error;
	}
	const states = new Map<string, InboxLifecycleState>();
	for (const [index, line] of content.split("\n").entries()) {
		if (!line.trim()) continue;
		const event = parseLifecycleEvent(JSON.parse(line) as unknown, index + 1);
		states.set(event.file, { ...event, initialized: true });
	}
	return states;
}

export async function readInboxLifecycleStates(paths: EvoPaths): Promise<Map<string, InboxLifecycleState>> {
	await ensureEvoLayout(paths);
	return withFileLock(paths, "inbox-lifecycle", () => readStatesUnlocked(paths));
}

async function appendState(
	paths: EvoPaths,
	file: string,
	update: {
		kind: InboxKind;
		status: InboxStatus;
		reason: string;
		summary?: string;
		instruction?: string;
		proposalId?: string;
		bundleDigest?: string;
		sourceDigest?: string;
		payloadDeletedAt?: string;
	},
): Promise<InboxLifecycleState> {
	assertFileName(file);
	return withFileLock(paths, "inbox-lifecycle", async () => {
		const states = await readStatesUnlocked(paths);
		const previous = states.get(file);
		const entry = await readInboxEntry(paths, file).catch((error: unknown) => {
			if (previous?.payloadDeletedAt) return { id: previous.id } as RecorderInboxEntry;
			throw error;
		});
		const event: InboxLifecycleEvent = {
			schemaVersion: 1,
			id: entry.id,
			file,
			timestamp: new Date().toISOString(),
			kind: update.kind,
			status: update.status,
			reason: update.reason,
			...((update.summary ?? previous?.summary) ? { summary: update.summary ?? previous?.summary } : {}),
			...((update.instruction ?? previous?.instruction)
				? { instruction: update.instruction ?? previous?.instruction }
				: {}),
			...(update.proposalId ? { proposalId: update.proposalId } : {}),
			...(update.bundleDigest ? { bundleDigest: update.bundleDigest } : {}),
			...(update.sourceDigest ? { sourceDigest: update.sourceDigest } : {}),
			...(update.payloadDeletedAt ? { payloadDeletedAt: update.payloadDeletedAt } : {}),
		};
		await appendJsonLine(paths.inboxHistory, event);
		return { ...event, initialized: true };
	});
}

export async function initializeInboxLifecycle(paths: EvoPaths, file: string): Promise<InboxLifecycleState> {
	const existing = (await readInboxLifecycleStates(paths)).get(file);
	if (existing) return existing;
	const entry = await readInboxEntry(paths, file);
	return appendState(paths, file, {
		kind: lifecycleKind(inferEntryKind(entry)),
		status: "open",
		reason: "Inbox entry recorded",
		summary: entry.text.replace(/^(?:CANDIDATE|PREFERENCE|REQUEST|NOTE):\s*/i, "").trim(),
	});
}

export async function applyInboxDecisions(
	paths: EvoPaths,
	decisions: readonly InboxDecision[],
	allowedFiles: ReadonlySet<string>,
): Promise<void> {
	const existingStates = await readInboxLifecycleStates(paths);
	const seen = new Set<string>();
	for (const decision of decisions) {
		if (!allowedFiles.has(decision.file))
			throw new Error(`Inbox decision references unavailable file: ${decision.file}`);
		if (seen.has(decision.file)) throw new Error(`Duplicate inbox decision: ${decision.file}`);
		seen.add(decision.file);
		const entry = await readInboxEntry(paths, decision.file);
		if (decision.kind === "preference") {
			if (!decision.instruction?.trim() || !entry.text.includes(decision.instruction)) {
				throw new Error(`Preference decision must quote an exact instruction from ${decision.file}`);
			}
		} else if (decision.instruction !== undefined) {
			throw new Error(`Only preference decisions may contain instruction: ${decision.file}`);
		}
		await appendState(paths, decision.file, {
			kind: decision.kind,
			status: decision.kind === "note" || decision.kind === "task-local" ? "dismissed" : "open",
			reason: decision.reason,
			summary: entry.text.replace(/^(?:CANDIDATE|PREFERENCE|REQUEST|NOTE):\s*/i, "").trim(),
			...(decision.instruction ? { instruction: decision.instruction } : {}),
		});
	}
	for (const file of allowedFiles) {
		const state = existingStates.get(file);
		if ((!state || state.kind === "unclassified") && !seen.has(file)) {
			throw new Error(`ResearchPlanner did not classify active inbox file: ${file}`);
		}
	}
}

export async function linkProposalInbox(paths: EvoPaths, proposal: Proposal): Promise<void> {
	const states = await readInboxLifecycleStates(paths);
	for (const file of proposal.inboxReferences) {
		const state = states.get(file) ?? (await initializeInboxLifecycle(paths, file));
		if (TERMINAL_STATUSES.has(state.status)) continue;
		await appendState(paths, file, {
			kind: state.kind,
			status: "linked",
			reason: "Inbox entry linked to proposal",
			proposalId: proposal.id,
		});
	}
}

export async function settleProposalInbox(paths: EvoPaths, proposal: Proposal): Promise<void> {
	const states = await readInboxLifecycleStates(paths);
	for (const file of proposal.inboxReferences) {
		const state = states.get(file) ?? (await initializeInboxLifecycle(paths, file));
		if (TERMINAL_STATUSES.has(state.status)) continue;
		const materializedPreference = state.kind === "preference";
		await appendState(paths, file, {
			kind: state.kind,
			status: materializedPreference ? "materialized" : "fulfilled",
			reason: materializedPreference
				? "Preference materialized in an active bundle"
				: "Request fulfilled by a kept proposal",
			proposalId: proposal.id,
			...(proposal.candidateDigest ? { bundleDigest: proposal.candidateDigest } : {}),
		});
	}
}

export async function resolveInboxEntry(
	paths: EvoPaths,
	file: string,
	reason: string,
	status: "materialized" | "fulfilled" | "dismissed" | "superseded" = "fulfilled",
): Promise<InboxLifecycleState> {
	const state = (await readInboxLifecycleStates(paths)).get(file) ?? (await initializeInboxLifecycle(paths, file));
	if (TERMINAL_STATUSES.has(state.status)) return state;
	return appendState(paths, file, {
		kind: state.kind,
		status,
		reason,
	});
}

export async function reopenProposalInbox(paths: EvoPaths, proposal: Proposal, reason: string): Promise<void> {
	const states = await readInboxLifecycleStates(paths);
	for (const file of proposal.inboxReferences) {
		const state = states.get(file);
		if (!state || state.payloadDeletedAt) continue;
		await appendState(paths, file, {
			kind: state.kind,
			status: "open",
			reason,
			proposalId: proposal.id,
		});
	}
}

export async function garbageCollectInbox(paths: EvoPaths, dryRun = false): Promise<InboxGcResult> {
	await ensureEvoLayout(paths);
	const states = await readInboxLifecycleStates(paths);
	const available = new Set(
		(await readdir(paths.inbox, { withFileTypes: true }))
			.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
			.map((entry) => entry.name),
	);
	const files = [...states.values()]
		.filter((state) => TERMINAL_STATUSES.has(state.status) && available.has(state.file))
		.map((state) => state.file)
		.sort();
	if (dryRun) return { dryRun: true, files };
	for (const file of files) {
		const state = states.get(file);
		if (!state) continue;
		const source = await readFile(join(paths.inbox, file));
		const deletedAt = new Date().toISOString();
		await appendState(paths, file, {
			kind: state.kind,
			status: state.status,
			reason: "Terminal inbox payload garbage-collected",
			...(state.proposalId ? { proposalId: state.proposalId } : {}),
			...(state.bundleDigest ? { bundleDigest: state.bundleDigest } : {}),
			sourceDigest: sha256(source),
			payloadDeletedAt: deletedAt,
		});
		await durableUnlink(join(paths.inbox, file));
	}
	return { dryRun: false, files };
}
