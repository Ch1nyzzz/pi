import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildTrialComparison, storeTrialComparison } from "../src/comparison.ts";
import { getEvoPaths } from "../src/paths.ts";
import { saveProposal } from "../src/proposal.ts";
import { buildSessionDigest } from "../src/recorder/digest.ts";
import { createRecorderStore } from "../src/recorder/store.ts";
import type { Proposal, TrialState } from "../src/types.ts";

const PARENT = "a".repeat(64);
const CANDIDATE = "b".repeat(64);
const DIFF = "c".repeat(64);

function proposalFixture(): Proposal {
	return {
		schemaVersion: 2,
		id: "p-comparison",
		createdAt: "2026-07-01T00:00:00.000Z",
		revision: 1,
		parentBundleDigest: PARENT,
		kind: "data",
		tier: "T1",
		motivation: "Reduce retries",
		diff: "--- old\n+++ new\n",
		expectedEffect: "Fewer tool errors and follow-up turns",
		risk: "The instruction may be too broad",
		verifyPlan: "Compare automatic session metrics",
		trialPlan: "Use for ten sessions",
		status: "trialing",
		source: "pattern",
		evidence: [],
		inboxReferences: [],
		replayScenarios: [],
		changedPaths: ["prompts/system.md"],
		diffDigest: DIFF,
		approvalDigest: DIFF,
		candidateDigest: CANDIDATE,
		l1: { passed: true, reason: "compiled", errors: [] },
		artifacts: {},
	};
}

async function recordSession(options: {
	paths: ReturnType<typeof getEvoPaths>;
	sessionId: string;
	bundleDigest: string;
	timestamp: string;
	toolError?: boolean;
}): Promise<void> {
	const store = await createRecorderStore({
		paths: options.paths,
		sessionId: options.sessionId,
		bundleDigest: options.bundleDigest,
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
	await store.append({
		type: "usage",
		provider: "fake",
		model: "worker",
		usage: { input: 10, output: 5, cacheRead: 20, cacheWrite: 0, totalTokens: 35 },
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

describe("automatic trial comparison", () => {
	const roots: string[] = [];

	afterEach(async () => {
		await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	});

	it("builds and stores before/after cohorts from every completed pinned session", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-evo-comparison-"));
		roots.push(root);
		const paths = getEvoPaths(join(root, "evo"));
		await recordSession({
			paths,
			sessionId: "baseline",
			bundleDigest: PARENT,
			timestamp: "2026-07-01T00:00:00.000Z",
			toolError: true,
		});
		await recordSession({
			paths,
			sessionId: "unmatched-conversation",
			bundleDigest: PARENT,
			timestamp: "2026-07-01T12:00:00.000Z",
		});
		await recordSession({
			paths,
			sessionId: "candidate",
			bundleDigest: CANDIDATE,
			timestamp: "2026-07-03T00:00:00.000Z",
			toolError: false,
		});
		const proposal = proposalFixture();
		await mkdir(join(paths.proposals, proposal.id), { recursive: true });
		await saveProposal(paths, proposal);
		const trial: TrialState = {
			digest: CANDIDATE,
			parent: PARENT,
			proposalId: proposal.id,
			startedAt: "2026-07-02T00:00:00.000Z",
			plan: "Use for ten sessions",
		};

		const comparison = await buildTrialComparison(paths, proposal, trial);
		expect(comparison.before.sessions.map((session) => session.sessionId)).toEqual(["baseline"]);
		expect(comparison.after.sessions.map((session) => session.sessionId)).toEqual(["candidate"]);
		expect(comparison.matching).toEqual({ taskClasses: ["coding"], excludedBeforeSessions: 1 });
		expect(comparison.before.rates.toolErrorRate).toBe(1);
		expect(comparison.after.rates.toolErrorRate).toBe(0);
		expect(comparison.delta.toolErrorRate).toBe(-1);

		const first = await storeTrialComparison(paths, proposal, trial, () => new Date("2026-07-04T00:00:00.000Z"));
		const second = await storeTrialComparison(
			paths,
			first.proposal,
			trial,
			() => new Date("2026-07-05T00:00:00.000Z"),
		);
		expect(first.reused).toBe(false);
		expect(second.reused).toBe(true);
		expect(first.reference.file).toMatch(/^revisions\/1\/comparisons\/[a-f0-9]{64}\.json$/);
		expect(first.comparison.sufficiency).toMatchObject({ status: "insufficient" });
		expect(first.comparison.matching.taskClasses).toEqual(["coding"]);
		expect(JSON.parse(await readFile(join(paths.proposals, proposal.id, first.reference.file), "utf8"))).toEqual(
			first.comparison,
		);
		expect(
			await readFile(join(paths.proposals, proposal.id, first.reference.file.replace(/\.json$/, ".md")), "utf8"),
		).toContain("Evidence status: **insufficient**");
	});
});
