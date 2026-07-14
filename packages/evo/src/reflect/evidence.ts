import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { loadCompiledBundle } from "../bundle/compile.ts";
import { type EvoPaths, ensureEvoLayout } from "../paths.ts";
import type { DraftProposal } from "../proposal.ts";
import type { RecordedEvent, RecorderInboxEntry } from "../recorder/schema.ts";
import { readSessionLog, resolveStoredPayload } from "../recorder/store.ts";
import { BundleRegistry } from "../registry/registry.ts";
import type { EvidenceReference, ReplayScenario } from "../types.ts";

const DEFAULT_CORPUS_BYTES = 1024 * 1024;

export interface EvidenceCorpus {
	text: string;
	bytes: number;
	maxBytes: number;
	truncated: boolean;
	sessionIds: string[];
	inboxFiles: string[];
	bundleDigest?: string;
}

export interface LoadedReplayScenario {
	history: AgentMessage[];
	targetPrompt: string;
	oldSystemPrompt: string;
	sessionIdentity: string;
	cwd: string;
}

interface RecentFile {
	name: string;
	mtimeMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

function assertSafeFileName(name: string, label: string): void {
	if (!name || basename(name) !== name || name.includes("\\") || name.includes("\0")) {
		throw new Error(`${label} must be a plain file name`);
	}
}

async function listRecentFiles(directory: string, suffix: string): Promise<RecentFile[]> {
	const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
		if (isMissingFile(error)) return [];
		throw error;
	});
	const files = await Promise.all(
		entries
			.filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
			.map(async (entry) => ({ name: entry.name, mtimeMs: (await stat(join(directory, entry.name))).mtimeMs })),
	);
	return files.sort((left, right) => right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name));
}

async function restoreEvent(event: RecordedEvent, paths: EvoPaths): Promise<Record<string, unknown>> {
	const restored: Record<string, unknown> = { ...event };
	switch (event.type) {
		case "before_agent_start":
			restored.prompt = await resolveStoredPayload(paths, event.prompt);
			restored.systemPrompt = await resolveStoredPayload(paths, event.systemPrompt);
			restored.systemPromptOptions = await resolveStoredPayload(paths, event.systemPromptOptions);
			if (event.images) restored.images = await resolveStoredPayload(paths, event.images);
			break;
		case "message":
			restored.message = await resolveStoredPayload(paths, event.message);
			break;
		case "tool":
			restored.input = await resolveStoredPayload(paths, event.input);
			restored.result = await resolveStoredPayload(paths, event.result);
			break;
		case "git_diff":
			restored.diff = await resolveStoredPayload(paths, event.diff);
			break;
		case "explicit_feedback":
			restored.text = await resolveStoredPayload(paths, event.text);
			break;
	}
	return restored;
}

function containsQuote(value: unknown, quote: string): boolean {
	if (typeof value === "string") return value.includes(quote);
	if (Array.isArray(value)) return value.some((entry) => containsQuote(entry, quote));
	if (!isRecord(value)) return false;
	return Object.values(value).some((entry) => containsQuote(entry, quote));
}

function parseInboxEntry(value: unknown, fileName: string): RecorderInboxEntry {
	if (
		!isRecord(value) ||
		value.schemaVersion !== 1 ||
		typeof value.id !== "string" ||
		!value.id ||
		typeof value.timestamp !== "string" ||
		typeof value.sessionId !== "string" ||
		!value.sessionId ||
		!(["interactive", "rpc", "extension"] as const).includes(value.source as "interactive" | "rpc" | "extension") ||
		typeof value.text !== "string"
	) {
		throw new Error(`Inbox reference is invalid: ${fileName}`);
	}
	return value as unknown as RecorderInboxEntry;
}

async function readInboxEntry(paths: EvoPaths, fileName: string): Promise<RecorderInboxEntry> {
	assertSafeFileName(fileName, "Inbox reference");
	if (!fileName.endsWith(".json")) throw new Error(`Inbox reference must be a JSON file: ${fileName}`);
	let source: string;
	try {
		source = await readFile(join(paths.inbox, fileName), "utf8");
	} catch (error) {
		if (isMissingFile(error)) throw new Error(`Inbox reference does not exist: ${fileName}`);
		throw error;
	}
	let value: unknown;
	try {
		value = JSON.parse(source);
	} catch {
		throw new Error(`Inbox reference is invalid JSON: ${fileName}`);
	}
	return parseInboxEntry(value, fileName);
}

