import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import { compileBundle } from "../src/bundle/compile.ts";
import { EvolutionProcessInspector } from "../src/evolve/inspect-ui.ts";
import { getEvoPaths } from "../src/paths.ts";
import { stageProposal } from "../src/proposal.ts";
import { BundleRegistry } from "../src/registry/registry.ts";
import { EvoService } from "../src/service.ts";

const tui = { terminal: { rows: 24 }, requestRender: () => {} };
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => `**${text}**` };

function print(title: string, lines: string[]) {
	console.log(`\n${"=".repeat(20)} ${title} ${"=".repeat(20)}`);
	console.log(lines.join("\n"));
}

it("renders the redesigned inspector", async () => {
	const directory = await mkdtemp(join(tmpdir(), "evo-ui-demo-"));
	const paths = getEvoPaths(join(directory, "evo"));
	const source = join(directory, "source");
	await mkdir(join(source, "prompts"), { recursive: true });
	await writeFile(join(source, "prompts", "system.md"), "System prompt\n");
	await writeFile(join(source, "policy.json"), '{ "schemaVersion": 1 }\n');
	const bundle = await compileBundle({ paths, sourceDirectory: source, parentDigest: null, summary: "seed" });
	await new BundleRegistry(paths).initialize(bundle.digest);
	const service = new EvoService(paths);

	const proposal = await stageProposal({
		paths,
		parentDigest: bundle.digest,
		observationsMarkdown: "Cache hits drop after compaction.",
		draft: {
			motivation:
				"The open explicit request reports cache-hit loss after compaction. Reuse the existing content-addressed compaction/v1 artifact, rather than redesigning it, to test its byte-stable previous-summary append mechanism under the frozen reversible Canary experiment.",
			expectedEffect:
				"For eligible non-rebase append compactions, test whether preserving the prior summary as an exact byte prefix improves the frozen end-to-end primary metric tokensPerTask by at least 100000 versus the stable matched coding cohort, without crossing any frozen safety boundary.",
			risk: "A bounded extractive summary can omit needed facts, and provider cache behavior is confounded by TTL, request shape, transport, and provider internals. Any component protocol failure requires rollback under the frozen plan.",
			verifyPlan:
				"Execute only the frozen profiles. Before activation, bundle-compile must show that policy changes only by selecting the existing compaction/v1 artifact digest with the frozen config.",
			trialPlan: "Run the frozen reversible Canary experiment.",
			source: "explicit-request",
			evidence: [],
			inboxReferences: [],
			replayScenarios: [],
			changes: [{ path: "memory/cache-notes.md", content: "Cache-anchor append experiment.\n" }],
		},
	});
	// Historical runs for the queue view
	for (let index = 0; index < 3; index++) {
		const id = `r-2026-07-15T00-00-0${index}-000Z-00000000${index}`;
		const timestamp = new Date(Date.parse("2026-07-15T00:00:00Z") + index * 60_000).toISOString();
		await mkdir(join(paths.runs, id), { recursive: true });
		await writeFile(
			join(paths.runs, id, "run.json"),
			`${JSON.stringify({
				schemaVersion: 1,
				id,
				trigger: index === 1 ? "scheduled" : "request",
				status: index === 1 ? "failed" : "completed",
				startedAt: timestamp,
				updatedAt: timestamp,
				evidenceDigest: "",
				request: "定时演化",
			})}\n`,
		);
	}

	// 1. Queue view
	const queue = new EvolutionProcessInspector(
		tui as never,
		theme as never,
		paths,
		service,
		undefined,
		() => {},
		async () => {},
	);
	await new Promise((resolve) => setTimeout(resolve, 400));
	print("队列视图", queue.render(100));

	// 2. Proposal detail
	const detail = new EvolutionProcessInspector(
		tui as never,
		theme as never,
		paths,
		service,
		`proposal:${proposal.id}`,
		() => {},
		async () => {},
	);
	await new Promise((resolve) => setTimeout(resolve, 400));
	print("提案详情（默认）", detail.render(100));
	detail.handleInput("\t"); // Tab to risk section
	detail.handleInput(" "); // expand
	print("提案详情（展开风险）", detail.render(100));
	detail.dispose();
	queue.dispose();
});
