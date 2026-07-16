import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSessionTriage } from "../src/evolve/triage.ts";
import { readInboxEntry } from "../src/inbox.ts";
import { getEvoPaths } from "../src/paths.ts";
import { buildSessionDigest } from "../src/recorder/digest.ts";
import { createRecorderStore } from "../src/recorder/store.ts";
import type { ModelRunner, ModelRunRequest, ModelRunResult } from "../src/reflect/model-runner.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryPaths(): Promise<ReturnType<typeof getEvoPaths>> {
	const root = await mkdtemp(join(tmpdir(), "pi-evo-triage-"));
	roots.push(root);
	return getEvoPaths(join(root, "evo"));
}

async function recordSession(options: {
	paths: ReturnType<typeof getEvoPaths>;
	sessionId: string;
	timestamp: string;
	toolError?: boolean;
}): Promise<void> {
	const store = await createRecorderStore({
		paths: options.paths,
		sessionId: options.sessionId,
		bundleDigest: "0".repeat(64),
		now: () => new Date(options.timestamp),
	});
	await store.append({ type: "session_start", reason: "startup", cwd: "/workspace" });
	await store.append({
		type: "before_agent_start",
		prompt: await store.storePayload("Do the task"),
		systemPrompt: await store.storePayload("system"),
		systemPromptOptions: await store.storePayload({}),
	});
	await store.append({
		type: "message",
		role: "assistant",
		message: await store.storePayload({ role: "assistant", content: "done" }),
	});
	if (options.toolError !== undefined) {
		await store.append({
			type: "tool",
			toolCallId: "tool-1",
			toolName: "bash",
			startedAt: options.timestamp,
			endedAt: options.timestamp,
			durationMs: 5,
			input: await store.storePayload({ command: "npm test" }),
			result: await store.storePayload("result"),
			isError: options.toolError,
			verification: { kind: "test", command: "npm test", exitCode: options.toolError ? 1 : 0 },
		});
	}
	await store.append({ type: "session_end", reason: "quit" });
	await buildSessionDigest(options.paths, options.sessionId);
}

function fakeRunner(hypotheses: unknown, requests: ModelRunRequest[]): ModelRunner {
	return {
		async run(request): Promise<ModelRunResult> {
			requests.push(request);
			return {
				text: "triaged",
				submission: { hypotheses },
				stats: {
					sessionId: "evo-session-triage",
					toolCalls: 0,
					toolResults: 0,
					totalMessages: 2,
					tokens: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, total: 20 },
					cost: 0,
				},
				model: { provider: "faux", id: "luna" },
			} as unknown as ModelRunResult;
		},
	};
}

describe("session triage", () => {
	it("waits for the session threshold, files hypotheses, and advances its own cursor", async () => {
		const paths = await temporaryPaths();
		for (let index = 0; index < 2; index += 1) {
			await recordSession({
				paths,
				sessionId: `session-${index}`,
				timestamp: `2026-07-0${index + 1}T10:00:00.000Z`,
				toolError: true,
			});
		}
		const requests: ModelRunRequest[] = [];
		const runner = fakeRunner(
			[
				{
					direction: "reduce-tool-errors",
					summary: "bash verification keeps failing across recent sessions",
					evidenceSessions: ["session-0", "session-1"],
					suggestedKind: "data",
				},
			],
			requests,
		);

		const below = await runSessionTriage({ paths, runner, model: "faux/luna", everyNSessions: 3 });
		expect(below).toMatchObject({ ran: false, newSessions: 2, hypotheses: [] });
		expect(requests).toHaveLength(0);

		await recordSession({ paths, sessionId: "session-2", timestamp: "2026-07-03T10:00:00.000Z", toolError: true });
		const triaged = await runSessionTriage({ paths, runner, model: "faux/luna", everyNSessions: 3 });
		expect(triaged.ran).toBe(true);
		expect(triaged.newSessions).toBe(3);
		expect(triaged.hypotheses).toHaveLength(1);
		expect(triaged.inboxFiles).toHaveLength(1);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.prompt).toContain("session-2");
		expect(requests[0]?.model).toBe("faux/luna");

		const entry = await readInboxEntry(paths, triaged.inboxFiles[0] as string);
		expect(entry.kind).toBe("note");
		expect(entry.text).toContain("triage hypothesis (reduce-tool-errors)");
		expect(entry.text).toContain("session-0");

		// The cursor advanced: an immediate re-run sees no new sessions.
		const repeat = await runSessionTriage({ paths, runner, model: "faux/luna", everyNSessions: 3 });
		expect(repeat).toMatchObject({ ran: false, newSessions: 0 });
		expect(requests).toHaveLength(1);
	});

	it("files nothing when the model submits an empty hypothesis list", async () => {
		const paths = await temporaryPaths();
		await recordSession({ paths, sessionId: "healthy-1", timestamp: "2026-07-01T10:00:00.000Z" });
		const requests: ModelRunRequest[] = [];
		const runner = fakeRunner([], requests);

		const outcome = await runSessionTriage({ paths, runner, model: "faux/luna", everyNSessions: 1 });
		expect(outcome.ran).toBe(true);
		expect(outcome.hypotheses).toEqual([]);
		expect(outcome.inboxFiles).toEqual([]);
	});
});
