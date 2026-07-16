import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	RegisteredCommand,
} from "@ch1nyzzz/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { compileBundle } from "../src/bundle/compile.ts";
import { createEvoCommandExtension, refreshEvoStatusIndicator, runEvoCli } from "../src/cli.ts";
import { createEvoExtension } from "../src/extension.ts";
import { getEvoPaths } from "../src/paths.ts";
import { saveProposal, stageProposal } from "../src/proposal.ts";
import type { RecordedEvent } from "../src/recorder/schema.ts";
import { createRecorderStore, readSessionLog, resolveStoredPayload } from "../src/recorder/store.ts";
import type { ModelRunner } from "../src/reflect/model-runner.ts";
import { readScheduleConfig, writeScheduleConfig } from "../src/scheduler.ts";
import { EvoService } from "../src/service.ts";

type EventHandler = (event: unknown, ctx: ExtensionCommandContext) => unknown;

interface SentMessage {
	message: Record<string, unknown>;
	options: unknown;
}

interface ShortcutRegistration {
	description?: string;
	handler: (ctx: ExtensionContext) => Promise<void> | void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function createHarness(cwd: string) {
	const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
	const handlers = new Map<string, EventHandler[]>();
	const shortcuts = new Map<string, ShortcutRegistration>();
	const entries: unknown[] = [];
	const notifications: Array<{ message: string; type: string | undefined }> = [];
	const statuses: Array<{ key: string; text: string | undefined }> = [];
	const statusItems: Array<{
		key: string;
		items: ReadonlyArray<{ id: string; text: string; onSelect: () => unknown }> | undefined;
	}> = [];
	const sentMessages: SentMessage[] = [];
	const confirmations: Array<{ title: string; message: string }> = [];
	let inputResponse: string | undefined;
	let inputHandler: (() => Promise<string | undefined>) | undefined;
	let selectResponse: string | undefined = "Approve";
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
		registerShortcut: (shortcut: string, registration: ShortcutRegistration) => {
			shortcuts.set(shortcut, registration);
		},
		registerEntryRenderer: () => {},
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
		mode: "tui",
		isIdle: () => true,
		waitForIdle: async () => {},
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => join(cwd, "session.jsonl"),
			getEntries: () => entries,
		},
		ui: {
			notify: (message: string, type?: string) => notifications.push({ message, type }),
			setStatus: (key: string, text: string | undefined) => void statuses.push({ key, text }),
			setStatusItems: (
				key: string,
				items: ReadonlyArray<{ id: string; text: string; onSelect: () => unknown }> | undefined,
			) => void statusItems.push({ key, items }),
			select: async () => selectResponse,
			input: async () => (inputHandler ? inputHandler() : inputResponse),
			confirm: async (title: string, message: string) => {
				confirmations.push({ title, message });
				return confirmResponse;
			},
		},
	} as unknown as ExtensionCommandContext;

	return {
		api,
		commands,
		handlers,
		shortcuts,
		context,
		entries,
		notifications,
		statuses,
		statusItems,
		sentMessages,
		confirmations,
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
		setSelectResponse: (value: string | undefined) => {
			selectResponse = value;
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
				motivation: "Add a strictly reviewed preference",
				expectedEffect: "The preference becomes available",
				risk: "The preference could be over-applied",
				verifyPlan: "Review the exact diff",
				trialPlan: "Use for five sessions",
				source: "explicit-request",
				evidence: [],
				inboxReferences: [],
				replayScenarios: [],
				suggestedTier: "T2",
				changes: [{ path: "memory/strict.md", content: "Use strict review.\n" }],
			},
		});
		harness.notifications.length = 0;
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		expect(harness.statuses.at(-1)).toEqual({ key: "evo", text: undefined });
		expect(harness.statusItems.at(-1)?.items?.[0]?.text).toContain("Add a strictly reviewed preference");
		expect(harness.statusItems.at(-1)?.items?.[0]?.text).not.toContain(proposal.id);
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
			return proposal.diffDigest;
		});
		await command?.handler(`permit ${proposal.id}`, harness.context);
		expect((await fixture.service.getProposal(proposal.id)).status).toBe("pending");
		expect(harness.notifications.some((entry) => entry.message.includes("confirmed final diff"))).toBe(true);
		expect(fixture.getModelCalls()).toBe(0);
	});

	it("shows and applies a pending T0 proposal through the quick shortcut", async () => {
		const fixture = await createFixture();
		const seed = await fixture.service.init();
		const store = await createRecorderStore({
			paths: fixture.service.paths,
			sessionId: "t0-shortcut",
			bundleDigest: seed.digest,
		});
		const preference = "Keep T0 shortcut responses concise.";
		const feedback = await store.append({
			type: "explicit_feedback",
			source: "interactive",
			text: await store.storePayload(preference),
			inboxFile: "t0-shortcut.json",
		});
		const proposal = await stageProposal({
			paths: fixture.service.paths,
			parentDigest: seed.digest,
			observationsMarkdown: "The user explicitly requested a durable preference.",
			draft: {
				motivation: "Record the concise-response preference",
				expectedEffect: "Responses remain concise",
				risk: "The preference is applied too broadly",
				verifyPlan: "Compare the memory entry with explicit feedback",
				trialPlan: "No trial is required for verbatim direct recording",
				source: "explicit-request",
				evidence: [{ sessionId: feedback.sessionId, sequence: feedback.sequence, quote: preference }],
				inboxReferences: [],
				replayScenarios: [],
				changes: [{ path: "memory/t0-shortcut.md", content: `${preference}\n` }],
			},
		});
		expect(proposal.tier).toBe("T0");
		if (!proposal.candidateDigest) throw new Error("T0 shortcut fixture has no candidate bundle");
		const harness = createHarness(fixture.root);
		await createEvoCommandExtension({ service: fixture.service, runner: fixture.runner })(harness.api);
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		const status = harness.statusItems.at(-1)?.items?.[0]?.text;
		expect(status).toContain("Record the concise-response preference");
		expect(status).not.toContain(proposal.id);
		const shortcut = harness.shortcuts.get("ctrl+alt+e");
		expect(shortcut).toBeDefined();
		await shortcut?.handler(harness.context);
		expect((await fixture.service.status()).stableDigest).toBe(proposal.candidateDigest);
		expect((await fixture.service.getProposal(proposal.id)).status).toBe("kept");
		expect((await fixture.service.status()).trial).toBeUndefined();
		expect(harness.notifications.at(-1)?.message).toContain(`Applied T0 proposal ${proposal.id}`);
		expect(harness.statusItems.at(-1)).toEqual({ key: "evo", items: undefined });
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
		expect(
			harness.statusItems.some((status) =>
				status.items?.some((item) => item.text.includes(seed.digest.slice(0, 8))),
			),
		).toBe(false);
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

	it("requires an interactive UI and live confirmation for extension control mutations", async () => {
		const fixture = await createFixture();
		const seed = await fixture.service.init();
		const proposal = await stageProposal({
			paths: fixture.service.paths,
			parentDigest: seed.digest,
			observationsMarkdown: "A pending candidate must not be reachable through headless rollback.",
			draft: {
				motivation: "Exercise extension control guards",
				expectedEffect: "Headless commands cannot mutate decisions or pointers",
				risk: "A subprocess could invoke a slash command",
				verifyPlan: "Reject headless and declined commands",
				trialPlan: "Do not activate",
				source: "explicit-request",
				evidence: [],
				inboxReferences: [],
				replayScenarios: [],
				changes: [{ path: "memory/headless.md", content: "Require interactive control.\n" }],
			},
		});
		if (!proposal.candidateDigest) throw new Error("Headless control fixture has no candidate bundle");
		const harness = createHarness(fixture.root);
		await createEvoCommandExtension({ service: fixture.service, runner: fixture.runner })(harness.api);
		const command = harness.commands.get("evo");
		expect(command).toBeDefined();
		const mutations = [
			`reject ${proposal.id} headless rejection`,
			`rollback ${proposal.candidateDigest} headless rollback`,
		];
		const headlessContext = { ...harness.context, hasUI: false } as ExtensionCommandContext;

		for (const mutation of mutations) {
			harness.notifications.length = 0;
			await command?.handler(mutation, headlessContext);
			expect(harness.notifications.some((entry) => entry.message.includes("interactive UI"))).toBe(true);
		}
		expect(harness.confirmations).toHaveLength(0);
		expect((await fixture.service.getProposal(proposal.id)).status).toBe("pending");
		expect((await fixture.service.status()).stableDigest).toBe(seed.digest);
		expect((await fixture.service.status()).paused).toBe(false);

		for (const mutation of mutations) await command?.handler(mutation, harness.context);
		expect(harness.confirmations.map((confirmation) => confirmation.title)).toEqual([
			`Reject ${proposal.id}`,
			"Roll back Evo-Pi",
		]);
		expect((await fixture.service.getProposal(proposal.id)).status).toBe("pending");
		expect((await fixture.service.status()).stableDigest).toBe(seed.digest);
		expect((await fixture.service.status()).paused).toBe(false);
		const history = (await readFile(fixture.service.paths.history, "utf8"))
			.trim()
			.split("\n")
			.map((line) => (JSON.parse(line) as { action: string }).action);
		expect(history).toEqual(["initialize"]);
		expect(fixture.getModelCalls()).toBe(0);
	});

	it("refuses every local control mutation without an interactive terminal", async () => {
		const fixture = await createFixture();
		const seed = await fixture.service.init();
		const proposal = await stageProposal({
			paths: fixture.service.paths,
			parentDigest: seed.digest,
			observationsMarkdown: "A requested code feature.",
			draft: {
				motivation: "Add another strictly reviewed preference",
				expectedEffect: "The preference becomes available",
				risk: "The preference could be over-applied",
				verifyPlan: "Review the exact diff",
				trialPlan: "Use for five sessions",
				source: "explicit-request",
				evidence: [],
				inboxReferences: [],
				replayScenarios: [],
				suggestedTier: "T2",
				changes: [{ path: "memory/local-strict.md", content: "Use strict review locally.\n" }],
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
		const nonInteractiveIo = {
			interactive: false,
			write: () => {},
			writeError: () => {},
			question: async () => "",
		};
		for (const commandArgs of [["reject", proposal.id, "not approved"], ["rollback"], ["keep"]]) {
			await expect(
				runEvoCli(commandArgs, {
					service: fixture.service,
					runner: fixture.runner,
					io: nonInteractiveIo,
				}),
			).rejects.toThrow("interactive terminal");
		}
		expect((await fixture.service.getProposal(proposal.id)).status).toBe("pending");
		expect(fixture.getModelCalls()).toBe(0);
	});

	it("requires live confirmation before direct local state changes", async () => {
		const fixture = await createFixture();
		const seed = await fixture.service.init();
		const proposal = await stageProposal({
			paths: fixture.service.paths,
			parentDigest: seed.digest,
			observationsMarkdown: "A preference awaiting review.",
			draft: {
				motivation: "Stage a confirmation fixture",
				expectedEffect: "Exercise local control guards",
				risk: "None while pending",
				verifyPlan: "Decline each confirmation",
				trialPlan: "Do not activate",
				source: "explicit-request",
				evidence: [],
				inboxReferences: [],
				replayScenarios: [],
				changes: [{ path: "memory/confirm.md", content: "Confirm control changes.\n" }],
			},
		});
		const prompts: string[] = [];
		const output: string[] = [];
		const io = {
			interactive: true,
			write: (message: string) => output.push(message),
			writeError: () => {},
			question: async (prompt: string) => {
				prompts.push(prompt);
				return "no";
			},
		};

		await runEvoCli(["reject", proposal.id, "declined"], {
			service: fixture.service,
			runner: fixture.runner,
			io,
		});
		await runEvoCli(["rollback"], { service: fixture.service, runner: fixture.runner, io });
		expect((await fixture.service.getProposal(proposal.id)).status).toBe("pending");
		expect((await fixture.service.status()).paused).toBe(false);
		expect(prompts).toEqual([
			`Reject proposal ${proposal.id}? [y/N] `,
			"Roll back the active trial or stable bundle? [y/N] ",
		]);
		expect(output).toEqual(["Rejection cancelled", "Rollback cancelled"]);
		expect(fixture.getModelCalls()).toBe(0);
	});

	it("treats every code proposal as a strict exact-digest permit", async () => {
		const fixture = await createFixture();
		const seed = await fixture.service.init();
		const proposal = await stageProposal({
			paths: fixture.service.paths,
			parentDigest: seed.digest,
			observationsMarkdown: "A deliberately misclassified code proposal.",
			draft: {
				motivation: "Exercise code permit classification",
				expectedEffect: "Code approval remains strict",
				risk: "Persistent tier metadata is untrusted",
				verifyPlan: "Require the code context digest",
				trialPlan: "Do not activate",
				source: "explicit-request",
				evidence: [],
				inboxReferences: [],
				replayScenarios: [],
				changes: [{ path: "memory/code-tier.md", content: "Strict code approval.\n" }],
			},
		});
		proposal.kind = "code";
		proposal.tier = "T0";
		proposal.approvalDigest = "a".repeat(64);
		await saveProposal(fixture.service.paths, proposal);

		const prompts: string[] = [];
		const responses = ["approve", proposal.diffDigest];
		await expect(
			runEvoCli(["permit", proposal.id], {
				service: fixture.service,
				runner: fixture.runner,
				io: {
					interactive: true,
					write: () => {},
					writeError: () => {},
					question: async (prompt: string) => {
						prompts.push(prompt);
						return responses.shift() ?? "";
					},
				},
			}),
		).rejects.toThrow("Approval digest did not match");
		expect(prompts[0]).toContain("[v] revise");
		expect(prompts[1]).toContain(`code approval context digest ${proposal.approvalDigest}`);
		expect((await fixture.service.getProposal(proposal.id)).status).toBe("pending");

		const harness = createHarness(fixture.root);
		await createEvoCommandExtension({ service: fixture.service, runner: fixture.runner })(harness.api);
		harness.setSelectResponse("Approve");
		harness.setInputResponse(proposal.diffDigest);
		await harness.commands.get("evo")?.handler(`permit ${proposal.id}`, harness.context);
		expect(harness.notifications.some((entry) => entry.message.includes("did not match"))).toBe(true);
		expect((await fixture.service.getProposal(proposal.id)).status).toBe("pending");
	});

	it("shows and updates the reflection schedule from the extension command", async () => {
		const fixture = await createFixture();
		await fixture.service.init();
		const harness = createHarness(fixture.root);
		await createEvoCommandExtension({ service: fixture.service, runner: fixture.runner })(harness.api);
		const command = harness.commands.get("evo");

		await command?.handler("schedule every 7d", harness.context);
		expect(harness.notifications.at(-1)?.message).toContain("reflect once every 7 days");
		expect(await readScheduleConfig(fixture.service.paths)).toMatchObject({ mode: "auto", everyDays: 7 });

		harness.setSelectResponse("Manual only");
		await command?.handler("schedule", harness.context);
		expect(harness.notifications.at(-1)?.message).toContain("manual");
		expect(await readScheduleConfig(fixture.service.paths)).toMatchObject({ mode: "manual" });

		harness.setSelectResponse("Keep current");
		await command?.handler("schedule", harness.context);
		expect(harness.notifications.at(-1)?.message).toContain("cadence: manual");
		expect(await readScheduleConfig(fixture.service.paths)).toMatchObject({ mode: "manual" });

		harness.notifications.length = 0;
		await command?.handler("schedule sometimes", harness.context);
		expect(harness.notifications.some((entry) => entry.type === "error" && entry.message.includes("Usage:"))).toBe(
			true,
		);
		expect(fixture.getModelCalls()).toBe(0);
	});

	it("shows and updates the reflection schedule from the local CLI", async () => {
		const fixture = await createFixture();
		const output: string[] = [];
		const io = {
			interactive: false,
			write: (message: string) => output.push(message),
			writeError: () => {},
			question: async () => "",
		};

		await runEvoCli(["schedule"], { service: fixture.service, runner: fixture.runner, io });
		expect(output.at(-1)).toContain("cadence: auto (reflect once every 3 days)");
		expect(output.at(-1)).toContain("last background run: never");

		await runEvoCli(["schedule", "manual"], { service: fixture.service, runner: fixture.runner, io });
		expect(output.at(-1)).toContain("manual");
		expect(await readScheduleConfig(fixture.service.paths)).toMatchObject({ mode: "manual" });

		await runEvoCli(["schedule", "every", "2d"], { service: fixture.service, runner: fixture.runner, io });
		expect(await readScheduleConfig(fixture.service.paths)).toMatchObject({ mode: "auto", everyDays: 2 });
		expect(fixture.getModelCalls()).toBe(0);
	});

	it("skips a manual-mode scheduled improve without calling the model", async () => {
		const fixture = await createFixture();
		await fixture.service.init();
		await writeScheduleConfig(fixture.service.paths, { mode: "manual" });
		const output: string[] = [];
		await runEvoCli(["scheduled-improve"], {
			service: fixture.service,
			runner: fixture.runner,
			io: {
				interactive: false,
				write: (message) => output.push(message),
				writeError: () => {},
				question: async () => "",
			},
		});
		expect(output.at(-1)).toBe("Scheduled improve skipped: manual-mode");
		expect(fixture.getModelCalls()).toBe(0);
	});

	it("surfaces an active trial without exposing its proposal id", async () => {
		const fixture = await createFixture();
		const seed = await fixture.service.init();
		const proposal = await stageProposal({
			paths: fixture.service.paths,
			parentDigest: seed.digest,
			observationsMarkdown: "A due trial needs a status reminder.",
			draft: {
				motivation: "Exercise the due-trial status",
				expectedEffect: "The status becomes visible",
				risk: "The reminder may be noisy",
				verifyPlan: "Inspect the status indicator",
				trialPlan: "Watch for a week",
				source: "pattern",
				evidence: [],
				inboxReferences: [],
				replayScenarios: [],
				changes: [{ path: "memory/trial-due.md", content: "Trial due reminder.\n" }],
			},
		});
		if (!proposal.candidateDigest) throw new Error("Due-trial proposal has no candidate digest");
		proposal.status = "trialing";
		await saveProposal(fixture.service.paths, proposal);
		await fixture.service.registry.activateTrial({
			digest: proposal.candidateDigest,
			proposalId: proposal.id,
			plan: proposal.trialPlan,
		});
		const harness = createHarness(fixture.root);
		const dependencies = { service: fixture.service, paths: fixture.service.paths };

		await refreshEvoStatusIndicator(dependencies, harness.context);
		let item = harness.statusItems.at(-1)?.items?.[0];
		expect(item?.text).toContain("Trial 运行中");
		expect(item?.text).toContain("Exercise the due-trial status");
		expect(item?.text).not.toContain(proposal.id);

		const eightDaysLater = () => new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
		await refreshEvoStatusIndicator(dependencies, harness.context, eightDaysLater);
		item = harness.statusItems.at(-1)?.items?.[0];
		expect(item?.text).toContain("Trial comparison pending");
		expect(item?.text).not.toContain(proposal.id);
	});
});
