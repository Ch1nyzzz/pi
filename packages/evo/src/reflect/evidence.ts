import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { loadCompiledBundle } from "../bundle/compile.ts";
import { readInboxLifecycleStates } from "../inbox.ts";
import { type EvoPaths, ensureEvoLayout } from "../paths.ts";
import type { DraftProposal } from "../proposal.ts";
import { listSessionDigests } from "../recorder/digest.ts";
import type { RecordedEvent, RecorderInboxEntry } from "../recorder/schema.ts";
import { readSessionLog, resolveStoredPayload } from "../recorder/store.ts";
import { BundleRegistry } from "../registry/registry.ts";
import { atomicWriteJson, canonicalJson, readJsonIfExists, sha256, withFileLock } from "../storage.ts";
import type { EvidenceReference, ReplayScenario } from "../types.ts";

// Safe default for consumers that inline the corpus text into a prompt.
const DEFAULT_CORPUS_BYTES = 1024 * 1024;
// Budget for the materialized on-disk corpus (prompts carry only an index there);
// raising it costs disk, never context-window tokens. Callers opt in explicitly.
export const MATERIALIZED_CORPUS_BYTES = 8 * 1024 * 1024;
const REVIEW_CURSOR_SCHEMA_VERSION = 1;
const REVIEW_CURSOR_FILE = "review-cursor.json";
const SOURCE_SEPARATOR = "\n\n";
// Percentage caps for the fixed sources. Sessions — the behavioral evidence — has no
// weight: it receives the entire budget the fixed sources leave unused.
const SOURCE_WEIGHTS = {
	bundle: 30,
	history: 15,
	inbox: 20,
	sessions: 35,
} as const;
const FIXED_SOURCES = ["bundle", "history", "inbox"] as const;

export type EvidenceSource = keyof typeof SOURCE_WEIGHTS;

export interface EvidenceSourceSummary {
	bytes: number;
	maxBytes: number;
	truncated: boolean;
}

/** One corpus section with its structured value, used to materialize the corpus on disk. */
export interface EvidenceFragment {
	source: EvidenceSource;
	heading: string;
	value: unknown;
	sessionId?: string;
}

export interface EvidenceReviewCursor {
	schemaVersion: 1;
	updatedAt: string;
	inboxFiles: string[];
	sessionSequences: Record<string, number>;
}

export interface CollectEvidenceCorpusOptions {
	maxBytes?: number;
	mode?: "full" | "incremental";
	reviewCursor?: EvidenceReviewCursor;
	completedSessionsOnly?: boolean;
	now?: () => Date;
}

export interface EvidenceCorpus {
	text: string;
	bytes: number;
	maxBytes: number;
	truncated: boolean;
	mode: "full" | "incremental";
	evidenceDigest: string;
	sources: Record<EvidenceSource, EvidenceSourceSummary>;
	fragments: EvidenceFragment[];
	sessionIds: string[];
	inboxFiles: string[];
	nextReviewCursor: EvidenceReviewCursor;
	bundleDigest?: string;
}

export interface LoadedReplayScenario {
	history: AgentMessage[];
	targetPrompt: string;
	oldSystemPrompt: string;
	systemPromptOptions: unknown;
	sessionIdentity: string;
	cwd: string;
}

interface EvidenceFile {
	name: string;
	mtimeMs: number;
}

interface SourceCollector {
	append(heading: string, value: unknown, sessionId?: string): boolean;
	text(): string;
	summary(): EvidenceSourceSummary;
	fragments(): EvidenceFragment[];
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

function parseReviewCursor(value: unknown): EvidenceReviewCursor {
	if (!isRecord(value)) throw new Error("Stored evidence review cursor must be an object");
	const allowedKeys = new Set(["schemaVersion", "updatedAt", "inboxFiles", "sessionSequences"]);
	if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
		throw new Error("Stored evidence review cursor has unknown fields");
	}
	if (
		value.schemaVersion !== REVIEW_CURSOR_SCHEMA_VERSION ||
		typeof value.updatedAt !== "string" ||
		!Number.isFinite(Date.parse(value.updatedAt)) ||
		!Array.isArray(value.inboxFiles) ||
		value.inboxFiles.some((file) => typeof file !== "string") ||
		!isRecord(value.sessionSequences)
	) {
		throw new Error("Stored evidence review cursor is invalid");
	}
	const inboxFiles = value.inboxFiles as string[];
	for (const file of inboxFiles) {
		assertSafeFileName(file, "Stored evidence review cursor inbox file");
		if (!file.endsWith(".json")) throw new Error("Stored evidence review cursor inbox file must be JSON");
	}
	if (new Set(inboxFiles).size !== inboxFiles.length) {
		throw new Error("Stored evidence review cursor contains duplicate inbox files");
	}
	const sessionSequences: Record<string, number> = {};
	for (const [sessionId, sequence] of Object.entries(value.sessionSequences)) {
		if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(sessionId)) {
			throw new Error("Stored evidence review cursor contains an invalid session id");
		}
		if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence <= 0) {
			throw new Error("Stored evidence review cursor contains an invalid session sequence");
		}
		sessionSequences[sessionId] = sequence;
	}
	return {
		schemaVersion: 1,
		updatedAt: value.updatedAt,
		inboxFiles: [...inboxFiles].sort(),
		sessionSequences: Object.fromEntries(
			Object.entries(sessionSequences).sort(([left], [right]) => left.localeCompare(right)),
		),
	};
}

