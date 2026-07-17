import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ThinkingLevel } from "@ch1nyzzz/pi-agent-core";
import { StringEnum } from "@ch1nyzzz/pi-ai";
import { Type } from "typebox";
import { initializeInboxLifecycle } from "../inbox.ts";
import type { EvoPaths } from "../paths.ts";
import { listSessionDigests, type SessionDigest } from "../recorder/digest.ts";
import type { RecorderInboxEntry } from "../recorder/schema.ts";
import type { ModelRunner } from "../reflect/model-runner.ts";
import { recordModelUsage } from "../reflect/usage.ts";
import { atomicWriteJson, readJsonIfExists } from "../storage.ts";

const TRIAGE_CURSOR_FILE = "triage-cursor.json";
const MAX_HYPOTHESES = 5;
const MAX_DIGEST_LINES = 40;

const TRIAGE_SYSTEM_PROMPT = [
	"You are the Evo-Pi session triage scout: the cheapest, earliest stage of the harness self-improvement loop.",
	"You read compact per-session telemetry digests and flag directions worth a deeper evolution investigation.",
	"Propose a hypothesis only when the telemetry shows real friction (tool errors, failed verification,",
	"user follow-up corrections, repeated compaction pressure). Fewer, sharper hypotheses beat many vague ones.",
	"Propose nothing when the sessions look healthy.",
].join(" ");

interface TriageCursor {
	schemaVersion: 1;
	lastSessionKey: string;
	lastRunAt: string;
}

export interface TriageHypothesis {
	direction: string;
	summary: string;
	evidenceSessions: string[];
}

export interface SessionTriageOutcome {
	/** False when fewer than `everyNSessions` new complete sessions accumulated. */
	ran: boolean;
	newSessions: number;
	hypotheses: TriageHypothesis[];
	inboxFiles: string[];
}

export interface RunSessionTriageOptions {
	paths: EvoPaths;
	runner: ModelRunner;
	model: string;
	thinkingLevel?: ThinkingLevel;
	everyNSessions: number;
	cwd?: string;
	agentDir?: string;
	signal?: AbortSignal;
	now?: () => Date;
}

function digestKey(digest: SessionDigest): string {
	return `${digest.startedAt ?? ""}|${digest.sessionId}`;
}

function digestLine(digest: SessionDigest): string {
	const metrics = digest.metrics;
	return [
		`- session ${digest.sessionId} (${digest.taskClass})`,
		`tasks=${metrics.tasks}`,
		`toolCalls=${metrics.toolCalls}`,
		`toolErrors=${metrics.toolErrors}`,
		`verification=${digest.assessment.verification}`,
		`followUps=${metrics.followUpUserMessages}`,
		`preferenceSignals=${metrics.preferenceSignals}`,
		`compactions=${metrics.compactions}`,
		`models=${digest.models.join("+") || "none"}`,
	].join(" ");
}

async function readTriageCursor(paths: EvoPaths): Promise<TriageCursor | undefined> {
	const raw = await readJsonIfExists(join(paths.root, TRIAGE_CURSOR_FILE));
	if (typeof raw !== "object" || raw === null) return undefined;
	const cursor = raw as Record<string, unknown>;
	if (
		cursor.schemaVersion !== 1 ||
		typeof cursor.lastSessionKey !== "string" ||
		typeof cursor.lastRunAt !== "string"
	) {
		return undefined;
	}
	return cursor as unknown as TriageCursor;
}

export interface SessionTriageStatus {
	/** ISO timestamp of the last triage run, absent when triage never ran. */
	lastRunAt?: string;
	/** Complete sessions recorded since the cursor (all sessions when no cursor). */
	newSessions: number;
}

/** Read-only view of the triage cursor and the backlog behind it. */
export async function getSessionTriageStatus(paths: EvoPaths): Promise<SessionTriageStatus> {
	const cursor = await readTriageCursor(paths);
	const digests = (await listSessionDigests(paths)).filter((digest) => digest.complete);
	const fresh = cursor ? digests.filter((digest) => digestKey(digest) > cursor.lastSessionKey) : digests;
	return { ...(cursor ? { lastRunAt: cursor.lastRunAt } : {}), newSessions: fresh.length };
}

