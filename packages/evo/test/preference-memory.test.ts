import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCompiledBundle } from "../src/bundle/compile.ts";
import { renderRuntimeBundle } from "../src/bundle/runtime.ts";
import { applyInboxDecisions, initializeInboxLifecycle, readInboxLifecycleStates } from "../src/inbox.ts";
import { deterministicPreferenceId } from "../src/memory/preferences.ts";
import { getEvoPaths } from "../src/paths.ts";
import { proposalApproval, stageProposal } from "../src/proposal.ts";
import { createRecorderStore } from "../src/recorder/store.ts";
import { EvoService } from "../src/service.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-evo-preferences-"));
	roots.push(root);
	const paths = getEvoPaths(root);
	const service = new EvoService(paths);
	const parent = await service.init(["read"]);
	return { root, paths, service, parent };
}

describe("durable preference memory", () => {
	it("materializes an exact preference, injects only its instruction, and collects its terminal inbox payload", async () => {
		const f = await fixture();
		const sessionId = "preference-session";
		const userText =
			"注意不要防御性修改，按照第一性原理完整修改我们的代码。不要冗余不要过度防御。为了设计构建代码而不是为了过度防御。";
		const instruction = "按照第一性原理完整修改我们的代码。不要冗余不要过度防御。";
		const store = await createRecorderStore({
			paths: f.paths,
			sessionId,
			bundleDigest: f.parent.digest,
		});
		const inbox = await store.writeInbox(userText, "interactive", "candidate");
		await initializeInboxLifecycle(f.paths, inbox.fileName);
		await applyInboxDecisions(
			f.paths,
			[
				{
					file: inbox.fileName,
					kind: "preference",
					instruction,
					reason: "The user stated a cross-task implementation default.",
				},
			],
			new Set([inbox.fileName]),
		);
		const feedback = await store.append({
			type: "explicit_feedback",
			source: "interactive",
			text: await store.storePayload(userText),
			inboxFile: inbox.fileName,
		});
		const preferenceMemory = {
			schemaVersion: 1,
			preferences: [
				{
					id: deterministicPreferenceId(instruction),
					instruction,
					source: { sessionId, sequence: feedback.sequence, quote: userText },
					addedAt: "2026-07-15T00:00:00.000Z",
				},
			],
		};
		const proposal = await stageProposal({
			paths: f.paths,
			parentDigest: f.parent.digest,
			draft: {
				motivation: "Persist the user's explicit implementation preference.",
				expectedEffect: "Future builders follow the user's design-first default.",
				risk: "The preference may be too broad.",
				verifyPlan: "Compile and inspect the rendered preference section.",
				trialPlan: "Direct exact preference materialization.",
				source: "explicit-request",
				evidence: [{ sessionId, sequence: feedback.sequence, quote: userText }],
				inboxReferences: [inbox.fileName],
				replayScenarios: [],
				changes: [
					{ path: "memory/preferences.json", content: `${JSON.stringify(preferenceMemory, undefined, "\t")}\n` },
				],
			},
			observationsMarkdown: "# Explicit durable preference",
		});
		expect(proposal.tier).toBe("T0");

		const kept = await f.service.approve(proposal.id, proposalApproval(proposal));
		expect(kept.status).toBe("kept");
		if (!kept.candidateDigest) throw new Error("Preference proposal has no candidate digest");
		const runtime = await renderRuntimeBundle(await loadCompiledBundle(f.paths, kept.candidateDigest));
		expect(runtime.systemPromptAppend).toContain(instruction);
		expect(runtime.systemPromptAppend).not.toContain("design-first");
		expect(runtime.systemPromptAppend).not.toContain(sessionId);
		expect(runtime.systemPromptAppend).not.toContain("注意不要防御性修改");

		await expect(access(inbox.path)).rejects.toMatchObject({ code: "ENOENT" });
		expect((await readInboxLifecycleStates(f.paths)).get(inbox.fileName)).toMatchObject({
			kind: "preference",
			status: "materialized",
			proposalId: proposal.id,
			payloadDeletedAt: expect.any(String),
			sourceDigest: expect.any(String),
		});
		expect(await readFile(f.paths.inboxHistory, "utf8")).toContain("Terminal inbox payload garbage-collected");
	});
});