function reviewCursorPath(paths: EvoPaths): string {
	return join(paths.registry, REVIEW_CURSOR_FILE);
}

export async function readEvidenceReviewCursor(paths: EvoPaths): Promise<EvidenceReviewCursor | undefined> {
	await ensureEvoLayout(paths);
	const cursor = await readJsonIfExists<unknown>(reviewCursorPath(paths));
	return cursor === undefined ? undefined : parseReviewCursor(cursor);
}

function mergeReviewCursors(
	existing: EvidenceReviewCursor | undefined,
	candidate: EvidenceReviewCursor,
): EvidenceReviewCursor {
	const inboxFiles = new Set([...(existing?.inboxFiles ?? []), ...candidate.inboxFiles]);
	const sessionSequences: Record<string, number> = { ...(existing?.sessionSequences ?? {}) };
	for (const [sessionId, sequence] of Object.entries(candidate.sessionSequences)) {
		sessionSequences[sessionId] = Math.max(sessionSequences[sessionId] ?? 0, sequence);
	}
	const updatedAt =
		existing && Date.parse(existing.updatedAt) > Date.parse(candidate.updatedAt)
			? existing.updatedAt
			: candidate.updatedAt;
	return parseReviewCursor({
		schemaVersion: 1,
		updatedAt,
		inboxFiles: [...inboxFiles],
		sessionSequences,
	});
}

export async function advanceEvidenceReviewCursor(
	paths: EvoPaths,
	candidate: EvidenceReviewCursor,
): Promise<EvidenceReviewCursor> {
	const validatedCandidate = parseReviewCursor(candidate);
	return withFileLock(paths, "evidence-review-cursor", async () => {
		const existing = await readEvidenceReviewCursor(paths);
		const merged = mergeReviewCursors(existing, validatedCandidate);
		await atomicWriteJson(reviewCursorPath(paths), merged);
		return merged;
	});
}

function allocateSourceBudgets(maxBytes: number): Record<(typeof FIXED_SOURCES)[number], number> {
	const separatorBytes = Buffer.byteLength(SOURCE_SEPARATOR, "utf8") * FIXED_SOURCES.length;
	const available = Math.max(0, maxBytes - Math.min(maxBytes, separatorBytes));
	return Object.fromEntries(
		FIXED_SOURCES.map((source) => [source, Math.floor((available * SOURCE_WEIGHTS[source]) / 100)]),
	) as Record<(typeof FIXED_SOURCES)[number], number>;
}

function createSourceCollector(source: EvidenceSource, maxBytes: number): SourceCollector {
	let sourceText = "";
	let truncated = false;
	const collected: EvidenceFragment[] = [];
	return {
		append(heading, value, sessionId) {
			const fragment = `${heading}\n${typeof value === "string" ? value : JSON.stringify(value, undefined, "\t")}`;
			const candidate = sourceText ? `${sourceText}${SOURCE_SEPARATOR}${fragment}` : fragment;
			if (Buffer.byteLength(candidate, "utf8") > maxBytes) {
				truncated = true;
				return false;
			}
			sourceText = candidate;
			collected.push({ source, heading, value, ...(sessionId ? { sessionId } : {}) });
			return true;
		},
		text: () => sourceText,
		summary: () => ({ bytes: Buffer.byteLength(sourceText, "utf8"), maxBytes, truncated }),
		fragments: () => [...collected],
	};
}

