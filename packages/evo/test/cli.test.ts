import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionFactory,
	RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { compileBundle } from "../src/bundle/compile.ts";
import { createEvoCommandExtension, runEvoCli } from "../src/cli.ts";
import { createEvoExtension } from "../src/extension.ts";
import { getEvoPaths } from "../src/paths.ts";
import { saveProposal, stageProposal } from "../src/proposal.ts";
import type { RecordedEvent } from "../src/recorder/schema.ts";
import { readSessionLog, resolveStoredPayload } from "../src/recorder/store.ts";
import type { ModelRunner } from "../src/reflect/model-runner.ts";
import { EvoService } from "../src/service.ts";

type EventHandler = (event: unknown, ctx: ExtensionCommandContext) => unknown;

interface SentMessage {
	message: Record<string, unknown>;
	options: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function createHarness(cwd: string) {
	const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
	const handlers = new Map<string, EventHandler[]>();
	const entries: unknown[] = [];
	const notifications: Array<{ message: string; type: string | undefined }> = [];
	const statuses: Array<{ key: string; text: string | undefined }> = [];
	const sentMessages: SentMessage[] = [];
	let inputResponse: string | undefined;
	let inputHandler: (() => Promise<string | undefined>) | undefined;
	let confirmResponse = false;
	let sessionId = "session-cli";
	let activeTools = ["read", "bash", "edit"];

	const api = {
		on: (event: string, handler: EventHandler) => {
			const registered = handlers.get(event) ?? [];
			registered.push(handler);
			handlers.set(event, registered);
		},
		registerCommand: (name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			commands.set(name, command);
		},
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		sendMessage: (message: Record<string, unknown>, options: unknown) => sentMessages.push({ message, options }),
		getActiveTools: () => [...activeTools],
		setActiveTools: (toolNames: string[]) => {
			activeTools = [...toolNames];
		},
		exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
	} as unknown as ExtensionAPI;
	const context = {
		cwd,
		hasUI: true,
		waitForIdle: async () => {},
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => join(cwd, "session.jsonl"),
			getEntries: () => entries,
		},
		ui: {
			notify: (message: string, type?: string) => notifications.push({ message, type }),
			setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }),
			input: async () => (inputHandler ? inputHandler() : inputResponse),
			confirm: async () => confirmResponse,
		},
	} as unknown as ExtensionCommandContext;

	return {
		api,
		commands,
		handlers,
		context,
		entries,
		notifications,
		statuses,
		sentMessages,
		getActiveTools: () => [...activeTools],
		setInputResponse: (value: string | undefined) => {
			inputHandler = undefined;
			inputResponse = value;
		},
		setInputHandler: (handler: (() => Promise<string | undefined>) | undefined) => {
			inputHandler = handler;
		},
		setConfirmResponse: (value: boolean) => {
			confirmResponse = value;
		},
		setSessionId: (value: string) => {
			sessionId = value;
		},
		async emit(event: string, value: unknown): Promise<unknown[]> {
			const results: unknown[] = [];
			for (const handler of handlers.get(event) ?? []) results.push(await handler(value, context));
			return results;
		},
	};
}

