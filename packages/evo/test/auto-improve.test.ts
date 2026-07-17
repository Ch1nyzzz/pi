import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@ch1nyzzz/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createEvoAutoImproveExtension } from "../src/auto-improve.ts";
import { getEvoPaths } from "../src/paths.ts";
import { attachProposalArtifact, proposalApproval, stageProposal } from "../src/proposal.ts";
import type { ModelRunner } from "../src/reflect/model-runner.ts";
import { readImproveRunEvents, writeScheduleConfig } from "../src/scheduler.ts";
import { EvoService } from "../src/service.ts";

type EventHandler = (event: unknown, ctx: ExtensionCommandContext) => unknown;

function createHarness(cwd: string) {
	const handlers = new Map<string, EventHandler[]>();
	const notifications: Array<{ message: string; type: string | undefined }> = [];
	const statuses: Array<{ key: string; text: string | undefined }> = [];
	let idle = true;

	const api = {
		on: (event: string, handler: EventHandler) => {
			const registered = handlers.get(event) ?? [];
			registered.push(handler);
			handlers.set(event, registered);
		},
		registerCommand: () => {},
		registerShortcut: () => {},
		sendMessage: () => {},
		getActiveTools: () => [],
	} as unknown as ExtensionAPI;
	const context = {
		cwd,
		hasUI: true,
		mode: "tui",
		isIdle: () => idle,
		waitForIdle: async () => {},
		sessionManager: {
			getSessionId: () => "auto-improve-session",
		},
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			notify: (message: string, type?: string) => notifications.push({ message, type }),
			setStatus: (key: string, text: string | undefined) => void statuses.push({ key, text }),
			setStatusItems: () => {},
		},
	} as unknown as ExtensionCommandContext;

	return {
		api,
		notifications,
		statuses,
		setIdle: (value: boolean) => {
			idle = value;
		},
		async emit(event: string, value: unknown): Promise<void> {
			for (const handler of handlers.get(event) ?? []) await handler(value, context);
		},
	};
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for the auto-improve tick");
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
}