async function listEvidenceFiles(
	directory: string,
	suffix: string,
	order: "oldest" | "newest",
): Promise<EvidenceFile[]> {
	const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
		if (isMissingFile(error)) return [];
		throw error;
	});
	const files = await Promise.all(
		entries
			.filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
			.map(async (entry): Promise<EvidenceFile | undefined> => {
				try {
					const metadata = await lstat(join(directory, entry.name));
					if (!metadata.isFile()) return undefined;
					return { name: entry.name, mtimeMs: metadata.mtimeMs };
				} catch (error) {
					if (isMissingFile(error)) return undefined;
					throw error;
				}
			}),
	);
	const direction = order === "oldest" ? 1 : -1;
	return files
		.filter((file): file is EvidenceFile => file !== undefined)
		.sort((left, right) => direction * (left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name)));
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

async function fullEvidenceStateDigest(
	paths: EvoPaths,
	bundleDigest: string | undefined,
	digests: Awaited<ReturnType<typeof listSessionDigests>>,
): Promise<string> {
	const sessionDigests = digests.map((digest) => ({
		sessionId: digest.sessionId,
		sourceDigest: digest.sourceDigest,
	}));
	const inbox = await Promise.all(
		(await listEvidenceFiles(paths.inbox, ".json", "oldest")).map(async (file) => ({
			file: file.name,
			sha256: sha256(await readFile(join(paths.inbox, file.name), "utf8")),
		})),
	);
	let history = "";
	let inboxHistory = "";
	try {
		history = await readFile(paths.history, "utf8");
	} catch (error) {
		if (!isMissingFile(error)) throw error;
	}
	try {
		inboxHistory = await readFile(paths.inboxHistory, "utf8");
	} catch (error) {
		if (!isMissingFile(error)) throw error;
	}
	return sha256(
		canonicalJson({
			fullEvidenceSchemaVersion: 1,
			bundleDigest: bundleDigest ?? null,
			history: sha256(history),
			inboxHistory: sha256(inboxHistory),
			inbox,
			sessions: sessionDigests,
		}),
	);
}