function extractMessageText(value: unknown, label: string): string {
	if (!isRecord(value) || value.role !== "user") throw new Error(`${label} must contain a user message`);
	if (typeof value.content === "string") return value.content;
	if (!Array.isArray(value.content)) throw new Error(`${label} has no textual prompt`);
	const parts = value.content.flatMap((entry) => {
		if (!isRecord(entry) || entry.type !== "text" || typeof entry.text !== "string") return [];
		return [entry.text];
	});
	if (parts.length === 0) throw new Error(`${label} has no textual prompt`);
	return parts.join("\n");
}

function asAgentMessage(value: unknown, label: string): AgentMessage {
	if (!isRecord(value) || typeof value.role !== "string" || !("content" in value)) {
		throw new Error(`${label} is not an agent message`);
	}
	if (!(["user", "assistant", "toolResult"] as const).includes(value.role as "user" | "assistant" | "toolResult")) {
		throw new Error(`${label} has an unsupported role: ${value.role}`);
	}
	return value as unknown as AgentMessage;
}

export async function collectEvidenceCorpus(
	paths: EvoPaths,
	options: { maxBytes?: number } = {},
): Promise<EvidenceCorpus> {
	const maxBytes = options.maxBytes ?? DEFAULT_CORPUS_BYTES;
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("maxBytes must be a positive safe integer");
	await ensureEvoLayout(paths);

	let text = "";
	let truncated = false;
	const sessionIds = new Set<string>();
	const inboxFiles: string[] = [];
	const append = (heading: string, value: unknown): boolean => {
		const fragment = `${heading}\n${typeof value === "string" ? value : JSON.stringify(value, undefined, "\t")}`;
		const candidate = text ? `${text}\n\n${fragment}` : fragment;
		if (Buffer.byteLength(candidate, "utf8") > maxBytes) {
			truncated = true;
			return false;
		}
		text = candidate;
		return true;
	};

	let bundleDigest: string | undefined;
	const registry = new BundleRegistry(paths);
	bundleDigest = await registry.readStableDigest();
	if (bundleDigest) {
		const bundle = await loadCompiledBundle(paths, bundleDigest);
		append(`## Current bundle ${bundleDigest} manifest`, bundle.manifest);
		for (const file of bundle.manifest.files) {
			append(`## Current bundle file ${file.path}`, await readFile(join(bundle.directory, file.path), "utf8"));
		}
	}

	try {
		const lines = (await readFile(paths.history, "utf8"))
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.reverse();
		for (const [index, line] of lines.entries()) {
			let entry: unknown;
			try {
				entry = JSON.parse(line);
			} catch {
				throw new Error(`Registry history line ${lines.length - index} is invalid JSON`);
			}
			append(`## Registry history entry ${lines.length - index}`, entry);
		}
	} catch (error) {
		if (!isMissingFile(error)) throw error;
	}

	for (const file of await listRecentFiles(paths.inbox, ".json")) {
		const entry = await readInboxEntry(paths, file.name);
		if (append(`## Explicit request ${file.name}`, entry)) inboxFiles.push(file.name);
	}

	for (const file of await listRecentFiles(paths.log, ".jsonl")) {
		const sessionId = file.name.slice(0, -".jsonl".length);
		let events: RecordedEvent[];
		try {
			events = await readSessionLog(paths, sessionId);
		} catch (error) {
			throw new Error(`Cannot collect session log ${file.name}`, { cause: error });
		}
		for (const event of events) {
			const restored = await restoreEvent(event, paths);
			if (append(`## Session ${sessionId}, sequence ${event.sequence}`, restored)) {
				sessionIds.add(sessionId);
				continue;
			}
			append(`## Session ${sessionId}, sequence ${event.sequence} (artifact omitted by budget)`, event);
		}
	}

	return {
		text,
		bytes: Buffer.byteLength(text, "utf8"),
		maxBytes,
		truncated,
		sessionIds: [...sessionIds],
		inboxFiles,
		...(bundleDigest ? { bundleDigest } : {}),
	};
}

