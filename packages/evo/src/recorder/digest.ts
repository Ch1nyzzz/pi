import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { EvoPaths } from "../paths.ts";
import { ensureEvoLayout } from "../paths.ts";
import { atomicWriteJson, canonicalJson, readJsonIfExists, sha256 } from "../storage.ts";
import type { UsageSummary } from "../types.ts";
import type { RecordedEvent } from "./schema.ts";
import { readSessionLog } from "./store.ts";

export interface SessionDigestMetrics {
	tasks: number;
	userMessages: number;
	assistantMessages: number;
	toolResults: number;
	followUpUserMessages: number;
	toolCalls: number;
	toolErrors: number;
	toolDurationMs: number;
	verificationRuns: number;
	verificationPassed: number;
	verificationFailed: number;
	preferenceSignals: number;
	compactions: number;
	compactionRetries: number;
	compactionDurationMs: number;
	compactionTokensBefore: number;
	usage: UsageSummary;
}

export type SessionTaskClass = "coding" | "research" | "tool-use" | "conversation";

export interface SessionDigest {
	schemaVersion: 2;
	sessionId: string;
	bundleDigest: string | null;
	taskClass: SessionTaskClass;
	cwd?: string;
	startedAt?: string;
	endedAt?: string;
	complete: boolean;
	firstSequence: number;
	lastSequence: number;
	sourceDigest: string;
	models: string[];
	preferenceEvidence: Array<{ sequence: number }>;
	assessment: {
		verification: "passed" | "failed" | "not-observed";
		comparisonEligible: boolean;
		exclusionReasons: string[];
	};
	metrics: SessionDigestMetrics;
}

function emptyUsage(): UsageSummary {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
}

