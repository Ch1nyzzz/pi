import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileBundle } from "../src/bundle/compile.ts";
import { EvolutionProcessInspector } from "../src/evolve/inspect-ui.ts";
import { getEvoPaths } from "../src/paths.ts";
import { loadProposal, stageProposal } from "../src/proposal.ts";
import { BundleRegistry } from "../src/registry/registry.ts";
import { EvoService } from "../src/service.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const tui = { terminal: { rows: 12 }, requestRender: () => {} };
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

async function seedFixture(runCount: number) {
	const directory = await mkdtemp(join(tmpdir(), "evo-inspect-ui-"));
	roots.push(directory);
	const paths = getEvoPaths(join(directory, "evo"));
	const source = join(directory, "source");
	await mkdir(join(source, "prompts"), { recursive: true });
	await writeFile(join(source, "prompts", "system.md"), "System prompt\n");
	await writeFile(join(source, "policy.json"), '{ "schemaVersion": 1 }\n');
	const bundle = await compileBundle({ paths, sourceDirectory: source, parentDigest: null, summary: "seed" });
	await new BundleRegistry(paths).initialize(bundle.digest);
	const digest = bundle.digest;
	for (let index = 0; index < runCount; index++) {
		const id = `r-2026-07-15T00-00-${String(index).padStart(2, "0")}-000Z-0000000${index.toString(16)}`;
		const timestamp = new Date(Date.parse("2026-07-15T00:00:00Z") + index * 60_000).toISOString();
		await mkdir(join(paths.runs, id), { recursive: true });
		await writeFile(
			join(paths.runs, id, "run.json"),
			`${JSON.stringify({
				schemaVersion: 1,
				id,
				trigger: "request",
				status: "failed",
				startedAt: timestamp,
				updatedAt: timestamp,
				evidenceDigest: "",
				request: `historical run ${index}`,
			})}\n`,
		);
	}
	return { paths, service: new EvoService(paths), digest };
}

function waitForRefresh(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 400));
}

describe("evolution inspector viewport", () => {
	it("falls back to the task list with a notice when the opened item no longer exists", async () => {
		const { paths, service } = await seedFixture(1);
		const inspector = new EvolutionProcessInspector(
			tui as never,
			theme as never,
			paths,
			service,
			"proposal:p-2026-01-01T00-00-00-000Z-deadbeef",
			() => {},
			async () => {},
		);
		await waitForRefresh();
		const view = inspector.render(100).join("\n");
		inspector.dispose();
		expect(view).toContain("Evo 工作流");
		expect(view).toContain("所选事项已不存在");
		expect(view).not.toContain("正在连接后台任务");
	});

	it("processes a pending proposal directly from the detail view", async () => {
		const { paths, service, digest } = await seedFixture(0);
		const proposal = await stageProposal({
			paths,
			parentDigest: digest,
			observationsMarkdown: "A stale duplicate proposal.",
			draft: {
				motivation: "Duplicate of an already kept candidate",
				expectedEffect: "None; it should be rejected",
				risk: "None",
				verifyPlan: "Inspect the diff",
				trialPlan: "Do not activate",
				source: "pattern",
				evidence: [],
				inboxReferences: [],
				replayScenarios: [],
				changes: [{ path: "memory/dup.md", content: "Duplicate.\n" }],
			},
		});
		const inspector = new EvolutionProcessInspector(
			tui as never,
			theme as never,
			paths,
			service,
			`proposal:${proposal.id}`,
			() => {},
			async () => {},
		);
		await waitForRefresh();
		let view = inspector.render(100).join("\n");
		// The pinned action bar is visible without scrolling.
		expect(view).toContain("处理此提案");
		expect(view).toContain("批准");
		inspector.handleInput("\u001b[C"); // Right: select 拒绝
		inspector.handleInput("\r");
		view = inspector.render(100).join("\n");
		expect(view).toContain("拒绝理由");
		inspector.handleInput("duplicate candidate already kept");
		inspector.handleInput("\r");
		await waitForRefresh();
		const rejected = await loadProposal(paths, proposal.id);
		expect(rejected.status).toBe("rejected");
		view = inspector.render(100).join("\n");
		inspector.dispose();
		// After the action, the inspector returns to the task list with a notice.
		expect(view).toContain("Evo 工作流");
		expect(view).toContain("提案已拒绝");
	});

	it("keeps the top items visible by default and scrolls the selection into view", async () => {
		const { paths, service } = await seedFixture(12);
		const inspector = new EvolutionProcessInspector(
			tui as never,
			theme as never,
			paths,
			service,
			undefined,
			() => {},
			async () => {},
		);
		await waitForRefresh();
		const initial = inspector.render(100);
		// The list is top-anchored: the header and the first (highest-priority)
		// item are visible even when the terminal cannot fit every entry.
		expect(initial[0]).toContain("Evo 工作流");
		expect(initial.join("\n")).toContain("›");
		for (let presses = 0; presses < 11; presses++) inspector.handleInput("\u001b[B");
		const scrolled = inspector.render(100);
		inspector.dispose();
		// After moving the selection past the viewport, the selected row scrolls
		// into view instead of staying hidden below the fold.
		expect(scrolled.join("\n")).toContain("›");
	});
});