function compactSessionDigest(digest: Awaited<ReturnType<typeof listSessionDigests>>[number]) {
	const metrics = Object.fromEntries(
		Object.entries(digest.metrics).filter(([key, value]) =>
			key === "usage" ? digest.metrics.usage.totalTokens > 0 : value !== 0,
		),
	);
	return {
		schemaVersion: digest.schemaVersion,
		sessionId: digest.sessionId,
		bundleDigest: digest.bundleDigest,
		taskClass: digest.taskClass,
		startedAt: digest.startedAt,
		endedAt: digest.endedAt,
		complete: digest.complete,
		lastSequence: digest.lastSequence,
		sourceDigest: digest.sourceDigest,
		preferenceEvidence: digest.preferenceEvidence,
		assessment: digest.assessment,
		metrics,
	};
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
	options: CollectEvidenceCorpusOptions = {},
): Promise<EvidenceCorpus> {
	const maxBytes = options.maxBytes ?? DEFAULT_CORPUS_BYTES;
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("maxBytes must be a positive safe integer");
	const mode = options.mode ?? "full";
	if (mode === "full" && options.reviewCursor !== undefined) {
		throw new Error("A review cursor can only be used with incremental evidence collection");
	}
	await ensureEvoLayout(paths);

	const sourceBudgets = allocateSourceBudgets(maxBytes);
	const collectors = {
		bundle: createSourceCollector("bundle", sourceBudgets.bundle),
		history: createSourceCollector("history", sourceBudgets.history),
		inbox: createSourceCollector("inbox", sourceBudgets.inbox),
	} as Record<EvidenceSource, SourceCollector>;
	const previousCursor =
		mode === "incremental" && options.reviewCursor ? parseReviewCursor(options.reviewCursor) : undefined;
	const reviewedInboxFiles = new Set(previousCursor?.inboxFiles ?? []);
	const inboxLifecycle = await readInboxLifecycleStates(paths);
	const nextInboxFiles = new Set(previousCursor?.inboxFiles ?? []);
	const nextSessionSequences: Record<string, number> = { ...(previousCursor?.sessionSequences ?? {}) };
	const sessionIds = new Set<string>();
	const inboxFiles: string[] = [];

	let bundleDigest: string | undefined;
	const registry = new BundleRegistry(paths);
	bundleDigest = await registry.readStableDigest();
	if (bundleDigest) {
		const bundle = await loadCompiledBundle(paths, bundleDigest);
		if (!collectors.bundle.append(`## Current bundle ${bundleDigest} manifest`, bundle.manifest)) {
			collectors.bundle.append(`## Current bundle ${bundleDigest}`, {
				summary: bundle.manifest.summary,
				parentDigest: bundle.manifest.parentDigest,
				manifestOmittedByBudget: true,
			});
		}
		for (const file of bundle.manifest.files) {
			collectors.bundle.append(
				`## Current bundle file ${file.path}`,
				await readFile(join(bundle.directory, file.path), "utf8"),
			);
		}
	}

	for (const [path, heading] of [
		[paths.history, "Registry history"],
		[paths.inboxHistory, "Inbox lifecycle"],
	] as const) {
		try {
			const lines = (await readFile(path, "utf8"))
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean)
				.reverse();
			for (const [index, line] of lines.entries()) {
				let entry: unknown;
				try {
					entry = JSON.parse(line);
				} catch {
					throw new Error(`${heading} line ${lines.length - index} is invalid JSON`);
				}
				collectors.history.append(`## ${heading} entry ${lines.length - index}`, entry);
			}
		} catch (error) {
			if (!isMissingFile(error)) throw error;
		}
	}

	for (const file of await listEvidenceFiles(paths.inbox, ".json", mode === "incremental" ? "oldest" : "newest")) {
		const lifecycle = inboxLifecycle.get(file.name);
		if (
			lifecycle?.status === "materialized" ||
			lifecycle?.status === "fulfilled" ||
			lifecycle?.status === "dismissed" ||
			lifecycle?.status === "superseded"
		) {
			continue;
		}
		if (!lifecycle && reviewedInboxFiles.has(file.name)) continue;
		const entry = await readInboxEntry(paths, file.name);
		if (!collectors.inbox.append(`## Explicit input ${file.name}`, { entry, lifecycle: lifecycle ?? null })) break;
		inboxFiles.push(file.name);
		nextInboxFiles.add(file.name);
	}

	// Soft quota: sessions (the behavioral evidence) receive every byte the fixed
	// sources did not use, not a fixed share.
	const fixedBytes = FIXED_SOURCES.reduce((sum, source) => sum + collectors[source].summary().bytes, 0);
	const separatorReserve = Buffer.byteLength(SOURCE_SEPARATOR, "utf8") * FIXED_SOURCES.length;
	collectors.sessions = createSourceCollector("sessions", Math.max(0, maxBytes - fixedBytes - separatorReserve));

	const allDigests = await listSessionDigests(paths);
	const digests = options.completedSessionsOnly ? allDigests.filter((digest) => digest.complete) : allDigests;
	const orderedDigests = mode === "incremental" ? digests : [...digests].reverse();
	let sessionBudgetFull = false;
	for (const digest of orderedDigests) {
		const reviewedSequence = previousCursor?.sessionSequences[digest.sessionId] ?? 0;
		if (digest.lastSequence <= reviewedSequence) continue;
		let events: RecordedEvent[];
		try {
			events = await readSessionLog(paths, digest.sessionId);
		} catch (error) {
			throw new Error(`Cannot collect session log ${digest.sessionId}.jsonl`, { cause: error });
		}
		if (reviewedSequence === 0) {
			if (
				!collectors.sessions.append(
					`## Session digest ${digest.sessionId}`,
					compactSessionDigest(digest),
					digest.sessionId,
				)
			) {
				break;
			}
			sessionIds.add(digest.sessionId);
		}
		for (const event of events) {
			if (event.sequence <= reviewedSequence) continue;
			const restored = await restoreEvent(event, paths);
			if (
				collectors.sessions.append(
					`## Session ${digest.sessionId}, sequence ${event.sequence}`,
					restored,
					digest.sessionId,
				)
			) {
				sessionIds.add(digest.sessionId);
				nextSessionSequences[digest.sessionId] = event.sequence;
				continue;
			}
			if (
				collectors.sessions.append(
					`## Session ${digest.sessionId}, sequence ${event.sequence} (artifact omitted by budget)`,
					event,
					digest.sessionId,
				)
			) {
				sessionIds.add(digest.sessionId);
				nextSessionSequences[digest.sessionId] = event.sequence;
				continue;
			}
			sessionBudgetFull = true;
			break;
		}
		if (sessionBudgetFull) break;
	}

	const sourceOrder = Object.keys(SOURCE_WEIGHTS) as EvidenceSource[];
	const sourceTexts = sourceOrder.map((source) => collectors[source].text()).filter(Boolean);
	const text = sourceTexts.join(SOURCE_SEPARATOR);
	const sources = Object.fromEntries(sourceOrder.map((source) => [source, collectors[source].summary()])) as Record<
		EvidenceSource,
		EvidenceSourceSummary
	>;
	const nextReviewCursor = parseReviewCursor({
		schemaVersion: 1,
		updatedAt: (options.now ?? (() => new Date()))().toISOString(),
		inboxFiles: [...nextInboxFiles],
		sessionSequences: nextSessionSequences,
	});
	const evidenceDigest =
		mode === "full"
			? await fullEvidenceStateDigest(paths, bundleDigest, digests)
			: sha256(
					canonicalJson({
						bundleDigest: bundleDigest ?? null,
						cutoff: {
							inboxFiles: nextReviewCursor.inboxFiles,
							sessionSequences: nextReviewCursor.sessionSequences,
						},
						sourceDigests: Object.fromEntries(
							sourceOrder.map((source) => [source, sha256(collectors[source].text())]),
						),
					}),
				);
	return {
		text,
		bytes: Buffer.byteLength(text, "utf8"),
		maxBytes,
		truncated: sourceOrder.some((source) => sources[source].truncated),
		mode,
		evidenceDigest,
		sources,
		fragments: sourceOrder.flatMap((source) => collectors[source].fragments()),
		sessionIds: [...sessionIds],
		inboxFiles,
		nextReviewCursor,
		...(bundleDigest ? { bundleDigest } : {}),
	};
}

