import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@ch1nyzzz/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { getEvoPaths } from "../src/paths.ts";
import { readSessionDigest } from "../src/recorder/digest.ts";
import { createRecorderExtension, isDurablePreferenceInstruction } from "../src/recorder/extension.ts";
import type { RecordedEvent } from "../src/recorder/schema.ts";
import { createRecorderStore, readSessionLog, resolveStoredPayload } from "../src/recorder/store.ts";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

describe("recorder", () => {
	const temporaryDirectories: string[] = [];

	afterEach(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
		);
	});

	async function createRoot(): Promise<string> {
		const root = await mkdtemp(join(tmpdir(), "pi-evo-recorder-"));
		temporaryDirectories.push(root);
		return root;
	}

	it("recognizes durable preferences without requiring a command", () => {
		expect(isDurablePreferenceInstruction("以后都这样处理")).toBe(true);
		expect(isDurablePreferenceInstruction("按照第一性原理完整修改，不要过度防御")).toBe(true);
		expect(isDurablePreferenceInstruction("Always prefer the complete design over a local patch.")).toBe(true);
		expect(isDurablePreferenceInstruction("Fix this one typo")).toBe(false);
	});

	it("stores large payloads in CAS and restores session logs", async () => {
		const paths = getEvoPaths(await createRoot());
		const store = await createRecorderStore({
			paths,
			sessionId: "session-1",
			artifactThresholdBytes: 8,
			now: () => new Date("2026-07-13T00:00:00.000Z"),
		});
		const value = { content: "a long payload" };
		const payload = await store.storePayload(value);
		expect(payload.artifact).toBeDefined();
		expect(await resolveStoredPayload(paths, payload)).toEqual(value);
		await store.append({ type: "message", role: "user", message: payload });

		const events = await readSessionLog(paths, "session-1");
		expect(events).toMatchObject([
			{
				schemaVersion: 1,
				type: "message",
				sessionId: "session-1",
				sequence: 1,
				timestamp: "2026-07-13T00:00:00.000Z",
			},
		]);
	});

	it("recovers a half-written trailing event and continues the sequence", async () => {
		const paths = getEvoPaths(await createRoot());
		const store = await createRecorderStore({ paths, sessionId: "session-recovery" });
		await store.append({ type: "message", role: "user", message: await store.storePayload("first") });
		await appendFile(store.logPath, '{"schemaVersion":1,"sessionId":"session-recovery","sequence":2');

		const recoveredStore = await createRecorderStore({ paths, sessionId: "session-recovery" });
		const event = await recoveredStore.append({
			type: "message",
			role: "assistant",
			message: await recoveredStore.storePayload("second"),
		});

		expect(event.sequence).toBe(2);
		expect((await readSessionLog(paths, "session-recovery")).map((item) => item.sequence)).toEqual([1, 2]);
		const recoveredLog = await readFile(store.logPath, "utf8");
		expect(recoveredLog.endsWith("\n")).toBe(true);
		expect(recoveredLog.trimEnd().split("\n")).toHaveLength(2);
	});
	it("repairs a torn tail before appending through an already-open store", async () => {
		const paths = getEvoPaths(await createRoot());
		const store = await createRecorderStore({ paths, sessionId: "session-active-recovery" });
		await store.append({ type: "message", role: "user", message: await store.storePayload("first") });
		await appendFile(store.logPath, '{"schemaVersion":1,"sessionId":"session-active-recovery","sequence":2');

		const event = await store.append({
			type: "message",
			role: "assistant",
			message: await store.storePayload("second"),
		});

		expect(event.sequence).toBe(2);
		expect((await readSessionLog(paths, "session-active-recovery")).map((item) => item.sequence)).toEqual([1, 2]);
	});

	it("repairs a torn tail before a corpus read", async () => {
		const paths = getEvoPaths(await createRoot());
		const store = await createRecorderStore({ paths, sessionId: "session-read-recovery" });
		await store.append({ type: "message", role: "user", message: await store.storePayload("first") });
		await appendFile(store.logPath, '{"schemaVersion":1,"sessionId":"session-read-recovery","sequence":2');

		expect((await readSessionLog(paths, "session-read-recovery")).map((item) => item.sequence)).toEqual([1]);
		expect((await readFile(store.logPath, "utf8")).endsWith("\n")).toBe(true);
	});

	it("serializes concurrent appends from independent stores", async () => {
		const paths = getEvoPaths(await createRoot());
		const first = await createRecorderStore({ paths, sessionId: "session-concurrent" });
		const second = await createRecorderStore({ paths, sessionId: "session-concurrent" });
		const events = await Promise.all(
			Array.from({ length: 12 }, async (_, index) => {
				const store = index % 2 === 0 ? first : second;
				return store.append({
					type: "message",
					role: "user",
					message: await store.storePayload(`message-${index}`),
				});
			}),
		);

		expect(events.map((event) => event.sequence).sort((left, right) => left - right)).toEqual(
			Array.from({ length: 12 }, (_, index) => index + 1),
		);
		expect((await readSessionLog(paths, "session-concurrent")).map((event) => event.sequence)).toEqual(
			Array.from({ length: 12 }, (_, index) => index + 1),
		);
	});

	it("preserves a complete trailing event by restoring its newline", async () => {
		const paths = getEvoPaths(await createRoot());
		const store = await createRecorderStore({ paths, sessionId: "session-complete-tail" });
		await store.append({ type: "message", role: "user", message: await store.storePayload("first") });
		const completeLog = await readFile(store.logPath, "utf8");
		await writeFile(store.logPath, completeLog.slice(0, -1));

		const recoveredStore = await createRecorderStore({ paths, sessionId: "session-complete-tail" });
		expect(await readFile(store.logPath, "utf8")).toBe(completeLog);
		expect(
			(
				await recoveredStore.append({
					type: "message",
					role: "assistant",
					message: await recoveredStore.storePayload("second"),
				})
			).sequence,
		).toBe(2);
	});

	it("rejects an intermediate malformed terminated line during startup", async () => {
		const paths = getEvoPaths(await createRoot());
		const store = await createRecorderStore({ paths, sessionId: "session-malformed" });
		await store.append({ type: "message", role: "user", message: await store.storePayload("first") });
		await store.append({ type: "message", role: "assistant", message: await store.storePayload("second") });
		const content = await readFile(store.logPath, "utf8");
		const firstNewline = content.indexOf("\n");
		await writeFile(
			store.logPath,
			`${content.slice(0, firstNewline + 1)}not-json\n${content.slice(firstNewline + 1)}`,
		);

		await expect(createRecorderStore({ paths, sessionId: "session-malformed" })).rejects.toThrow(
			`Malformed recorder log line at ${store.logPath}:2`,
		);
	});

	it("rejects non-contiguous recorder sequences", async () => {
		const paths = getEvoPaths(await createRoot());
		const store = await createRecorderStore({ paths, sessionId: "session-corrupt-sequence" });
		await store.append({ type: "message", role: "user", message: await store.storePayload("first") });
		await store.append({ type: "message", role: "assistant", message: await store.storePayload("second") });
		const content = await readFile(store.logPath, "utf8");
		const corrupted = content.replace('"sequence":2', '"sequence":3');
		expect(corrupted).not.toBe(content);
		await writeFile(store.logPath, corrupted);

		await expect(readSessionLog(paths, "session-corrupt-sequence")).rejects.toThrow(
			`Invalid recorder sequence at ${store.logPath}:2`,
		);
		await expect(createRecorderStore({ paths, sessionId: "session-corrupt-sequence" })).rejects.toThrow(
			`Invalid recorder sequence at ${store.logPath}:2`,
		);
	});

	it("does not consume a sequence when an append fails", async () => {
		const paths = getEvoPaths(await createRoot());
		const store = await createRecorderStore({ paths, sessionId: "session-append-retry" });
		const message = await store.storePayload("retry me");
		await rm(paths.log, { recursive: true, force: true });

		await writeFile(paths.log, "blocked");
		await expect(store.append({ type: "message", role: "user", message })).rejects.toThrow();
		await rm(paths.log);
		await mkdir(paths.log, { recursive: true });
		const event = await store.append({ type: "message", role: "user", message });

		expect(event.sequence).toBe(1);
		expect((await readSessionLog(paths, "session-append-retry")).map((item) => item.sequence)).toEqual([1]);
	});

	it("backfills user messages missed before a resumed recorder was loaded without duplicating them", async () => {
		const root = await createRoot();
		const paths = getEvoPaths(root);
		const handlers = new Map<string, EventHandler>();
		const entries: unknown[] = [
			{
				type: "message",
				id: "historical-user-entry",
				parentId: null,
				timestamp: "2026-07-13T00:00:00.000Z",
				message: {
					role: "user",
					content: [{ type: "text", text: "按照第一性原理完整修改，不要过度防御" }],
					timestamp: Date.parse("2026-07-13T00:00:00.000Z"),
				},
			},
		];
		const api = {
			on: (name: string, handler: EventHandler) => handlers.set(name, handler),
			appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		} as unknown as ExtensionAPI;
		const context = {
			cwd: root,
			sessionManager: {
				getSessionId: () => "resumed-session",
				getSessionFile: () => join(root, "session.jsonl"),
				getEntries: () => entries,
			},
		} as unknown as ExtensionContext;
		await createRecorderExtension({ paths })(api);
		await handlers.get("session_start")?.({ type: "session_start", reason: "resume" }, context);
		await handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, context);

		const messages = (await readSessionLog(paths, "resumed-session")).filter((event) => event.type === "message");
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({ role: "user", sourceEntryId: "historical-user-entry" });
	});

	it("honors the explicit project privacy marker", async () => {
		const root = await createRoot();
		await mkdir(join(root, ".pi"), { recursive: true });
		await writeFile(join(root, ".pi", "evo-private"), "private\n");
		const paths = getEvoPaths(join(root, "evo-data"));
		const handlers = new Map<string, EventHandler>();
		const entries: unknown[] = [];
		const api = {
			on: (name: string, handler: EventHandler) => handlers.set(name, handler),
			appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
		} as unknown as ExtensionAPI;
		const context = {
			cwd: root,
			sessionManager: {
				getSessionId: () => "private-session",
				getSessionFile: () => join(root, "session.jsonl"),
				getEntries: () => entries,
			},
		} as unknown as ExtensionContext;
		await createRecorderExtension({ paths })(api);
		for (const [name, event] of [
			["session_start", { type: "session_start", reason: "startup" }],
			["before_agent_start", { type: "before_agent_start", prompt: "private", systemPrompt: "system" }],
			["input", { type: "input", text: "以后都这样", source: "interactive" }],
			["session_shutdown", { type: "session_shutdown", reason: "quit" }],
		] as const) {
			await handlers.get(name)?.(event, context);
		}

		expect(entries).toEqual([]);
		await expect(readFile(join(paths.log, "private-session.jsonl"), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("records lifecycle, prompts, messages, verification, feedback, usage, and diff", async () => {
		const root = await createRoot();
		const paths = getEvoPaths(root);
		const handlers = new Map<string, EventHandler>();
		const entries: unknown[] = [];
		const api = {
			on: (name: string, handler: EventHandler) => handlers.set(name, handler),
			appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
			exec: async () => ({ stdout: "diff --git a/file b/file\n", stderr: "", code: 0, killed: false }),
		} as unknown as ExtensionAPI;
		const context = {
			cwd: root,
			sessionManager: {
				getSessionId: () => "session-2",
				getSessionFile: () => join(root, "session.jsonl"),
				getEntries: () => entries,
			},
		} as unknown as ExtensionContext;
		let tick = 0;
		await createRecorderExtension({
			paths,
			bundleDigest: "bundle-1",
			artifactThresholdBytes: 32,
			now: () => new Date(Date.UTC(2026, 6, 13, 0, 0, tick++)),
		})(api);

		async function emit(name: string, event: unknown): Promise<void> {
			const handler = handlers.get(name);
			expect(handler, `missing ${name} handler`).toBeDefined();
			await handler?.(event, context);
		}

		await emit("session_start", { type: "session_start", reason: "startup" });
		await emit("before_agent_start", {
			type: "before_agent_start",
			prompt: "fix the issue",
			systemPrompt: "system prompt that is deliberately long enough for CAS",
			systemPromptOptions: { tools: ["bash"] },
		});
		await emit("message_end", {
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "working" }],
				provider: "faux",
				model: "faux-model",
				usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, totalTokens: 20 },
			},
		});
		await emit("tool_execution_start", {
			type: "tool_execution_start",
			toolCallId: "tool-1",
			toolName: "bash",
			args: { command: "npm test" },
		});
		await emit("tool_call", {
			type: "tool_call",
			toolCallId: "tool-1",
			toolName: "bash",
			input: { command: "npm test" },
		});
		const failedResult = { content: [{ type: "text", text: "failed\n\nCommand exited with code 2" }] };
		await emit("tool_result", {
			type: "tool_result",
			toolCallId: "tool-1",
			toolName: "bash",
			input: { command: "npm test" },
			...failedResult,
			isError: true,
		});
		await emit("tool_execution_end", {
			type: "tool_execution_end",
			toolCallId: "tool-1",
			toolName: "bash",
			result: failedResult,
			isError: true,
		});
		await emit("input", {
			type: "input",
			text: "以后都这样处理",
			source: "interactive",
		});
		await emit("session_before_compact", {
			type: "session_before_compact",
			reason: "threshold",
			willRetry: false,
		});
		await emit("session_compact", {
			type: "session_compact",
			reason: "threshold",
			willRetry: false,
			fromExtension: true,
			compactionEntry: {
				summary: "summary",
				firstKeptEntryId: "kept-1",
				tokensBefore: 120_000,
				details: { abi: "compaction/v1" },
			},
		});
		await emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

		const events = await readSessionLog(paths, "session-2");
		expect(events.map((event) => event.type)).toEqual([
			"session_start",
			"before_agent_start",
			"message",
			"usage",
			"tool",
			"explicit_feedback",
			"compaction",
			"git_diff",
			"session_end",
		]);
		expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
		const tool = events.find((event): event is Extract<RecordedEvent, { type: "tool" }> => event.type === "tool");
		expect(tool?.verification).toEqual({ kind: "test", command: "npm test", exitCode: 2 });
		const beforeStart = events.find(
			(event): event is Extract<RecordedEvent, { type: "before_agent_start" }> =>
				event.type === "before_agent_start",
		);
		expect(await resolveStoredPayload(paths, beforeStart?.systemPrompt ?? { preview: "" })).toBe(
			"system prompt that is deliberately long enough for CAS",
		);
		const inboxFiles = await readdir(paths.inbox);
		expect(inboxFiles).toHaveLength(1);
		expect(JSON.parse(await readFile(join(paths.inbox, inboxFiles[0] ?? "missing"), "utf8"))).toMatchObject({
			kind: "candidate",
			text: "以后都这样处理",
		});
		expect(await readSessionDigest(paths, "session-2")).toMatchObject({
			bundleDigest: "bundle-1",
			complete: true,
			metrics: {
				tasks: 1,
				assistantMessages: 1,
				toolCalls: 1,
				toolErrors: 1,
				verificationRuns: 1,
				verificationFailed: 1,
				preferenceSignals: 1,
				compactions: 1,
				compactionTokensBefore: 120_000,
			},
		});
		expect(entries).toHaveLength(1);
	});
});
