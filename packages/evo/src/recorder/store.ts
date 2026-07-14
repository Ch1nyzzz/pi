import { randomUUID } from "node:crypto";
import { type FileHandle, open, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { type EvoPaths, ensureEvoLayout } from "../paths.ts";
import { appendJsonLine, atomicWriteFile, atomicWriteJson, canonicalJson, sha256 } from "../storage.ts";
import { RECORDER_SCHEMA_VERSION, type StoredPayload } from "../types.ts";
import type { RecordedEvent, RecorderEvent, RecorderEventData, RecorderInboxEntry } from "./schema.ts";

const DEFAULT_ARTIFACT_THRESHOLD_BYTES = 16 * 1024;
const DEFAULT_PREVIEW_CHARACTERS = 1_024;

export interface RecorderStoreOptions {
	paths: EvoPaths;
	sessionId: string;
	bundleDigest?: string;
	artifactThresholdBytes?: number;
	previewCharacters?: number;
	now?: () => Date;
}

export interface StoredInboxEntry {
	entry: RecorderInboxEntry;
	path: string;
	fileName: string;
}

export interface RecorderStore {
	paths: EvoPaths;
	sessionId: string;
	bundleDigest: string | null;
	logPath: string;
	append(data: RecorderEventData): Promise<RecorderEvent>;
	storePayload(value: unknown): Promise<StoredPayload>;
	writeInbox(text: string, source: RecorderInboxEntry["source"]): Promise<StoredInboxEntry>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function getErrorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

function validateSessionId(sessionId: string): void {
	if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(sessionId)) {
		throw new Error(`Invalid recorder session id: ${sessionId}`);
	}
}

function normalizeForStorage(value: unknown, ancestors: WeakSet<object> = new WeakSet<object>()): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "undefined") return null;
	if (typeof value === "symbol" || typeof value === "function") return String(value);
	if (value instanceof Date) return value.toISOString();
	if (value instanceof Error) {
		return {
			name: value.name,
			message: value.message,
			stack: value.stack,
		};
	}
	if (value instanceof Uint8Array) {
		return {
			encoding: "base64",
			bytes: value.byteLength,
			data: Buffer.from(value).toString("base64"),
		};
	}
	if (ancestors.has(value)) return "[Circular]";
	ancestors.add(value);
	try {
		if (Array.isArray(value)) return value.map((item) => normalizeForStorage(item, ancestors));
		const record = value as Record<string, unknown>;
		const normalized: Record<string, unknown> = {};
		for (const key of Object.keys(record)) {
			try {
				normalized[key] = normalizeForStorage(record[key], ancestors);
			} catch (error) {
				normalized[key] = `[Unreadable: ${error instanceof Error ? error.message : String(error)}]`;
			}
		}
		return normalized;
	} finally {
		ancestors.delete(value);
	}
}

function makePreview(content: string, previewCharacters: number): string {
	if (content.length <= previewCharacters) return content;
	return `${content.slice(0, previewCharacters)}\n…`;
}

function readSequence(value: unknown, expected: number, logPath: string, lineNumber: number): number {
	if (
		!isRecord(value) ||
		typeof value.sequence !== "number" ||
		!Number.isSafeInteger(value.sequence) ||
		value.sequence !== expected
	) {
		throw new Error(`Invalid recorder sequence at ${logPath}:${lineNumber}`);
	}
	return value.sequence;
}

function parseTerminatedLine(line: string, expected: number, logPath: string, lineNumber: number): number {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line) as unknown;
	} catch (error) {
		throw new Error(`Malformed recorder log line at ${logPath}:${lineNumber}`, { cause: error });
	}
	return readSequence(parsed, expected, logPath, lineNumber);
}

async function readLastSequence(logPath: string): Promise<number> {
	let handle: FileHandle | undefined;
	try {
		handle = await open(logPath, "r+");
	} catch (error) {
		if (getErrorCode(error) === "ENOENT") return 0;
		throw error;
	}

	try {
		const content = await handle.readFile();
		if (content.byteLength === 0) return 0;

		const lastNewline = content.lastIndexOf(0x0a);
		const terminatedEnd = lastNewline + 1;
		const terminatedLines = content.subarray(0, terminatedEnd).toString("utf8").split("\n");
		let sequence = 0;
		for (let index = 0; index < terminatedLines.length - 1; index++) {
			sequence = parseTerminatedLine(terminatedLines[index] ?? "", sequence + 1, logPath, index + 1);
		}

		if (terminatedEnd === content.byteLength) return sequence;

		const trailingLine = content.subarray(terminatedEnd).toString("utf8");
		let parsed: unknown;
		try {
			parsed = JSON.parse(trailingLine) as unknown;
		} catch {
			await handle.truncate(terminatedEnd);
			await handle.sync();
			return sequence;
		}

		sequence = readSequence(parsed, sequence + 1, logPath, terminatedLines.length);
		await handle.write("\n", content.byteLength, "utf8");
		await handle.sync();
		return sequence;
	} finally {
		await handle.close();
	}
}