export async function validateEvidenceReferences(
	paths: EvoPaths,
	references: readonly EvidenceReference[],
): Promise<EvidenceReference[]> {
	const logs = new Map<string, Promise<RecordedEvent[]>>();
	const verified: EvidenceReference[] = [];
	for (const reference of references) {
		if (!reference.sessionId || !Number.isSafeInteger(reference.sequence) || reference.sequence <= 0) {
			throw new Error("Observation evidence must contain a sessionId and positive sequence");
		}
		let events = logs.get(reference.sessionId);
		if (!events) {
			events = readSessionLog(paths, reference.sessionId);
			logs.set(reference.sessionId, events);
		}
		const event = (await events).find((candidate) => candidate.sequence === reference.sequence);
		if (!event) throw new Error(`Observation evidence does not exist: ${reference.sessionId}:${reference.sequence}`);
		if (reference.quote !== undefined) {
			if (!reference.quote)
				throw new Error(`Observation evidence quote is empty: ${reference.sessionId}:${reference.sequence}`);
			const restored = await restoreEvent(event, paths);
			if (!containsQuote(restored, reference.quote)) {
				throw new Error(`Observation evidence quote was not found: ${reference.sessionId}:${reference.sequence}`);
			}
		}
		verified.push({ ...reference });
	}
	return verified;
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

	let hasExplicitFeedbackEvidence = false;
	let hasExplicitUserRequestEvidence = false;
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
		hasExplicitFeedbackEvidence ||= event.type === "explicit_feedback" && quoteVerified;
		hasExplicitUserRequestEvidence ||= event.type === "message" && event.role === "user" && quoteVerified;
		verified.push({ ...reference });
	}

	for (const scenario of draft.replayScenarios) await findEvent(scenario);
	let hasExplicitInboxInput = false;
	for (const fileName of draft.inboxReferences) {
		const entry = await readInboxEntry(paths, fileName);
		hasExplicitInboxInput ||=
			entry.kind === "request" ||
			entry.kind === "preference" ||
			entry.text.trimStart().startsWith("REQUEST:") ||
			entry.text.trimStart().startsWith("PREFERENCE:");
	}

	if (draft.source === "pattern") {
		const unique = new Map(
			verified.map((reference) => [`${reference.sessionId}:${reference.sequence}`, reference] as const),
		);
		const sessions = new Set([...unique.values()].map((reference) => reference.sessionId));
		let independent = sessions.size >= 2;
		if (!independent) {
			const references = [...unique.values()].sort((left, right) => left.sequence - right.sequence);
			independent = references.some((reference, index) => {
				const next = references[index + 1];
				return (
					next !== undefined &&
					reference.quote !== undefined &&
					next.quote !== undefined &&
					next.sequence - reference.sequence >= 2
				);
			});
		}
		if (!independent) throw new Error("Pattern proposals require at least two independent evidence references");
	} else if (!hasExplicitInboxInput && !hasExplicitFeedbackEvidence && !hasExplicitUserRequestEvidence) {
		throw new Error("Explicit-request proposals require a REQUEST inbox entry or quoted user request");
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
	const systemPromptOptions = await resolveStoredPayload(paths, beforeStart.systemPromptOptions);

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
		systemPromptOptions,
		sessionIdentity: scenario.sessionId,
		cwd: sessionStart.cwd,
	};
}