describe("Evo auto-improve extension", () => {
	const temporaryDirectories: string[] = [];

	afterEach(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
		);
	});

	async function createFixture() {
		const root = await mkdtemp(join(tmpdir(), "pi-evo-auto-"));
		temporaryDirectories.push(root);
		const service = new EvoService(getEvoPaths(root));
		const runner: ModelRunner = {
			async run() {
				throw new Error("Auto-improve tests must not reach the real model runner");
			},
		};
		return { root, service, runner };
	}

	it("runs a configured background improve and reports staged proposals", async () => {
		const fixture = await createFixture();
		await fixture.service.init();
		let improveCalls = 0;
		const harness = createHarness(fixture.root);
		await createEvoAutoImproveExtension({
			service: fixture.service,
			runner: fixture.runner,
			initialDelayMs: 5,
			checkIntervalMs: 60_000,
			improve: async () => {
				improveCalls += 1;
				return { proposals: [{ id: "p-background" }] };
			},
		})(harness.api);

		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await waitFor(() => harness.notifications.length > 0);
		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

		expect(improveCalls).toBe(1);
		expect(harness.notifications[0]?.message).toContain("produced 1 proposal");
		expect(harness.notifications[0]?.type).toBe("info");
		const events = await readImproveRunEvents(fixture.service.paths);
		expect(events.map((event) => event.type)).toEqual(["started", "completed"]);
		expect(harness.statuses.at(-1)).toEqual({ key: "evo", text: undefined });
	});

	it("automatically creates a retrospective when a trial is due", async () => {
		const fixture = await createFixture();
		const seed = await fixture.service.init();
		let proposal = await stageProposal({
			paths: fixture.service.paths,
			parentDigest: seed.digest,
			observationsMarkdown: "A recurring preference needs a trial.",
			draft: {
				motivation: "Keep answers focused",
				expectedEffect: "Fewer follow-up corrections",
				risk: "Answers may omit useful context",
				verifyPlan: "Compare normal sessions",
				trialPlan: "Review automatically",
				source: "pattern",
				evidence: [],
				inboxReferences: [],
				replayScenarios: [],
				changes: [{ path: "memory/focused.md", content: "Keep answers focused.\n" }],
			},
		});
		proposal = await attachProposalArtifact({
			paths: fixture.service.paths,
			proposalId: proposal.id,
			expected: proposalApproval(proposal),
			kind: "review",
			content: "# Review\n\nSuitable for a trial.\n",
			allowedStatuses: ["pending"],
		});
		await fixture.service.approve(proposal.id, proposalApproval(proposal));
		await writeScheduleConfig(fixture.service.paths, { trialDueAfterDays: 1 });
		let retrospectiveCalls = 0;
		let improveCalls = 0;
		const harness = createHarness(fixture.root);
		await createEvoAutoImproveExtension({
			service: fixture.service,
			runner: fixture.runner,
			initialDelayMs: 5,
			checkIntervalMs: 60_000,
			now: () => new Date("2100-01-01T00:00:00.000Z"),
			improve: async () => {
				improveCalls += 1;
				return { proposals: [] };
			},
			retrospect: async () => {
				retrospectiveCalls += 1;
				const current = await fixture.service.getProposal(proposal.id);
				current.artifacts.retrospective = {
					file: "revisions/1/retrospectives/fake.md",
					sha256: "d".repeat(64),
					revision: 1,
					diffDigest: current.diffDigest,
					createdAt: "2100-01-01T00:00:00.000Z",
				};
				return { proposal: current };
			},
		})(harness.api);

		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await waitFor(() => retrospectiveCalls === 1);
		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

		expect(improveCalls).toBe(0);
		expect(harness.notifications[0]?.message).toContain("automatically compared the trial");
	});

	it("stays quiet when the registry is uninitialized, the schedule is manual, or the session is busy", async () => {
		const fixture = await createFixture();
		let improveCalls = 0;
		const improve = async () => {
			improveCalls += 1;
			return { proposals: [] };
		};
		const extension = createEvoAutoImproveExtension({
			service: fixture.service,
			runner: fixture.runner,
			initialDelayMs: 5,
			checkIntervalMs: 60_000,
			improve,
		});

		const uninitialized = createHarness(fixture.root);
		await extension(uninitialized.api);
		await uninitialized.emit("session_start", { type: "session_start", reason: "startup" });
		await new Promise<void>((resolve) => setTimeout(resolve, 80));
		await uninitialized.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		expect(improveCalls).toBe(0);
		expect(uninitialized.notifications).toEqual([]);

		await fixture.service.init();
		await writeScheduleConfig(fixture.service.paths, { mode: "manual" });
		const manual = createHarness(fixture.root);
		await extension(manual.api);
		await manual.emit("session_start", { type: "session_start", reason: "startup" });
		await new Promise<void>((resolve) => setTimeout(resolve, 80));
		await manual.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		expect(improveCalls).toBe(0);
		expect(manual.notifications).toEqual([]);

		await writeScheduleConfig(fixture.service.paths, { mode: "auto" });
		const busy = createHarness(fixture.root);
		busy.setIdle(false);
		await extension(busy.api);
		await busy.emit("session_start", { type: "session_start", reason: "startup" });
		await new Promise<void>((resolve) => setTimeout(resolve, 80));
		await busy.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		expect(improveCalls).toBe(0);
		expect(await readImproveRunEvents(fixture.service.paths)).toEqual([]);
	});

	it("notifies a failure once and stops scheduling after shutdown", async () => {
		const fixture = await createFixture();
		await fixture.service.init();
		await writeScheduleConfig(fixture.service.paths, { dailyRunLimit: 10 });
		let improveCalls = 0;
		const harness = createHarness(fixture.root);
		await createEvoAutoImproveExtension({
			service: fixture.service,
			runner: fixture.runner,
			initialDelayMs: 5,
			checkIntervalMs: 20,
			improve: async () => {
				improveCalls += 1;
				throw new Error("background reflection exploded");
			},
		})(harness.api);

		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await waitFor(() => improveCalls >= 2);
		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		const callsAtShutdown = improveCalls;
		await new Promise<void>((resolve) => setTimeout(resolve, 80));

		expect(improveCalls).toBe(callsAtShutdown);
		const failures = harness.notifications.filter((entry) => entry.message.includes("background reflection failed"));
		expect(failures).toHaveLength(1);
		expect(failures[0]?.type).toBe("warning");
	});
});