export async function createRecorderStore(options: RecorderStoreOptions): Promise<RecorderStore> {
	validateSessionId(options.sessionId);
	await ensureEvoLayout(options.paths);

	const logPath = join(options.paths.log, `${options.sessionId}.jsonl`);
	const artifactThresholdBytes = Math.max(1, options.artifactThresholdBytes ?? DEFAULT_ARTIFACT_THRESHOLD_BYTES);
	const previewCharacters = Math.max(1, options.previewCharacters ?? DEFAULT_PREVIEW_CHARACTERS);
	const now = options.now ?? (() => new Date());
	const bundleDigest = options.bundleDigest ?? null;
	let sequence = await readLastSequence(logPath);

	async function storePayload(value: unknown): Promise<StoredPayload> {
		const normalized = normalizeForStorage(value);
		const isText = typeof normalized === "string";
		const content = isText ? normalized : canonicalJson(normalized);
		const preview = makePreview(content, previewCharacters);
		const bytes = Buffer.byteLength(content, "utf8");
		if (bytes <= artifactThresholdBytes) {
			return {
				preview,
				value: isText ? normalized : (JSON.parse(content) as unknown),
			};
		}

		const digest = sha256(content);
		await atomicWriteFile(join(options.paths.artifacts, digest), content);
		return {
			preview,
			artifact: {
				sha256: digest,
				bytes,
				mediaType: isText ? "text/plain" : "application/json",
			},
		};
	}

	async function append(data: RecorderEventData): Promise<RecorderEvent> {
		const nextSequence = sequence + 1;
		const event = {
			schemaVersion: RECORDER_SCHEMA_VERSION,
			sessionId: options.sessionId,
			sequence: nextSequence,
			timestamp: now().toISOString(),
			bundleDigest,
			...data,
		} as RecorderEvent;
		await appendJsonLine(logPath, event);
		sequence = nextSequence;
		return event;
	}

	async function writeInbox(text: string, source: RecorderInboxEntry["source"]): Promise<StoredInboxEntry> {
		const id = randomUUID();
		const timestamp = now().toISOString();
		const entry: RecorderInboxEntry = {
			schemaVersion: RECORDER_SCHEMA_VERSION,
			id,
			timestamp,
			sessionId: options.sessionId,
			source,
			text,
		};
		const fileName = `${timestamp.replaceAll(":", "-")}-${id}.json`;
		const path = join(options.paths.inbox, fileName);
		await atomicWriteJson(path, entry);
		return { entry, path, fileName: basename(path) };
	}

	return {
		paths: options.paths,
		sessionId: options.sessionId,
		bundleDigest,
		logPath,
		append,
		storePayload,
		writeInbox,
	};
}

export async function resolveStoredPayload(paths: EvoPaths, payload: StoredPayload): Promise<unknown> {
	if ("value" in payload) return payload.value;
	if (!payload.artifact) return payload.preview;
	if (!/^[a-f0-9]{64}$/.test(payload.artifact.sha256)) {
		throw new Error(`Invalid artifact digest: ${payload.artifact.sha256}`);
	}
	const content = await readFile(join(paths.artifacts, payload.artifact.sha256), "utf8");
	if (sha256(content) !== payload.artifact.sha256) {
		throw new Error(`Artifact digest mismatch: ${payload.artifact.sha256}`);
	}
	if (Buffer.byteLength(content, "utf8") !== payload.artifact.bytes) {
		throw new Error(`Artifact byte length mismatch: ${payload.artifact.sha256}`);
	}
	return payload.artifact.mediaType === "application/json" ? (JSON.parse(content) as unknown) : content;
}

export async function readSessionLog(paths: EvoPaths, sessionId: string): Promise<RecordedEvent[]> {
	validateSessionId(sessionId);
	let content: string;
	try {
		content = await readFile(join(paths.log, `${sessionId}.jsonl`), "utf8");
	} catch (error) {
		if (getErrorCode(error) === "ENOENT") return [];
		throw error;
	}

	const events: RecordedEvent[] = [];
	for (const [index, line] of content.split("\n").entries()) {
		if (!line.trim()) continue;
		const parsed = JSON.parse(line) as unknown;
		if (
			!isRecord(parsed) ||
			parsed.schemaVersion !== RECORDER_SCHEMA_VERSION ||
			typeof parsed.type !== "string" ||
			typeof parsed.timestamp !== "string" ||
			parsed.sessionId !== sessionId ||
			typeof parsed.sequence !== "number" ||
			!Number.isSafeInteger(parsed.sequence) ||
			parsed.sequence !== events.length + 1
		) {
			throw new Error(`Invalid recorder event at ${sessionId}.jsonl:${index + 1}`);
		}
		events.push(parsed as unknown as RecordedEvent);
	}
	return events;
}
