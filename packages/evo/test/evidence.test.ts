import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileBundle } from "../src/bundle/compile.ts";
import { type EvoPaths, getEvoPaths } from "../src/paths.ts";
import type { DraftProposal } from "../src/proposal.ts";
import { createRecorderStore, type RecorderStore } from "../src/recorder/store.ts";
import { collectEvidenceCorpus, loadReplayScenario, validateDraftGrounding } from "../src/reflect/evidence.ts";
import { BundleRegistry } from "../src/registry/registry.ts";

describe("evidence", () => {
	const temporaryDirectories: string[] = [];

	afterEach(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
		);
	});

	async function createPaths(): Promise<{ root: string; paths: EvoPaths }> {
		const root = await mkdtemp(join(tmpdir(), "pi-evo-evidence-"));
		temporaryDirectories.push(root);
		return { root, paths: getEvoPaths(join(root, "evo")) };
	}

	function createDraft(overrides: Partial<DraftProposal> = {}): DraftProposal {
		return {
			motivation: "A repeated problem",
			expectedEffect: "Improve the affected behavior",
			risk: "May over-apply the rule",
			verifyPlan: "Replay the cited turns",
			trialPlan: "Review after one week",
			source: "pattern",
			evidence: [],
			inboxReferences: [],
			replayScenarios: [],
			changes: [{ path: "memory/preference.md", content: "Apply the preference.\n" }],
			...overrides,
		};
	}

	async function appendMessage(store: RecorderStore, role: "user" | "assistant", content: string) {
		return store.append({
			type: "message",
			role,
			message: await store.storePayload({ role, content, timestamp: 1 }),
		});
	}

	it("collects recent evidence and expands artifact-backed payloads within the byte budget", async () => {
		const { root, paths } = await createPaths();
		const store = await createRecorderStore({
			paths,
			sessionId: "artifact-session",
			artifactThresholdBytes: 8,
			previewCharacters: 12,
			now: () => new Date("2026-07-13T00:00:00.000Z"),
		});
		await store.append({ type: "session_start", reason: "startup", cwd: "/workspace/project" });
		const artifactText = `artifact-body-${"x".repeat(200)}-restored-tail`;
		const message = await store.storePayload({ role: "user", content: artifactText, timestamp: 1 });
		expect(message.artifact).toBeDefined();
		await store.append({ type: "message", role: "user", message });
		const inbox = await store.writeInbox("REQUEST: add deterministic release checks", "interactive");

		const source = join(root, "bundle-source");
		await mkdir(join(source, "prompts"), { recursive: true });
		await writeFile(
			join(source, "policy.json"),
			`${JSON.stringify({ schemaVersion: 1, promptOrder: ["prompts/system.md"] })}\n`,
		);
		await writeFile(join(source, "prompts", "system.md"), "Current bundle instruction.");
		const bundle = await compileBundle({
			paths,
			sourceDirectory: source,
			parentDigest: null,
			summary: "Evidence test",
		});
		await new BundleRegistry(paths).initialize(bundle.digest);

		const corpus = await collectEvidenceCorpus(paths, { maxBytes: 128 * 1024 });

		expect(corpus.text).toContain(artifactText);
		expect(corpus.text).toContain(inbox.entry.text);
		expect(corpus.text).toContain('"action": "initialize"');
		expect(corpus.text).toContain("Current bundle instruction.");
		expect(corpus.bytes).toBeLessThanOrEqual(corpus.maxBytes);
		expect(corpus.sessionIds).toEqual(["artifact-session"]);
		expect(corpus.inboxFiles).toEqual([inbox.fileName]);
		expect(corpus.bundleDigest).toBe(bundle.digest);
		expect(corpus.text.indexOf("sequence 1")).toBeLessThan(corpus.text.indexOf("sequence 2"));
		expect((await collectEvidenceCorpus(paths, { maxBytes: 2 * 1024 })).text).toMatch(/^## Current bundle/);
	});

	it("rejects forged references, false quotes, and non-independent pattern evidence", async () => {
		const { paths } = await createPaths();
		const firstStore = await createRecorderStore({ paths, sessionId: "pattern-one" });
		const secondStore = await createRecorderStore({ paths, sessionId: "pattern-two" });
		const first = await appendMessage(firstStore, "user", "Always include the exact verification command.");
		const second = await appendMessage(secondStore, "user", "Again, include the exact verification command.");
		const evidence = [
			{ sessionId: first.sessionId, sequence: first.sequence, quote: "exact verification command" },
			{ sessionId: second.sessionId, sequence: second.sequence, quote: "exact verification command" },
		];

		expect(await validateDraftGrounding(paths, createDraft({ evidence }))).toEqual(evidence);
		await expect(
			validateDraftGrounding(
				paths,
				createDraft({ evidence: [evidence[0], { sessionId: "pattern-two", sequence: 999 }] }),
			),
		).rejects.toThrow("Evidence reference does not exist");
		await expect(
			validateDraftGrounding(
				paths,
				createDraft({ evidence: [{ ...evidence[0], quote: "fabricated quote" }, evidence[1]] }),
			),
		).rejects.toThrow("Evidence quote was not found");
		await expect(
			validateDraftGrounding(paths, createDraft({ evidence: [evidence[0], evidence[0]] })),
		).rejects.toThrow("at least two independent evidence references");
	});

	it("requires grounded explicit requests and rejects inbox path traversal", async () => {
		const { paths } = await createPaths();
		const store = await createRecorderStore({ paths, sessionId: "explicit-session" });
		const userMessage = await appendMessage(store, "user", "Please add a release checklist.");
		const inbox = await store.writeInbox("REQUEST: add a release checklist", "interactive");

		expect(
			await validateDraftGrounding(
				paths,
				createDraft({ source: "explicit-request", inboxReferences: [inbox.fileName] }),
			),
		).toEqual([]);
		expect(
			await validateDraftGrounding(
				paths,
				createDraft({
					source: "explicit-request",
					evidence: [
						{ sessionId: userMessage.sessionId, sequence: userMessage.sequence, quote: "release checklist" },
					],
				}),
			),
		).toHaveLength(1);
		await expect(
			validateDraftGrounding(
				paths,
				createDraft({
					source: "explicit-request",
					evidence: [{ sessionId: userMessage.sessionId, sequence: userMessage.sequence }],
				}),
			),
		).rejects.toThrow("require a valid inbox reference or explicit user evidence");
		await expect(
			validateDraftGrounding(
				paths,
				createDraft({ source: "explicit-request", inboxReferences: [`../${inbox.fileName}`] }),
			),
		).rejects.toThrow("must be a plain file name");
		await expect(validateDraftGrounding(paths, createDraft({ source: "explicit-request" }))).rejects.toThrow(
			"require a valid inbox reference or explicit user evidence",
		);
	});

	it("loads a user-targeted replay with preceding history and the recorded system prompt", async () => {
		const { paths } = await createPaths();
		const store = await createRecorderStore({
			paths,
			sessionId: "replay-session",
			artifactThresholdBytes: 8,
			previewCharacters: 10,
		});
		await store.append({ type: "session_start", reason: "startup", cwd: "/workspace/replay" });
		const priorUser = await appendMessage(store, "user", "Earlier question");
		const priorAssistant = await appendMessage(store, "assistant", "Earlier answer");
		const oldSystemPrompt = `old-system-${"s".repeat(100)}-complete`;
		await store.append({
			type: "before_agent_start",
			prompt: await store.storePayload("Target question"),
			systemPrompt: await store.storePayload(oldSystemPrompt),
			systemPromptOptions: await store.storePayload({}),
		});
		const target = await appendMessage(store, "user", "Target question");

		const replay = await loadReplayScenario(paths, {
			sessionId: target.sessionId,
			sequence: target.sequence,
		});

		expect(replay).toMatchObject({
			targetPrompt: "Target question",
			oldSystemPrompt,
			sessionIdentity: "replay-session",
			cwd: "/workspace/replay",
		});
		expect(replay.history).toEqual([
			{ role: "user", content: "Earlier question", timestamp: 1 },
			{ role: "assistant", content: "Earlier answer", timestamp: 1 },
		]);
		await expect(
			loadReplayScenario(paths, { sessionId: priorAssistant.sessionId, sequence: priorAssistant.sequence }),
		).rejects.toThrow("Replay target must be a user message");
		await expect(
			loadReplayScenario(paths, { sessionId: `../${priorUser.sessionId}`, sequence: priorUser.sequence }),
		).rejects.toThrow("Invalid recorder session id");
	});
});
