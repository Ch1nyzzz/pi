import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { getEvoPaths } from "../src/paths.ts";
import { createRecorderExtension } from "../src/recorder/extension.ts";
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
			"Invalid recorder event at session-corrupt-sequence.jsonl:2",
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

		await expect(store.append({ type: "message", role: "user", message })).rejects.toThrow();
		await mkdir(paths.log, { recursive: true });
		const event = await store.append({ type: "message", role: "user", message });

		expect(event.sequence).toBe(1);
		expect((await readSessionLog(paths, "session-append-retry")).map((item) => item.sequence)).toEqual([1]);
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
		await emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

		const events = await readSessionLog(paths, "session-2");
		expect(events.map((event) => event.type)).toEqual([
			"session_start",
			"before_agent_start",
			"message",
			"usage",
			"tool",
			"explicit_feedback",
			"git_diff",
			"session_end",
		]);
		expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
		const tool = events.find((event): event is Extract<RecordedEvent, { type: "tool" }> => event.type === "tool");
		expect(tool?.verification).toEqual({ kind: "test", command: "npm test", exitCode: 2 });
		const beforeStart = events.find(
			(event): event is Extract<RecordedEvent, { type: "before_agent_start" }> =>
				event.type === "before_agent_start",
		);
		expect(await resolveStoredPayload(paths, beforeStart?.systemPrompt ?? { preview: "" })).toBe(
			"system prompt that is deliberately long enough for CAS",
		);
		expect(await readdir(paths.inbox)).toHaveLength(1);
		expect(entries).toHaveLength(1);
	});
});