const TRIAGE_SUBMISSION_PARAMETERS = Type.Object(
	{
		hypotheses: Type.Array(
			Type.Object(
				{
					direction: Type.String({
						pattern: "^[a-z0-9][a-z0-9-]{2,63}$",
						description: "Kebab-case improvement direction slug",
					}),
					summary: Type.String({ minLength: 8, maxLength: 500 }),
					evidenceSessions: Type.Array(Type.String(), { maxItems: 8 }),
					suggestedKind: StringEnum(["data", "component", "workflow", "code"]),
				},
				{ additionalProperties: false },
			),
			{ maxItems: MAX_HYPOTHESES },
		),
	},
	{ additionalProperties: false },
);

/**
 * The streaming-triage stage: every N completed sessions, a minimum-cost model
 * scans the new session digests and files structured improvement hypotheses
 * into the inbox, where the (expensive) research phase later consumes them as
 * pre-triaged evidence. Never advances the evolution evidence cursor.
 */
export async function runSessionTriage(options: RunSessionTriageOptions): Promise<SessionTriageOutcome> {
	if (!Number.isSafeInteger(options.everyNSessions) || options.everyNSessions < 1) {
		throw new Error("triage everyNSessions must be a positive integer");
	}
	const now = options.now ?? (() => new Date());
	const cursor = await readTriageCursor(options.paths);
	const digests = (await listSessionDigests(options.paths)).filter((digest) => digest.complete);
	const fresh = cursor ? digests.filter((digest) => digestKey(digest) > cursor.lastSessionKey) : digests;
	if (fresh.length < options.everyNSessions) {
		return { ran: false, newSessions: fresh.length, hypotheses: [], inboxFiles: [] };
	}
	const window = fresh.slice(-MAX_DIGEST_LINES);
	const prompt = [
		`Telemetry digests for ${window.length} recent sessions:`,
		"",
		...window.map(digestLine),
		"",
		`Flag at most ${MAX_HYPOTHESES} improvement hypotheses worth a deeper evolution run.`,
		"Submit them with the triage tool. Submit an empty list when the sessions look healthy.",
	].join("\n");
	const run = await options.runner.run({
		cwd: options.cwd ?? process.cwd(),
		...(options.agentDir ? { agentDir: options.agentDir } : {}),
		systemPrompt: TRIAGE_SYSTEM_PROMPT,
		prompt,
		model: options.model,
		...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
		sessionIdentity: "evo-session-triage",
		submission: {
			toolName: "submit_triage",
			description: "Submit the triage hypotheses extracted from the session digests",
			parameters: TRIAGE_SUBMISSION_PARAMETERS,
		},
	});
	await recordModelUsage(options.paths, "triage", run);
	const submitted =
		typeof run.submission === "object" && run.submission !== null
			? ((run.submission as { hypotheses?: TriageHypothesis[] }).hypotheses ?? [])
			: [];
	const hypotheses = submitted.slice(0, MAX_HYPOTHESES);
	const timestamp = now().toISOString();
	const sessionId = window.at(-1)?.sessionId ?? "triage";
	const inboxFiles: string[] = [];
	for (const hypothesis of hypotheses) {
		const id = randomUUID();
		const entry: RecorderInboxEntry = {
			schemaVersion: 1,
			id,
			timestamp,
			sessionId,
			source: "extension",
			kind: "note",
			text: `NOTE: triage hypothesis (${hypothesis.direction}): ${hypothesis.summary} [evidence sessions: ${hypothesis.evidenceSessions.join(", ") || "n/a"}]`,
		};
		const fileName = `${timestamp.replaceAll(":", "-")}-${id}.json`;
		await atomicWriteJson(join(options.paths.inbox, fileName), entry);
		// Without an initialized lifecycle the next research run would refuse to
		// proceed over an "unclassified" inbox file; triage notes are pre-classified.
		await initializeInboxLifecycle(options.paths, fileName);
		inboxFiles.push(fileName);
	}
	const lastKey = digestKey(fresh[fresh.length - 1] as SessionDigest);
	await atomicWriteJson(join(options.paths.root, TRIAGE_CURSOR_FILE), {
		schemaVersion: 1,
		lastSessionKey: lastKey,
		lastRunAt: timestamp,
	} satisfies TriageCursor);
	return { ran: true, newSessions: fresh.length, hypotheses, inboxFiles };
}
