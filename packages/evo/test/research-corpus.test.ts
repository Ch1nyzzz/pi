import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materializeEvidenceCorpus } from "../src/evolve/research-corpus.ts";
import type { EvidenceCorpus, EvidenceFragment } from "../src/reflect/evidence.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function corpusWith(fragments: EvidenceFragment[]): EvidenceCorpus {
	return {
		text: "unused inline text",
		bytes: 18,
		maxBytes: 1024 * 1024,
		truncated: false,
		mode: "incremental",
		evidenceDigest: "digest",
		sources: {
			bundle: { bytes: 0, maxBytes: 1, truncated: false },
			history: { bytes: 0, maxBytes: 1, truncated: false },
			inbox: { bytes: 0, maxBytes: 1, truncated: false },
			sessions: { bytes: 0, maxBytes: 1, truncated: false },
		},
		fragments,
		sessionIds: [],
		inboxFiles: [],
		nextReviewCursor: {
			schemaVersion: 1,
			updatedAt: new Date(0).toISOString(),
			inboxFiles: [],
			sessionSequences: {},
		},
	};
}

function sessionEvent(sequence: number, data: Record<string, unknown>): EvidenceFragment {
	return {
		source: "sessions",
		heading: `## Session s-1, sequence ${sequence}`,
		sessionId: "s-1",
		value: {
			schemaVersion: 1,
			sessionId: "s-1",
			sequence,
			timestamp: "2026-07-15T00:00:00.000Z",
			bundleDigest: null,
			...data,
		},
	};
}

describe("materializeEvidenceCorpus", () => {
	it("writes source files, rendered session views, and a prompt index", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-evo-corpus-"));
		roots.push(root);
		const giantLine = "x".repeat(20_000);
		const corpus = corpusWith([
			{ source: "bundle", heading: "## Current bundle abc manifest", value: { summary: "stable" } },
			{ source: "inbox", heading: "## Explicit input a.json", value: { entry: { text: "REQUEST: do it" } } },
			{
				source: "sessions",
				heading: "## Session digest s-1",
				sessionId: "s-1",
				value: { sessionId: "s-1", taskClass: "coding" },
			},
			sessionEvent(1, {
				type: "message",
				role: "user",
				message: { role: "user", content: "Please fix compaction." },
			}),
			sessionEvent(2, {
				type: "tool",
				toolCallId: "t1",
				toolName: "read",
				startedAt: "",
				endedAt: "",
				durationMs: 12,
				input: { path: "/tmp/file" },
				result: { content: [{ type: "text", text: giantLine }] },
				isError: false,
			}),
			sessionEvent(3, {
				type: "compaction",
				reason: "threshold",
				willRetry: false,
				fromExtension: false,
				firstKeptEntryId: "e9",
				tokensBefore: 120_000,
				durationMs: 400,
				summary: "Earlier work summarized.",
			}),
		]);

		const materialized = await materializeEvidenceCorpus(corpus, root);

		expect(materialized.directory).toBe(join(root, "corpus"));
		expect(materialized.indexText).toContain("corpus/bundle.md");
		expect(materialized.indexText).toContain("corpus/sessions/s-1.md");
		expect(materialized.indexText).toContain("corpus/sessions-raw/s-1.json");
		expect(materialized.indexText).not.toContain("corpus/history.md");
		// Inbox stays inline with its classification obligation, never on disk.
		expect(materialized.indexText).not.toContain("corpus/inbox.md");
		expect(materialized.indexText).toContain("classify every file below in inboxDecisions");
		expect(materialized.indexText).toContain("REQUEST: do it");

		const rendered = await readFile(join(root, "corpus", "sessions", "s-1.md"), "utf8");
		expect(rendered).toContain("# Session s-1");
		expect(rendered).toContain("## Digest");
		expect(rendered).toContain("Please fix compaction.");
		expect(rendered).toContain("**COMPACTION** reason=threshold");
		expect(rendered).toContain("Earlier work summarized.");
		expect(rendered).toContain("[clipped; full content in the matching sessions-raw JSON file]");
		expect(rendered).not.toContain(giantLine);

		const raw = JSON.parse(await readFile(join(root, "corpus", "sessions-raw", "s-1.json"), "utf8")) as unknown[];
		expect(raw).toHaveLength(3);
		expect(JSON.stringify(raw)).toContain(giantLine);

		const bundle = await readFile(join(root, "corpus", "bundle.md"), "utf8");
		expect(bundle).toContain("## Current bundle abc manifest");
	});
});