export async function validateDraftGrounding(paths: EvoPaths, draft: DraftProposal): Promise<EvidenceReference[]> {
	const logs = new Map<string, Promise<RecordedEvent[]>>();
	const loadLog = (sessionId: string): Promise<RecordedEvent[]> => {
		const existing = logs.get(sessionId);
		if (existing) return existing;
		const pending = readSessionLog(paths, sessionId);
		logs.set(sessionId, pending);
		return pending;
	};
	const findEvent = async (reference: EvidenceReference | ReplayScenario): Promise<RecordedEvent> => {
		const events = await loadLog(reference.sessionId);
		const event = events.find((candidate) => candidate.sequence === reference.sequence);
		if (!event) throw new Error(`Evidence reference does not exist: ${reference.sessionId}:${reference.sequence}`);
		return event;
	};

	let hasExplicitUserEvidence = false;
	const verified: EvidenceReference[] = [];
	for (const reference of draft.evidence) {
		const event = await findEvent(reference);
		const restored = await restoreEvent(event, paths);
		let quoteVerified = false;
		if (reference.quote !== undefined) {
			if (!reference.quote) throw new Error(`Evidence quote is empty: ${reference.sessionId}:${reference.sequence}`);
			if (!containsQuote(restored, reference.quote)) {
				throw new Error(`Evidence quote was not found: ${reference.sessionId}:${reference.sequence}`);
			}
			quoteVerified = true;
		}
		hasExplicitUserEvidence ||=
			event.type === "explicit_feedback" || (event.type === "message" && event.role === "user" && quoteVerified);
		verified.push({ ...reference });
	}

	for (const scenario of draft.replayScenarios) await findEvent(scenario);
	for (const fileName of draft.inboxReferences) await readInboxEntry(paths, fileName);

	if (draft.source === "pattern") {
		const occurrences = new Set(verified.map((reference) => `${reference.sessionId}:${reference.sequence}`));
		if (occurrences.size < 2)
			throw new Error("Pattern proposals require at least two independent evidence references");
	} else if (draft.inboxReferences.length === 0 && !hasExplicitUserEvidence) {
		throw new Error("Explicit-request proposals require a valid inbox reference or explicit user evidence");
	}
	return verified;
}

export async function loadReplayScenario(paths: EvoPaths, scenario: ReplayScenario): Promise<LoadedReplayScenario> {
	const events = await readSessionLog(paths, scenario.sessionId);
	const target = events.find((event) => event.sequence === scenario.sequence);
	if (!target) throw new Error(`Replay target does not exist: ${scenario.sessionId}:${scenario.sequence}`);
	if (target.type !== "message" || target.role !== "user") {
		throw new Error(`Replay target must be a user message: ${scenario.sessionId}:${scenario.sequence}`);
	}
	const targetMessage = await resolveStoredPayload(paths, target.message);
	const targetPrompt = extractMessageText(targetMessage, "Replay target");

	const beforeStart = [...events]
		.reverse()
		.find((event) => event.sequence < target.sequence && event.type === "before_agent_start");
	if (!beforeStart || beforeStart.type !== "before_agent_start") {
		throw new Error(`Replay target has no preceding system prompt: ${scenario.sessionId}:${scenario.sequence}`);
	}
	const oldSystemPrompt = await resolveStoredPayload(paths, beforeStart.systemPrompt);
	if (typeof oldSystemPrompt !== "string") throw new Error("Recorded system prompt must be a string");

	const sessionStart = [...events]
		.reverse()
		.find((event) => event.sequence <= target.sequence && event.type === "session_start");
	if (!sessionStart || sessionStart.type !== "session_start") {
		throw new Error(`Replay target has no session start: ${scenario.sessionId}:${scenario.sequence}`);
	}

	const history: AgentMessage[] = [];
	for (const event of events) {
		if (event.sequence >= target.sequence) break;
		if (event.type !== "message") continue;
		const message = await resolveStoredPayload(paths, event.message);
		history.push(asAgentMessage(message, `Recorded message ${event.sessionId}:${event.sequence}`));
	}

	return {
		history,
		targetPrompt,
		oldSystemPrompt,
		sessionIdentity: scenario.sessionId,
		cwd: sessionStart.cwd,
	};
}