function createSessionDigest(events: readonly RecordedEvent[]): SessionDigest | undefined {
	const first = events[0];
	const last = events.at(-1);
	if (!first || !last) return undefined;
	const usage = emptyUsage();
	const models = new Set<string>();
	const preferenceEvidence: Array<{ sequence: number }> = [];
	let tasks = 0;
	let userMessages = 0;
	let assistantMessages = 0;
	let toolResults = 0;
	let followUpUserMessages = 0;
	let toolCalls = 0;
	let toolErrors = 0;
	let toolDurationMs = 0;
	let verificationRuns = 0;
	let verificationPassed = 0;
	let verificationFailed = 0;
	let compactions = 0;
	let compactionRetries = 0;
	let compactionDurationMs = 0;
	let compactionTokensBefore = 0;
	let assistantSeen = false;
	let hasCodingTool = false;
	let hasResearchTool = false;
	let hasTool = false;
	let cwd: string | undefined;
	let startedAt: string | undefined;
	let endedAt: string | undefined;

	for (const event of events) {
		switch (event.type) {
			case "session_start":
				cwd ??= event.cwd;
				startedAt ??= event.timestamp;
				break;
			case "session_end":
				endedAt = event.timestamp;
				break;
			case "before_agent_start":
				tasks += 1;
				break;
			case "message":
				if (event.role === "user") {
					userMessages += 1;
					if (assistantSeen) followUpUserMessages += 1;
				} else if (event.role === "assistant") {
					assistantMessages += 1;
					assistantSeen = true;
				} else if (event.role === "toolResult") {
					toolResults += 1;
				}
				break;
			case "tool":
				toolCalls += 1;
				hasTool = true;
				hasCodingTool ||=
					event.verification !== undefined ||
					/(?:^|[-_])(edit|write|patch|bash|shell|test|compile)(?:$|[-_])/i.test(event.toolName);
				hasResearchTool ||= /(?:search|fetch|browser|web|docs?)/i.test(event.toolName);
				toolErrors += event.isError ? 1 : 0;
				toolDurationMs += event.durationMs;
				if (event.verification) {
					verificationRuns += 1;
					if (event.verification.exitCode === 0) verificationPassed += 1;
					else verificationFailed += 1;
				}
				break;
			case "usage":
				models.add(`${event.provider}/${event.model}`);
				usage.input += event.usage.input;
				usage.output += event.usage.output;
				usage.cacheRead += event.usage.cacheRead;
				usage.cacheWrite += event.usage.cacheWrite;
				usage.totalTokens += event.usage.totalTokens;
				break;
			case "explicit_feedback":
				preferenceEvidence.push({ sequence: event.sequence });
				break;
			case "compaction":
				compactions += 1;
				compactionRetries += event.willRetry ? 1 : 0;
				compactionDurationMs += event.durationMs ?? 0;
				compactionTokensBefore += event.tokensBefore;
				break;
		}
	}

	const taskClass: SessionTaskClass = hasCodingTool
		? "coding"
		: hasResearchTool
			? "research"
			: hasTool
				? "tool-use"
				: "conversation";
	const complete = endedAt !== undefined;
	const exclusionReasons = [
		...(!complete ? ["session is incomplete"] : []),
		...(tasks === 0 ? ["session contains no agent task"] : []),
	];
	return {
		schemaVersion: 2,
		sessionId: first.sessionId,
		bundleDigest: first.bundleDigest,
		taskClass,
		...(cwd ? { cwd } : {}),
		...(startedAt ? { startedAt } : {}),
		...(endedAt ? { endedAt } : {}),
		complete,
		firstSequence: first.sequence,
		lastSequence: last.sequence,
		sourceDigest: sha256(canonicalJson(events)),
		models: [...models].sort(),
		preferenceEvidence,
		assessment: {
			verification: verificationRuns === 0 ? "not-observed" : verificationFailed > 0 ? "failed" : "passed",
			comparisonEligible: exclusionReasons.length === 0,
			exclusionReasons,
		},
		metrics: {
			tasks,
			userMessages,
			assistantMessages,
			toolResults,
			followUpUserMessages,
			toolCalls,
			toolErrors,
			toolDurationMs,
			verificationRuns,
			verificationPassed,
			verificationFailed,
			preferenceSignals: preferenceEvidence.length,
			compactions,
			compactionRetries,
			compactionDurationMs,
			compactionTokensBefore,
			usage,
		},
	};
}

export async function buildSessionDigest(paths: EvoPaths, sessionId: string): Promise<SessionDigest | undefined> {
	const digest = createSessionDigest(await readSessionLog(paths, sessionId));
	if (!digest) return undefined;
	await atomicWriteJson(join(paths.digests, `${sessionId}.json`), digest);
	return digest;
}

export async function readSessionDigest(paths: EvoPaths, sessionId: string): Promise<SessionDigest | undefined> {
	return readJsonIfExists<SessionDigest>(join(paths.digests, `${sessionId}.json`));
}

export async function listSessionDigests(paths: EvoPaths): Promise<SessionDigest[]> {
	await ensureEvoLayout(paths);
	const entries = await readdir(paths.log, { withFileTypes: true });
	const digests: SessionDigest[] = [];
	for (const entry of entries
		.filter((item) => item.isFile() && item.name.endsWith(".jsonl"))
		.sort((a, b) => a.name.localeCompare(b.name))) {
		const sessionId = entry.name.slice(0, -".jsonl".length);
		const stored = await readSessionDigest(paths, sessionId);
		if (stored?.schemaVersion === 2 && stored.complete) {
			digests.push(stored);
			continue;
		}
		const current = createSessionDigest(await readSessionLog(paths, sessionId));
		if (!current) continue;
		if (stored?.sourceDigest !== current.sourceDigest) {
			await atomicWriteJson(join(paths.digests, `${sessionId}.json`), current);
		}
		digests.push(current);
	}
	return digests.sort(
		(left, right) =>
			(left.startedAt ?? "").localeCompare(right.startedAt ?? "") || left.sessionId.localeCompare(right.sessionId),
	);
}
