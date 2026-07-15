import { spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { access, appendFile, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvoPaths } from "../paths.ts";
import { loadProposal } from "../proposal.ts";
import { createPiModelRunner } from "../reflect/model-runner.ts";
import type { EvolutionRun, EvolutionRunActiveStatus } from "../types.ts";
import { runEvolutionCycle } from "./cycle.ts";
import {
	createEvolutionRun,
	deleteEvolutionRun,
	evolutionRunDirectory,
	listEvolutionRuns,
	readEvolutionRun,
	updateEvolutionRun,
} from "./run.ts";

const ACTIVE_STATUSES = new Set<EvolutionRun["status"]>([
	"queued",
	"researching",
	"planned",
	"building",
	"validating",
	"replaying",
	"evaluating",
]);
const TERMINAL_STATUSES = new Set<EvolutionRun["status"]>(["completed", "failed", "cancelled"]);

function workerEntrypoint(): string {
	return fileURLToPath(new URL("../../dist/bin.js", import.meta.url));
}

async function processMatchesRun(pid: number, runId: string): Promise<boolean> {
	try {
		process.kill(pid, 0);
		try {
			const command = (await readFile(`/proc/${pid}/cmdline`, "utf8")).replaceAll("\0", " ");
			return command.includes("__worker") && command.includes(runId);
		} catch {
			return true;
		}
	} catch {
		return false;
	}
}

export async function startBackgroundEvolution(options: {
	paths: EvoPaths;
	cwd: string;
	request?: string;
}): Promise<EvolutionRun> {
	// Single-writer semantics: a second trigger fails fast instead of queueing
	// behind the evolution-cycle lock for up to a day.
	const existing = await inspectBackgroundEvolutions(options.paths);
	const active = existing.find((run) => ACTIVE_STATUSES.has(run.status) || run.status === "paused");
	if (active) {
		throw new Error(
			`Evolution run ${active.id} is already ${active.status}; wait for it or remove it before starting another`,
		);
	}
	const run = await createEvolutionRun({
		paths: options.paths,
		trigger: options.request ? "request" : "scheduled",
		...(options.request ? { request: options.request } : {}),
		evidenceDigest: "pending",
		status: "queued",
	});
	const entrypoint = workerEntrypoint();
	const logFile = join(evolutionRunDirectory(options.paths, run.id), "worker.log");
	try {
		await access(entrypoint);
		const log = await open(logFile, "a", 0o600);
		try {
			const child = spawn(process.execPath, [entrypoint, "__worker", options.paths.root, run.id, options.cwd], {
				cwd: options.cwd,
				detached: true,
				stdio: ["ignore", log.fd, log.fd],
			});
			if (!child.pid) throw new Error("Background worker did not start");
			child.unref();
			return await updateEvolutionRun(options.paths, run.id, {
				workerPid: child.pid,
				workerStartedAt: new Date().toISOString(),
				logFile,
			});
		} finally {
			await log.close();
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await updateEvolutionRun(options.paths, run.id, { status: "failed", error: message });
		throw error;
	}
}

async function appendWorkerProgress(paths: EvoPaths, runId: string, event: Record<string, unknown>): Promise<void> {
	await appendFile(
		join(evolutionRunDirectory(paths, runId), "progress.jsonl"),
		`${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`,
		"utf8",
	);
}

export async function runEvolutionWorker(options: { paths: EvoPaths; runId: string; cwd: string }): Promise<void> {
	const controller = new AbortController();
	let transcript: WriteStream | undefined;
	const abort = () => controller.abort(new Error("Evolution worker terminated"));
	process.once("SIGTERM", abort);
	process.once("SIGINT", abort);
	try {
		const run = await readEvolutionRun(options.paths, options.runId);
		await updateEvolutionRun(options.paths, run.id, {
			workerPid: process.pid,
			workerStartedAt: run.workerStartedAt ?? new Date().toISOString(),
		});
		transcript = createWriteStream(join(evolutionRunDirectory(options.paths, run.id), "transcript.jsonl"), {
			flags: "a",
			mode: 0o600,
		});
		const baseRunner = createPiModelRunner();
		const runner = {
			run: async (request: Parameters<typeof baseRunner.run>[0]) => {
				const phase = (await readEvolutionRun(options.paths, options.runId)).status;
				await appendWorkerProgress(options.paths, options.runId, {
					type: "model-start",
					phase,
					model: request.model,
					thinkingLevel: request.thinkingLevel,
				});
				try {
					const result = await baseRunner.run({
						...request,
						onStreamEvent: (event) => {
							request.onStreamEvent?.(event);
							transcript?.write(`${JSON.stringify({ timestamp: new Date().toISOString(), phase, ...event })}\n`);
						},
					});
					await appendWorkerProgress(options.paths, options.runId, {
						type: "model-complete",
						phase,
						model: `${result.model.provider}/${result.model.id}`,
						tokens: result.stats.tokens,
						outputPreview: result.text.slice(0, 1_000),
					});
					return result;
				} catch (error) {
					await appendWorkerProgress(options.paths, options.runId, {
						type: "model-error",
						phase,
						error: error instanceof Error ? error.message : String(error),
					});
					throw error;
				}
			},
		};
		await runEvolutionCycle({
			paths: options.paths,
			runner,
			cwd: options.cwd,
			...(run.request ? { request: run.request } : {}),
			trigger: run.trigger,
			runId: run.id,
			signal: controller.signal,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await updateEvolutionRun(options.paths, options.runId, {
			status: controller.signal.aborted ? "cancelled" : "failed",
			error: message,
		}).catch(() => undefined);
		throw error;
	} finally {
		process.off("SIGTERM", abort);
		process.off("SIGINT", abort);
		if (transcript) await new Promise<void>((resolve) => transcript?.end(resolve));
		await updateEvolutionRun(options.paths, options.runId, { workerPid: undefined }).catch(() => undefined);
	}
}

export async function pauseBackgroundEvolution(paths: EvoPaths, runId: string): Promise<EvolutionRun> {
	const run = await readEvolutionRun(paths, runId);
	if (!ACTIVE_STATUSES.has(run.status)) throw new Error(`Evolution run ${runId} is not active`);
	if (!run.workerPid || !(await processMatchesRun(run.workerPid, run.id))) {
		return updateEvolutionRun(paths, run.id, { status: "failed", error: "Background worker is not running" });
	}
	process.kill(run.workerPid, "SIGSTOP");
	return updateEvolutionRun(paths, run.id, {
		status: "paused",
		pausedAt: new Date().toISOString(),
		pausedFrom: run.status as EvolutionRunActiveStatus,
	});
}

export async function resumeBackgroundEvolution(paths: EvoPaths, runId: string): Promise<EvolutionRun> {
	const run = await readEvolutionRun(paths, runId);
	if (run.status !== "paused") throw new Error(`Evolution run ${runId} is not paused`);
	if (!run.workerPid || !(await processMatchesRun(run.workerPid, run.id))) {
		return updateEvolutionRun(paths, run.id, { status: "failed", error: "Paused worker is not running" });
	}
	const resumed = await updateEvolutionRun(paths, run.id, {
		status: run.pausedFrom ?? "researching",
		pausedAt: undefined,
		pausedFrom: undefined,
	});
	process.kill(run.workerPid, "SIGCONT");
	return resumed;
}

export async function removeBackgroundEvolution(paths: EvoPaths, runId: string): Promise<void> {
	const run = await readEvolutionRun(paths, runId);
	if (run.workerPid && (await processMatchesRun(run.workerPid, run.id))) process.kill(run.workerPid, "SIGKILL");
	await deleteEvolutionRun(paths, run.id);
}

export async function inspectBackgroundEvolutions(paths: EvoPaths): Promise<EvolutionRun[]> {
	const runs = await listEvolutionRuns(paths);
	for (const run of runs) {
		if ((ACTIVE_STATUSES.has(run.status) || run.status === "paused") && run.workerPid) {
			if (!(await processMatchesRun(run.workerPid, run.id))) {
				// A release intent means the crash happened after the release policy may
				// already have taken effect; reconcile from the proposal instead of
				// declaring a possibly-successful run failed.
				const reconciled = await reconcileRunFromReleaseIntent(paths, run);
				if (reconciled) {
					await updateEvolutionRun(paths, run.id, { workerPid: undefined });
					continue;
				}
				await updateEvolutionRun(paths, run.id, {
					status: "failed",
					error: "Background worker exited without completing the run",
					workerPid: undefined,
				});
			}
		}
	}
	return listEvolutionRuns(paths);
}

async function reconcileRunFromReleaseIntent(paths: EvoPaths, run: EvolutionRun): Promise<boolean> {
	if (!run.proposalId) return false;
	try {
		await access(join(evolutionRunDirectory(paths, run.id), "release-intent.json"));
	} catch {
		return false;
	}
	const proposal = await loadProposal(paths, run.proposalId).catch(() => undefined);
	if (!proposal) return false;
	const status =
		proposal.status === "trialing"
			? ("trialing" as const)
			: proposal.status === "deferred"
				? ("awaiting-decision" as const)
				: proposal.status === "approved" ||
						proposal.status === "rejected" ||
						proposal.status === "kept" ||
						proposal.status === "rolled-back"
					? ("completed" as const)
					: proposal.status === "pending"
						? ("awaiting-decision" as const)
						: undefined;
	if (!status || status === run.status) return status !== undefined;
	await updateEvolutionRun(paths, run.id, { status });
	return true;
}

async function readRunText(path: string, maxCharacters = 20_000): Promise<string | undefined> {
	try {
		const text = await readFile(path, "utf8");
		return text.length > maxCharacters ? `${text.slice(-maxCharacters)}\n\n[earlier content omitted]` : text;
	} catch {
		return undefined;
	}
}

function progressMarkdown(text: string | undefined): string[] {
	if (!text?.trim()) return ["No completed progress event yet. A model request may currently be in flight."];
	return text
		.trim()
		.split("\n")
		.slice(-20)
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.map((event) => {
			const tokens = event.tokens as { input?: number; output?: number; cacheRead?: number } | undefined;
			const usage = tokens
				? ` — tokens in=${tokens.input ?? 0} out=${tokens.output ?? 0} cache=${tokens.cacheRead ?? 0}`
				: "";
			const error = event.error ? ` — ${String(event.error)}` : "";
			return `- ${event.timestamp} **${event.type}** (${event.phase ?? "unknown"}) ${event.model ?? ""}${usage}${error}`;
		});
}

export async function renderEvolutionRunInspection(
	paths: EvoPaths,
	runs: readonly EvolutionRun[],
	selectedId?: string,
): Promise<{ summary: string; markdown: string }> {
	const selected = selectedId
		? runs.filter((run) => run.id === selectedId)
		: runs.filter((run) => !TERMINAL_STATUSES.has(run.status));
	const activeCount = runs.filter((run) => !TERMINAL_STATUSES.has(run.status)).length;
	const summary = selectedId
		? selected[0]
			? `${selected[0].id}  ${selected[0].status}`
			: `Evolution run not found: ${selectedId}`
		: `Evo tasks: ${activeCount} active, ${runs.length} total`;
	const sections = [
		"# Evolution tasks",
		"",
		...runs.map((run) => `- \`${run.id}\` — **${run.status}** — ${run.request ?? "scheduled evolution"}`),
	];
	for (const run of selected) {
		const directory = evolutionRunDirectory(paths, run.id);
		const [progress, workerLog, plan, experiment, evaluation] = await Promise.all([
			readRunText(join(directory, "progress.jsonl")),
			readRunText(join(directory, "worker.log"), 8_000),
			readRunText(join(directory, "plan.md")),
			readRunText(join(directory, "experiment.json")),
			readRunText(join(directory, "evaluation.md")),
		]);
		sections.push(
			"",
			`## ${run.id}`,
			"",
			`- **status:** ${run.status}`,
			`- **started:** ${run.startedAt}`,
			`- **updated:** ${run.updatedAt}`,
			...(run.request ? [`- **request:** ${run.request}`] : []),
			...(run.workerPid ? [`- **worker PID:** ${run.workerPid}`] : []),
			...(run.proposalId ? [`- **proposal:** ${run.proposalId}`] : []),
			...(run.error ? [`- **error:** ${run.error}`] : []),
			"",
			"### Live progress",
			"",
			...progressMarkdown(progress),
			...(plan ? ["", "### Research plan", "", plan] : []),
			...(experiment ? ["", "### Frozen experiment", "", "```json", experiment, "```"] : []),
			...(evaluation ? ["", "### Evaluation", "", evaluation] : []),
			...(workerLog?.trim() ? ["", "### Worker log", "", "```text", workerLog, "```"] : []),
		);
	}
	if (!selectedId && selected.length === 0) {
		sections.push("", "No task is currently active. Pass a run ID to inspect its artifacts.");
	}
	return { summary, markdown: sections.join("\n") };
}

export function formatEvolutionRuns(runs: readonly EvolutionRun[], selectedId?: string): string {
	const selected = selectedId ? runs.filter((run) => run.id === selectedId) : runs;
	if (selected.length === 0) return selectedId ? `Evolution run not found: ${selectedId}` : "No evolution runs";
	return selected
		.map((run) => {
			const details = [
				`${run.id}  ${run.status}`,
				`started: ${run.startedAt}`,
				...(run.request ? [`request: ${run.request}`] : []),
				...(run.workerPid ? [`pid: ${run.workerPid}`] : []),
				...(run.logFile ? [`log: ${run.logFile}`] : []),
				...(run.proposalId ? [`proposal: ${run.proposalId}`] : []),
				...(run.error ? [`error: ${run.error}`] : []),
			];
			return details.join("\n");
		})
		.join("\n\n");
}
