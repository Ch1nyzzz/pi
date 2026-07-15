import type { StoredPayload, UsageSummary } from "../types.ts";

export type SessionStartReason = "startup" | "reload" | "new" | "resume" | "fork";
export type SessionEndReason = "quit" | "reload" | "new" | "resume" | "fork";
export type VerificationKind = "test" | "lint" | "build" | "typecheck" | "check";

export interface RecorderEventBase {
	schemaVersion: 1;
	sessionId: string;
	sequence: number;
	timestamp: string;
	bundleDigest: string | null;
}

export interface SessionStartRecord {
	type: "session_start";
	reason: SessionStartReason;
	cwd: string;
	sessionFile?: string;
	previousSessionFile?: string;
}

export interface SessionEndRecord {
	type: "session_end";
	reason: SessionEndReason;
	targetSessionFile?: string;
}

export interface BeforeAgentStartRecord {
	type: "before_agent_start";
	prompt: StoredPayload;
	systemPrompt: StoredPayload;
	systemPromptOptions: StoredPayload;
	images?: StoredPayload;
}

export interface MessageRecord {
	type: "message";
	role: string;
	message: StoredPayload;
	/** Pi session entry id, used to deduplicate resume-time backfill. */
	sourceEntryId?: string;
}

export interface UsageRecord {
	type: "usage";
	provider: string;
	model: string;
	usage: UsageSummary;
}

export interface VerificationRecord {
	kind: VerificationKind;
	command: string;
	exitCode: number | null;
}

export interface ToolRecord {
	type: "tool";
	toolCallId: string;
	toolName: string;
	startedAt: string;
	endedAt: string;
	durationMs: number;
	input: StoredPayload;
	result: StoredPayload;
	isError: boolean;
	verification?: VerificationRecord;
}

export interface GitDiffRecord {
	type: "git_diff";
	cwd: string;
	clean: boolean;
	diff: StoredPayload;
}

export interface ExplicitFeedbackRecord {
	type: "explicit_feedback";
	source: "interactive" | "rpc" | "extension";
	text: StoredPayload;
	inboxFile: string;
}

export interface CompactionRecord {
	type: "compaction";
	reason: "manual" | "threshold" | "overflow";
	willRetry: boolean;
	fromExtension: boolean;
	firstKeptEntryId: string;
	tokensBefore: number;
	durationMs: number | null;
	summary: StoredPayload;
	details?: StoredPayload;
}

export type RecorderEventData =
	| SessionStartRecord
	| SessionEndRecord
	| BeforeAgentStartRecord
	| MessageRecord
	| UsageRecord
	| ToolRecord
	| GitDiffRecord
	| ExplicitFeedbackRecord
	| CompactionRecord;

export type RecorderEvent = RecorderEventBase & RecorderEventData;
export type RecordedEvent = RecorderEvent;

export type RecorderInboxKind = "candidate" | "preference" | "request" | "note";

export interface RecorderInboxEntry {
	schemaVersion: 1;
	id: string;
	timestamp: string;
	sessionId: string;
	source: "interactive" | "rpc" | "extension";
	text: string;
	/** Legacy entries omit this and are classified from their text prefix. */
	kind?: RecorderInboxKind;
}

export interface RecorderSessionReference {
	schemaVersion: 1;
	sessionId: string;
	logPath: string;
	bundleDigest: string | null;
}