describe("Evo CLI extension", () => {
	const temporaryDirectories: string[] = [];

	afterEach(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
		);
	});

	async function createFixture(): Promise<{
		root: string;
		service: EvoService;
		runner: ModelRunner;
		getModelCalls(): number;
	}> {
		const root = await mkdtemp(join(tmpdir(), "pi-evo-cli-"));
		temporaryDirectories.push(root);
		const service = new EvoService(getEvoPaths(root));
		let modelCalls = 0;
		const runner: ModelRunner = {
			async run() {
				modelCalls += 1;
				throw new Error("Fake model runner must not be called by these commands");
			},
		};
		return { root, service, runner, getModelCalls: () => modelCalls };
	}

	it("handles status and note, and rejects a wrong T2 approval digest", async () => {
		const fixture = await createFixture();
		const seed = await fixture.service.init();
		const harness = createHarness(fixture.root);
		await createEvoCommandExtension({ service: fixture.service, runner: fixture.runner })(harness.api);
		const command = harness.commands.get("evo");
		expect(command).toBeDefined();

		await command?.handler("status", harness.context);
		expect(harness.notifications.at(-1)?.message).toContain(seed.digest);

		await command?.handler("note keep responses concise", harness.context);
		const inboxFiles = await readdir(fixture.service.paths.inbox);
		expect(inboxFiles).toHaveLength(1);
		const inbox = JSON.parse(
			await readFile(join(fixture.service.paths.inbox, inboxFiles[0] ?? "missing"), "utf8"),
		) as { text: string };
		expect(inbox.text).toBe("NOTE: keep responses concise");

		const proposal = await stageProposal({
			paths: fixture.service.paths,
			parentDigest: seed.digest,
			observationsMarkdown: "A requested code feature.",
			draft: {
				motivation: "Add a requested code feature",
				expectedEffect: "The feature becomes available",
				risk: "Code changes require human review",
				verifyPlan: "Run focused tests",
				trialPlan: "Merge manually only after review",
				source: "explicit-request",
				evidence: [],
				inboxReferences: [],
				replayScenarios: [],
				codePatch: "diff --git a/example.ts b/example.ts",
			},
		});
		harness.notifications.length = 0;
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		expect(harness.statuses.at(-1)).toEqual({ key: "evo", text: "evo: 1 pending" });
		expect(harness.notifications).toEqual([]);

		harness.setInputResponse("wrong-digest");
		await command?.handler(`permit ${proposal.id}`, harness.context);
		expect((await fixture.service.getProposal(proposal.id)).status).toBe("pending");
		expect(
			harness.notifications.some((entry) => entry.message.includes("did not match") && entry.type === "error"),
		).toBe(true);
		const card = harness.sentMessages.find((entry) => entry.message.customType === "evo.proposal");
		expect(card?.options).toEqual({ triggerTurn: false });

		harness.notifications.length = 0;
		harness.setInputHandler(async () => {
			const changed = await fixture.service.getProposal(proposal.id);
			changed.approvalDigest = "f".repeat(64);
			await saveProposal(fixture.service.paths, changed);
			return proposal.approvalDigest;
		});
		await command?.handler(`permit ${proposal.id}`, harness.context);
		expect((await fixture.service.getProposal(proposal.id)).status).toBe("pending");
		expect(harness.notifications.some((entry) => entry.message.includes("does not match the confirmed digest"))).toBe(
			true,
		);
		expect(fixture.getModelCalls()).toBe(0);
	});

	it("registers policy before recorder so recorder stores the final chained prompt", async () => {
		const fixture = await createFixture();
		const seed = await fixture.service.init();
		const harness = createHarness(fixture.root);
		const extension: ExtensionFactory = createEvoExtension({ service: fixture.service, runner: fixture.runner });
		await extension(harness.api);
		await harness.emit("session_start", { type: "session_start", reason: "startup" });

		let systemPrompt = "base prompt";
		for (const handler of harness.handlers.get("before_agent_start") ?? []) {
			const result = await handler(
				{
					type: "before_agent_start",
					prompt: "hello",
					systemPrompt,
					systemPromptOptions: { cwd: fixture.root },
				},
				harness.context,
			);
			if (isRecord(result) && typeof result.systemPrompt === "string") systemPrompt = result.systemPrompt;
		}
		expect(systemPrompt).toContain(`Bundle: ${seed.digest}`);

		const events = await readSessionLog(fixture.service.paths, "session-cli");
		const recorded = events.find(
			(event): event is Extract<RecordedEvent, { type: "before_agent_start" }> =>
				event.type === "before_agent_start",
		);
		expect(recorded).toBeDefined();
		expect(await resolveStoredPayload(fixture.service.paths, recorded?.systemPrompt ?? { preview: "" })).toBe(
			systemPrompt,
		);
		expect(harness.statuses.some((status) => status.text?.includes(seed.digest.slice(0, 8)))).toBe(false);
	});

	it("restores active tools after a restricted bundle session shuts down", async () => {
		const fixture = await createFixture();
		const source = await mkdtemp(join(fixture.root, "restricted-tools-"));
		await writeFile(
			join(source, "policy.json"),
			`${JSON.stringify({ schemaVersion: 1, enabledTools: ["read"] }, undefined, "\t")}\n`,
		);
		const bundle = await compileBundle({
			paths: fixture.service.paths,
			sourceDirectory: source,
			parentDigest: null,
			summary: "Restrict active tools for one session",
		});
		await fixture.service.registry.initialize(bundle.digest);
		const harness = createHarness(fixture.root);
		await createEvoExtension({ service: fixture.service, runner: fixture.runner })(harness.api);

		expect(harness.getActiveTools()).toEqual(["read", "bash", "edit"]);
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		expect(harness.getActiveTools()).toEqual(["read"]);
		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		expect(harness.getActiveTools()).toEqual(["read", "bash", "edit"]);
	});

	it("ignores an invalid pinned digest and records the stable fallback", async () => {
		const fixture = await createFixture();
		const stable = await fixture.service.init();
		const harness = createHarness(fixture.root);
		harness.entries.push({
			type: "custom",
			customType: "evo.bundle",
			data: { digest: "invalid-digest", sessionId: "session-cli" },
		});
		await createEvoExtension({ service: fixture.service, runner: fixture.runner })(harness.api);

		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		expect(harness.entries).toContainEqual({
			type: "custom",
			customType: "evo.bundle",
			data: { digest: stable.digest, sessionId: "session-cli" },
		});
		let systemPrompt = "base prompt";
		for (const handler of harness.handlers.get("before_agent_start") ?? []) {
			const result = await handler(
				{
					type: "before_agent_start",
					prompt: "use the stable fallback",
					systemPrompt,
					systemPromptOptions: { cwd: fixture.root },
				},
				harness.context,
			);
			if (isRecord(result) && typeof result.systemPrompt === "string") systemPrompt = result.systemPrompt;
		}
		expect(systemPrompt).toContain(`Bundle: ${stable.digest}`);
		expect(harness.notifications.some((entry) => entry.type === "error")).toBe(false);
		const events = await readSessionLog(fixture.service.paths, "session-cli");
		expect(events.map((event) => event.bundleDigest)).toEqual([stable.digest, stable.digest]);
	});

	it("pins resumed sessions to their recorded bundle and gives forks the current stable bundle", async () => {
		const fixture = await createFixture();
		const firstBundle = await fixture.service.init();
		const harness = createHarness(fixture.root);
		const extension: ExtensionFactory = createEvoExtension({ service: fixture.service, runner: fixture.runner });
		await extension(harness.api);

		async function runBeforeAgentStart(prompt: string): Promise<string> {
			let systemPrompt = "base prompt";
			for (const handler of harness.handlers.get("before_agent_start") ?? []) {
				const result = await handler(
					{
						type: "before_agent_start",
						prompt,
						systemPrompt,
						systemPromptOptions: { cwd: fixture.root },
					},
					harness.context,
				);
				if (isRecord(result) && typeof result.systemPrompt === "string") systemPrompt = result.systemPrompt;
			}
			return systemPrompt;
		}

		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		expect(harness.entries).toContainEqual({
			type: "custom",
			customType: "evo.bundle",
			data: { digest: firstBundle.digest, sessionId: "session-cli" },
		});

		const secondSource = await mkdtemp(join(fixture.root, "bundle-b-"));
		await writeFile(join(secondSource, "policy.json"), await readFile(join(firstBundle.directory, "policy.json")));
		const secondBundle = await compileBundle({
			paths: fixture.service.paths,
			sourceDirectory: secondSource,
			parentDigest: firstBundle.digest,
			summary: "Second bundle for session pinning regression",
		});
		await fixture.service.registry.activateTrial({
			digest: secondBundle.digest,
			proposalId: "session-pinning-regression",
			plan: "Exercise session pinning",
		});

		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "resume" });
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		const resumedPrompt = await runBeforeAgentStart("resumed prompt");
		expect(resumedPrompt).toContain(`Bundle: ${firstBundle.digest}`);
		expect(resumedPrompt).not.toContain(`Bundle: ${secondBundle.digest}`);
		const resumedEvents = await readSessionLog(fixture.service.paths, "session-cli");
		const resumedStart = resumedEvents.filter((event) => event.type === "session_start").at(-1);
		const resumedBeforeStart = resumedEvents.filter((event) => event.type === "before_agent_start").at(-1);
		expect(resumedStart?.bundleDigest).toBe(firstBundle.digest);
		expect(resumedBeforeStart?.bundleDigest).toBe(firstBundle.digest);
		expect(
			await resolveStoredPayload(
				fixture.service.paths,
				resumedBeforeStart?.type === "before_agent_start" ? resumedBeforeStart.systemPrompt : { preview: "" },
			),
		).toBe(resumedPrompt);
		expect(
			harness.entries.filter(
				(entry) => isRecord(entry) && entry.type === "custom" && entry.customType === "evo.bundle",
			),
		).toHaveLength(1);

		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "fork" });
		harness.setSessionId("session-fork");
		await harness.emit("session_start", { type: "session_start", reason: "fork" });
		const forkPrompt = await runBeforeAgentStart("fork prompt");
		expect(forkPrompt).toContain(`Bundle: ${secondBundle.digest}`);
		expect(forkPrompt).not.toContain(`Bundle: ${firstBundle.digest}`);
		expect(harness.entries).toContainEqual({
			type: "custom",
			customType: "evo.bundle",
			data: { digest: secondBundle.digest, sessionId: "session-fork" },
		});
		const forkEvents = await readSessionLog(fixture.service.paths, "session-fork");
		expect(forkEvents.find((event) => event.type === "session_start")?.bundleDigest).toBe(secondBundle.digest);
		expect(forkEvents.find((event) => event.type === "before_agent_start")?.bundleDigest).toBe(secondBundle.digest);
	});

	it("refuses local permit without an interactive terminal", async () => {
		const fixture = await createFixture();
		const seed = await fixture.service.init();
		const proposal = await stageProposal({
			paths: fixture.service.paths,
			parentDigest: seed.digest,
			observationsMarkdown: "A requested code feature.",
			draft: {
				motivation: "Add another requested code feature",
				expectedEffect: "The feature becomes available",
				risk: "Code changes require human review",
				verifyPlan: "Run focused tests",
				trialPlan: "Merge manually only after review",
				source: "explicit-request",
				evidence: [],
				inboxReferences: [],
				replayScenarios: [],
				codePatch: "diff --git a/other.ts b/other.ts",
			},
		});
		await expect(
			runEvoCli(["permit", proposal.id], {
				service: fixture.service,
				runner: fixture.runner,
				io: {
					interactive: false,
					write: () => {},
					writeError: () => {},
					question: async () => "",
				},
			}),
		).rejects.toThrow("interactive terminal");
		expect((await fixture.service.getProposal(proposal.id)).status).toBe("pending");
		expect(fixture.getModelCalls()).toBe(0);
	});
});
