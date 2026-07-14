import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type EvoPaths, getEvoPaths } from "../src/paths.ts";
import type { ModelRunResult } from "../src/reflect/model-runner.ts";
import {
	readModelUsageRecords,
	recordModelUsage,
	renderModelUsageSummary,
	summarizeModelUsage,
} from "../src/reflect/usage.ts";

function run(sessionId: string, total: number, cost = 0.01): ModelRunResult {
	return {
		text: "result",
		model: { provider: "fake", id: "worker" },
		stats: {
			sessionFile: undefined,
			sessionId,
			userMessages: 1,
			assistantMessages: 1,
			toolCalls: 0,
			toolResults: 0,
			totalMessages: 2,
			tokens: {
				input: total - 3,
				output: 2,
				cacheRead: 1,
				cacheWrite: 0,
				total,
			},
			cost,
		},
	};
}

describe("background model usage journal", () => {
	let root: string;
	let paths: EvoPaths;
	const roots: string[] = [];

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-evo-usage-"));
		roots.push(root);
		paths = getEvoPaths(join(root, "evo"));
	});

	afterEach(async () => {
		await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
	});

	it("serializes concurrent writers and summarizes a bounded window by phase", async () => {
		await recordModelUsage(paths, "reflector", run("old", 10), {
			now: () => new Date("2026-07-01T00:00:00.000Z"),
		});
		await Promise.all(
			Array.from({ length: 8 }, (_, index) =>
				recordModelUsage(paths, index % 2 === 0 ? "critic" : "replay-candidate", run(`current-${index}`, 20), {
					now: () => new Date("2026-07-12T00:00:00.000Z"),
				}),
			),
		);
		await recordModelUsage(paths, "report", run("future", 30), {
			now: () => new Date("2026-07-15T00:00:00.000Z"),
		});

		const records = await readModelUsageRecords(paths);
		expect(records).toHaveLength(10);
		expect(new Set(records.map((record) => record.sessionId)).size).toBe(10);
		const summary = await summarizeModelUsage(paths, {
			since: new Date("2026-07-08T00:00:00.000Z"),
			until: new Date("2026-07-14T23:59:59.999Z"),
		});
		expect(summary).toMatchObject({
			runs: 8,
			tokens: { input: 136, output: 16, cacheRead: 8, cacheWrite: 0, total: 160 },
			cost: 0.08,
			byPhase: {
				critic: { runs: 4, tokens: { total: 80 } },
				"replay-candidate": { runs: 4, tokens: { total: 80 } },
			},
		});
		const markdown = renderModelUsageSummary(summary);
		expect(markdown).toContain("| critic | 4 |");
		expect(markdown).toContain("| replay-candidate | 4 |");
		expect(markdown).not.toContain("| reflector |");
		expect(markdown).toContain("| **Total** | **8** |");
	});

	it("repairs a torn final record before appending the next durable record", async () => {
		await recordModelUsage(paths, "reflector", run("first", 10));
		const journal = join(paths.reports, "model-usage.jsonl");
		await appendFile(journal, '{"schemaVersion":1,"timestamp":"torn');

		await recordModelUsage(paths, "critic", run("second", 20));

		const records = await readModelUsageRecords(paths);
		expect(records.map((record) => record.sessionId)).toEqual(["first", "second"]);
		expect((await readFile(journal, "utf8")).endsWith("\n")).toBe(true);
	});

	it("fails closed on a complete invalid record instead of rewriting it", async () => {
		await recordModelUsage(paths, "reflector", run("first", 10));
		const journal = join(paths.reports, "model-usage.jsonl");
		await appendFile(journal, '{"schemaVersion":1,"phase":"unknown"}\n');
		const before = await readFile(journal, "utf8");

		await expect(recordModelUsage(paths, "critic", run("second", 20))).rejects.toThrow(
			"Model usage journal line 2 has an invalid timestamp",
		);
		expect(await readFile(journal, "utf8")).toBe(before);
	});
});
