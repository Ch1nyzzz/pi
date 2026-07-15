import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileBundle } from "../src/bundle/compile.ts";
import { type EvoPaths, getEvoPaths } from "../src/paths.ts";
import { createRecorderStore } from "../src/recorder/store.ts";
import {
	advanceEvidenceReviewCursor,
	collectEvidenceCorpus,
	readEvidenceReviewCursor,
} from "../src/reflect/evidence.ts";
import type { ModelRunner, ModelRunRequest, ModelRunResult } from "../src/reflect/model-runner.ts";
import { runReport } from "../src/reflect/reflector.ts";
import { BundleRegistry } from "../src/registry/registry.ts";

class FakeModelRunner implements ModelRunner {
	readonly requests: ModelRunRequest[] = [];
	private readonly responses: string[];

	constructor(responses: string[]) {
		this.responses = [...responses];
	}

	async run(request: ModelRunRequest): Promise<ModelRunResult> {
		this.requests.push(request);
		const text = this.responses.shift();
		if (text === undefined) throw new Error("Fake model runner has no queued response");
		return {
			text,
			model: { provider: "fake", id: request.model ?? "default" },
			stats: {
				sessionFile: undefined,
				sessionId: request.sessionIdentity ?? `fake-${this.requests.length}`,
				userMessages: 1,
				assistantMessages: 1,
				toolCalls: 0,
				toolResults: 0,
				totalMessages: 2,
				tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
				cost: 0,
			},
		};
	}
}

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createFixture(): Promise<{ root: string; paths: EvoPaths }> {
	const root = await mkdtemp(join(tmpdir(), "pi-evo-report-"));
	temporaryRoots.push(root);
	const paths = getEvoPaths(join(root, "evo"));
	const source = join(root, "source");
	await mkdir(join(source, "prompts"), { recursive: true });
	await writeFile(
		join(source, "policy.json"),
		`${JSON.stringify(
			{
				schemaVersion: 1,
				promptOrder: ["prompts/system.md"],
				coreAssets: [],
				modelRouting: { worker: "fake/worker", reflector: "fake/reflector", critic: "fake/critic" },
				validation: {},
			},
			undefined,
			"\t",
		)}\n`,
	);
	await writeFile(join(source, "prompts", "system.md"), "Original instruction.");
	const bundle = await compileBundle({
		paths,
		sourceDirectory: source,
		parentDigest: null,
		summary: "Initial test bundle",
	});
	await new BundleRegistry(paths).initialize(bundle.digest);
	const store = await createRecorderStore({
		paths,
		sessionId: "recorded-session",
		bundleDigest: bundle.digest,
		now: () => new Date("2026-07-13T00:00:00.000Z"),
	});
	await store.append({ type: "session_start", reason: "startup", cwd: root });
	await store.append({
		type: "before_agent_start",
		prompt: await store.storePayload("Initial request"),
		systemPrompt: await store.storePayload("Base worker prompt"),
		systemPromptOptions: await store.storePayload({ tools: ["read", "bash"] }),
	});
	await store.append({
		type: "message",
		role: "user",
		message: await store.storePayload({
			role: "user",
			content: "The agent repeated the unsafe shortcut.",
			timestamp: 1,
		}),
	});
	return { root, paths };
}

function reportResponse(observations: string, evidence: Array<{ sequence: number; quote: string }>): string {
	return JSON.stringify({
		observationsMarkdown: observations,
		observationEvidence: evidence.map((entry) => ({ sessionId: "recorded-session", ...entry })),
		proposals: [],
	});
}

describe("evidence report", () => {
	it("persists validated report citations with the observations", async () => {
		const fixture = await createFixture();
		const runner = new FakeModelRunner([
			reportResponse("# Observations\n\nThe unsafe shortcut recurred.", [
				{ sequence: 3, quote: "The agent repeated the unsafe shortcut." },
			]),
		]);

		const report = await runReport({ paths: fixture.paths, runner, cwd: fixture.root });

		const reportFile = await readFile(report.file, "utf8");
		expect(reportFile).toContain("- recorded-session:3");
		expect(reportFile).toContain("| report | 1 |");
		expect(report.observationsMarkdown).toContain("## Background model usage");
		expect(report.observationEvidence).toHaveLength(1);
	});

	it("limits the default report window to evidence recorded since the last improve", async () => {
		const fixture = await createFixture();
		const store = await createRecorderStore({ paths: fixture.paths, sessionId: "recorded-session" });
		await store.writeInbox("REQUEST: old-report-window-signal", "interactive");
		const reviewed = await collectEvidenceCorpus(fixture.paths, { mode: "incremental" });
		await advanceEvidenceReviewCursor(fixture.paths, reviewed.nextReviewCursor);
		const cursorAfterImprove = await readEvidenceReviewCursor(fixture.paths);
		await store.append({
			type: "message",
			role: "user",
			message: await store.storePayload({ role: "user", content: "new-report-window-signal", timestamp: 4 }),
		});
		const runner = new FakeModelRunner([
			reportResponse("# Observations\n\nWindowed report.", [{ sequence: 4, quote: "new-report-window-signal" }]),
			reportResponse("# Observations\n\nFull report.", [
				{ sequence: 3, quote: "The agent repeated the unsafe shortcut." },
			]),
		]);

		const windowed = await runReport({ paths: fixture.paths, runner, cwd: fixture.root });
		expect(windowed.corpus.mode).toBe("incremental");
		expect(runner.requests[0].prompt).toContain("new-report-window-signal");
		expect(runner.requests[0].prompt).not.toContain("old-report-window-signal");
		expect(await readEvidenceReviewCursor(fixture.paths)).toEqual(cursorAfterImprove);

		const full = await runReport({ paths: fixture.paths, runner, cwd: fixture.root, window: "full" });
		expect(full.corpus.mode).toBe("full");
		expect(runner.requests[1].prompt).toContain("old-report-window-signal");
	});

	it("rejects a report whose observations omit recorded-event citations", async () => {
		const fixture = await createFixture();
		const runner = new FakeModelRunner([reportResponse("# Observations\n\nAn unsupported claim.", [])]);

		await expect(runReport({ paths: fixture.paths, runner, cwd: fixture.root })).rejects.toThrow(
			"Reflector observations must cite recorded session evidence",
		);
		expect(runner.requests).toHaveLength(1);
	});
});
