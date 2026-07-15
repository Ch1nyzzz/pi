import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	formatEvolutionRuns,
	inspectBackgroundEvolutions,
	pauseBackgroundEvolution,
	removeBackgroundEvolution,
	renderEvolutionRunInspection,
	resumeBackgroundEvolution,
	startBackgroundEvolution,
} from "../src/evolve/background.ts";
import { EvolutionProcessInspector } from "../src/evolve/inspect-ui.ts";
import { createEvolutionRun, evolutionRunDirectory, readEvolutionRun, updateEvolutionRun } from "../src/evolve/run.ts";
import { getEvoPaths } from "../src/paths.ts";

const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
	for (const child of children.splice(0)) {
		if (child.pid) {
			try {
				process.kill(child.pid, "SIGKILL");
			} catch {}
		}
	}
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-evo-background-"));
	roots.push(root);
	const paths = getEvoPaths(join(root, "evo"));
	const run = await createEvolutionRun({
		paths,
		trigger: "request",
		request: "research task",
		evidenceDigest: "pending",
		status: "queued",
	});
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "__worker", run.id], {
		stdio: "ignore",
	});
	children.push(child);
	if (!child.pid) throw new Error("Test worker did not start");
	await updateEvolutionRun(paths, run.id, { workerPid: child.pid });
	return { paths, run, child };
}

async function processState(pid: number): Promise<string> {
	const status = await readFile(`/proc/${pid}/status`, "utf8");
	return status.match(/^State:\s+(\S+)/m)?.[1] ?? "";
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!(await check())) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for process state");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("background evolution tasks", () => {
	it("starts a detached worker without awaiting the evolution cycle", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-evo-background-launch-"));
		roots.push(root);
		const paths = getEvoPaths(join(root, "evo"));
		const startedAt = Date.now();
		const run = await startBackgroundEvolution({ paths, cwd: root, request: "background request" });
		expect(Date.now() - startedAt).toBeLessThan(2_000);
		expect(run.status).toBe("queued");
		expect(run.workerPid).toBeTypeOf("number");
		await waitFor(async () => (await readEvolutionRun(paths, run.id)).status === "failed");
		const failed = await readEvolutionRun(paths, run.id);
		expect(failed.error).toContain("not initialized");
		expect(failed.logFile).toContain("worker.log");
	});

	it("renders live progress and phase artifacts for the expandable inspector", async () => {
		const { paths, run } = await fixture();
		const directory = evolutionRunDirectory(paths, run.id);
		await writeFile(
			join(directory, "progress.jsonl"),
			`${JSON.stringify({
				timestamp: "2026-07-15T00:00:00.000Z",
				type: "model-start",
				phase: "researching",
				model: "test/model",
			})}\n`,
		);
		await writeFile(join(directory, "plan.md"), "# Narrow research plan\n");
		const inspection = await renderEvolutionRunInspection(paths, await inspectBackgroundEvolutions(paths), run.id);
		expect(inspection.summary).toContain("queued");
		expect(inspection.markdown).toContain("model-start");
		expect(inspection.markdown).toContain("Narrow research plan");
	});

	it("renders the live headless-agent transcript", async () => {
		const { paths, run } = await fixture();
		await writeFile(
			join(evolutionRunDirectory(paths, run.id), "transcript.jsonl"),
			[
				JSON.stringify({
					timestamp: "2026-07-15T00:00:00Z",
					phase: "researching",
					type: "thinking",
					delta: "checking evidence",
				}),
				JSON.stringify({
					timestamp: "2026-07-15T00:00:01Z",
					phase: "researching",
					type: "text",
					delta: "candidate plan",
				}),
			].join("\n"),
		);
		const tui = { terminal: { rows: 30 }, requestRender: () => {} };
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
		const inspector = new EvolutionProcessInspector(tui as never, theme as never, paths, run.id, () => {});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(inspector.render(100).join("\n")).toContain("candidate plan");
		inspector.handleInput("\r");
		expect(inspector.render(100).join("\n")).toContain("checking evidence");
		inspector.dispose();
	});

	it("pauses, resumes, inspects, and deletes a task as distinct operations", async () => {
		const { paths, run, child } = await fixture();
		const pid = child.pid!;

		const paused = await pauseBackgroundEvolution(paths, run.id);
		expect(paused.status).toBe("paused");
		expect(paused.pausedFrom).toBe("queued");
		await waitFor(async () => (await processState(pid)) === "T");
		expect((await inspectBackgroundEvolutions(paths))[0]?.status).toBe("paused");

		const resumed = await resumeBackgroundEvolution(paths, run.id);
		expect(resumed.status).toBe("queued");
		await waitFor(async () => (await processState(pid)) !== "T");
		expect((await readEvolutionRun(paths, run.id)).status).toBe("queued");

		await removeBackgroundEvolution(paths, run.id);
		await expect(stat(evolutionRunDirectory(paths, run.id))).rejects.toThrow();
		expect(formatEvolutionRuns(await inspectBackgroundEvolutions(paths))).toBe("No evolution runs");
	});
});
