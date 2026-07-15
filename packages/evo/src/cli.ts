import { createInterface } from "node:readline/promises";
import type { ExtensionCommandContext, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { loadCompiledBundle } from "./bundle/compile.ts";
import { buildTrialComparison, renderTrialComparisonMarkdown, type TrialComparison } from "./comparison.ts";
import { canUseEvoComponentSandbox } from "./components/process-runtime.ts";
import {
	formatEvolutionRuns,
	inspectBackgroundEvolutions,
	pauseBackgroundEvolution,
	removeBackgroundEvolution,
	resumeBackgroundEvolution,
	startBackgroundEvolution,
} from "./evolve/background.ts";
import { readEvolutionWorkflow, resetEvolutionWorkflow } from "./evolve/config.ts";
import { runEvolutionCycle } from "./evolve/cycle.ts";
import { EvolutionProcessInspector } from "./evolve/inspect-ui.ts";
import { changesComponentSelection } from "./evolve/release.ts";
import { retryEvolutionFromValidation } from "./evolve/retry.ts";
import { listEvolutionRuns, readEvolutionRun, updateEvolutionRun } from "./evolve/run.ts";
import { readBundlePreferenceMemory } from "./memory/preferences.ts";
import { type EvoPaths, getEvoPaths } from "./paths.ts";
import { proposalApproval } from "./proposal.ts";
import { readEvaluationArtifact } from "./proposal-artifacts.ts";
import { createPiModelRunner, type ModelRunner } from "./reflect/model-runner.ts";
import {
	askProposalQuestion,
	recordPermitDefer,
	recordPermitReopen,
	reviseProposalFromInstruction,
} from "./reflect/permit.ts";
import { runReport } from "./reflect/reflector.ts";
import { runRetrospective } from "./reflect/retrospective.ts";
import {
	type EvoScheduleConfig,
	type EvoScheduleStatus,
	getScheduleStatus,
	parseScheduleCadence,
	readScheduleConfig,
	runConfiguredImprove,
	type ScheduledImproveResult,
	writeScheduleConfig,
} from "./scheduler.ts";
import { EvoService } from "./service.ts";
import type { EvoStatus, Proposal, ProposalArtifactKind } from "./types.ts";

const SUBCOMMANDS = [
	"help",
	"init",
	"status",
	"report",
	"go",
	"inspect",
	"pause",
	"resume",
	"delete",
	"retry",
	"scheduled-improve",
	"schedule",
	"workflow",
	"list",
	"show",
	"note",
	"request",
	"preference",
	"preferences",
	"forget",
	"resolve",
	"gc",
	"permit",
	"reject",
	"rollback",
	"keep",
	"retrospect",
	"pause",
	"resume",
] as const;

const QUICK_APPROVE_SHORTCUT = "ctrl+alt+e" as const;
const DAY_MS = 24 * 60 * 60 * 1000;
const SCHEDULE_USAGE = "/evo schedule [daily | 3d | weekly | every <n>d | manual]";

const EVO_HELP = `Usage: /evo <command>

  help                         Show this help
  init                         Initialize and migrate Pi data into a bundle
  status                       Show registry and trial status
  report                       Generate a read-only evidence report
  go [request]                 Start a background research-plan/build/evaluate task
  inspect [run-id]             Inspect background and completed tasks
  pause <run-id>               Pause a background task
  resume <run-id>              Resume a paused task
  delete <run-id>              Stop and permanently delete a task
  retry <run-id>               Reuse a built component and continue from validation
  scheduled-improve            Run one guarded background evolution attempt
  schedule [cadence]           Show or set the evolution cadence (daily, 3d, weekly, manual)
  workflow [reset]             Show or reset the user-editable evolution workflow
  list                         List proposals
  show <proposal-id>           Show a proposal card
  note <text>                  Record an explicit note
  request <text>               Prioritize a research/evolution direction
  preference <text>            Record an explicit durable preference
  preferences                  Show active stable preferences
  forget <preference-id>        Request removal of an active preference
  resolve <inbox-file> [why]    Mark an externally completed input fulfilled
  gc [--dry-run]               Collect terminal inbox payloads
  permit <proposal-id>         Review and approve a proposal
  reject <proposal-id> <why>   Reject a pending proposal
  rollback [digest] [why]      Roll back the active trial or stable bundle
  keep [why]                   Run retrospective, then keep the active trial
  retrospect                   Run and show the active-trial retrospective`;

const EVO_CLI_HELP = EVO_HELP.replaceAll("/evo", "evo-pi")
	.replace("note <text>", "note <session-id> <text>")
	.replace("request <text>", "request <session-id> <text>")
	.replace("preference <text>", "preference <session-id> <text>")
	.replace("forget <preference-id>", "forget <session-id> <preference-id>");

interface EvoCommandDependencies {
	paths: EvoPaths;
	service: EvoService;
	runner: ModelRunner;
	cwd?: string;
	agentDir?: string;
	model?: string;
}

export interface EvoCommandExtensionOptions {
	root?: string;
	paths?: EvoPaths;
	service?: EvoService;
	runner?: ModelRunner;
	cwd?: string;
	agentDir?: string;
	model?: string;
}

export interface EvoCliIO {
	interactive: boolean;
	write(message: string): void;
	writeError(message: string): void;
	question(prompt: string): Promise<string>;
}

export interface RunEvoCliOptions extends EvoCommandExtensionOptions {
	io?: EvoCliIO;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parseSubcommand(args: string): { command: string; rest: string } {
	const trimmed = args.trim();
	if (!trimmed) return { command: "help", rest: "" };
	const separator = trimmed.search(/\s/);
	if (separator === -1) return { command: trimmed.toLowerCase(), rest: "" };
	return {
		command: trimmed.slice(0, separator).toLowerCase(),
		rest: trimmed.slice(separator).trim(),
	};
}

function splitFirst(value: string): { first: string; rest: string } {
	const trimmed = value.trim();
	const separator = trimmed.search(/\s/);
	if (separator === -1) return { first: trimmed, rest: "" };
	return { first: trimmed.slice(0, separator), rest: trimmed.slice(separator).trim() };
}

function requireValue(value: string, usage: string): string {
	if (!value.trim()) throw new Error(`Usage: ${usage}`);
	return value.trim();
}

function parseRetryArgs(value: string, usage: string): string {
	const { first: id, rest } = splitFirst(value);
	requireValue(id, usage);
	if (rest && rest !== "--from validating") throw new Error(`Usage: ${usage}`);
	return id;
}

function formatStatus(status: EvoStatus): string {
	return [
		`initialized: ${String(status.initialized)}`,
		`stable: ${status.stableDigest ?? "none"}`,
		`trial: ${status.trial ? `${status.trial.proposalId} (${status.trial.digest})` : "none"}`,
		`pending proposals: ${status.pendingProposals}`,
		`deferred proposals: ${status.deferredProposals}`,
		`paused: ${String(status.paused)}`,
	].join("\n");
}

function formatProposalSummary(proposal: Proposal): string {
	return `${proposal.id}  r${proposal.revision}  ${proposal.status}  ${proposal.tier}/${proposal.kind}  ${proposal.motivation}`;
}

async function formatActivePreferences(dependencies: EvoCommandDependencies): Promise<string> {
	const digest = await dependencies.service.registry.readStableDigest();
	if (!digest) return "No active Evo-Pi preferences";
	const memory = await readBundlePreferenceMemory(await loadCompiledBundle(dependencies.paths, digest));
	if (memory.preferences.length === 0) return "No active Evo-Pi preferences";
	return [
		"# Active Evo-Pi preferences",
		"",
		...memory.preferences.map((preference) => `- ${preference.id}: ${preference.instruction}`),
	].join("\n");
}

function evolutionRunStatusText(status: string): string {
	return (
		{
			queued: "等待执行",
			researching: "研究中",
			planned: "计划已冻结",
			building: "构建候选",
			validating: "确定性验证",
			replaying: "历史回放",
			evaluating: "独立评估",
			"awaiting-evidence": "等待实验数据",
			"awaiting-canary-approval": "等待 Canary 确认",
			trialing: "Canary 运行中",
			"awaiting-decision": "等待最终决定",
			paused: "已暂停",
		}[status] ?? status
	);
}

function compactStatusText(value: string, maxLength = 48): string {
	const compact = value.replace(/\s+/g, " ").trim();
	if (compact.length <= maxLength) return compact;
	return `${compact.slice(0, Math.max(0, maxLength - 3))}...`;
}

async function findPendingT0Proposal(dependencies: { service: EvoService }): Promise<Proposal | undefined> {
	return (await dependencies.service.listProposals()).find(
		(proposal) => proposal.status === "pending" && proposal.kind === "data" && proposal.tier === "T0",
	);
}

function describeScheduleCadence(config: EvoScheduleConfig): string {
	if (config.mode === "manual") return "manual (evolution only runs through /evo go)";
	if (config.everyDays === 1) return "auto (reflect once a day)";
	return `auto (reflect once every ${config.everyDays} days)`;
}

function formatScheduleStatus(status: EvoScheduleStatus): string {
	return [
		`cadence: ${describeScheduleCadence(status.config)}`,
		`quiet hours: ${status.config.quietHours ? `${status.config.quietHours.start}-${status.config.quietHours.end}` : "any time"}`,
		`last background run: ${status.lastCompletedAt ?? "never"}`,
		`next eligible day: ${status.config.mode === "manual" ? "n/a" : (status.nextEligibleDay ?? "today")}`,
		`runs today: ${status.runsToday}/${status.config.dailyRunLimit}`,
		`trial comparison after: ${status.config.trialDueAfterDays} days or ${status.config.trialDueAfterSessions} sessions`,
	].join("\n");
}

function describeImproveSkip(result: Extract<ScheduledImproveResult<unknown>, { status: "skipped" }>): string {
	const detail =
		result.reason === "interval-not-elapsed" && result.nextEligibleDay
			? ` (next eligible ${result.nextEligibleDay})`
			: "";
	return `Scheduled improve skipped: ${result.reason}${detail}`;
}

const SCHEDULE_CADENCE_CHOICES: ReadonlyArray<{
	label: string;
	input: { mode: "auto" | "manual"; everyDays?: number };
}> = [
	{ label: "Every day", input: { mode: "auto", everyDays: 1 } },
	{ label: "Every 3 days", input: { mode: "auto", everyDays: 3 } },
	{ label: "Every week", input: { mode: "auto", everyDays: 7 } },
	{ label: "Manual only", input: { mode: "manual" } },
];
async function readProposalArtifact(
	paths: EvoPaths,
	proposal: Proposal,
	kind: ProposalArtifactKind,
): Promise<string | undefined> {
	const reference = proposal.artifacts[kind];
	if (!reference) return undefined;
	return (
		await readEvaluationArtifact({
			paths,
			proposalId: proposal.id,
			revision: proposal.revision,
			diffDigest: proposal.diffDigest,
			kind,
			reference,
		})
	).trim();
}

async function formatProposalCard(paths: EvoPaths, proposal: Proposal): Promise<string> {
	const evidence = proposal.evidence.length
		? proposal.evidence
				.map(
					(reference) =>
						`- ${reference.sessionId}:${reference.sequence}${reference.quote ? ` — ${reference.quote}` : ""}`,
				)
				.join("\n")
		: "- none";
	const review = await readProposalArtifact(paths, proposal, "review");
	const replay = await readProposalArtifact(paths, proposal, "replay");
	const validation = await readProposalArtifact(paths, proposal, "validation");
	const comparisonJson = await readProposalArtifact(paths, proposal, "comparison");
	const comparison = comparisonJson
		? renderTrialComparisonMarkdown(JSON.parse(comparisonJson) as TrialComparison)
		: undefined;
	const retrospective = await readProposalArtifact(paths, proposal, "retrospective");
	return [
		`# Evo proposal ${proposal.id}`,
		"",
		`Status: ${proposal.status}`,
		`Revision: ${proposal.revision}`,
		`Tier: ${proposal.tier}`,
		`Kind: ${proposal.kind}`,
		`Parent bundle: ${proposal.parentBundleDigest}`,
		`Final diff digest: ${proposal.diffDigest}`,
		...(proposal.codeWorkspace
			? [
					`Approval context digest: ${proposal.approvalDigest}`,
					`Repository root: ${proposal.codeWorkspace.repositoryRoot}`,
					`Repository identity: ${proposal.codeWorkspace.repositoryId}`,
					`Base commit: ${proposal.codeWorkspace.baseCommit}`,
					`Worktree: ${proposal.codeWorkspace.worktreePath}`,
					`Branch: ${proposal.codeWorkspace.branch}`,
				]
			: []),
		"",
		"## Motivation",
		proposal.motivation,
		"",
		"## Evidence",
		evidence,
		"",
		"## Diff",
		"```diff",
		proposal.diff,
		"```",
		"",
		"## Expected effect",
		proposal.expectedEffect,
		"",
		"## Risk",
		proposal.risk,
		"",
		"## Verification plan",
		proposal.verifyPlan,
		"",
		"## Trial plan",
		proposal.trialPlan,
		...(validation ? ["", "## L1 validation", validation] : []),
		...(review ? ["", "## Critic review", review] : []),
		...(replay ? ["", "## Counterfactual replay", replay] : []),
		...(comparison ? ["", comparison] : []),
		...(retrospective ? ["", "## Retrospective", retrospective] : []),
	].join("\n");
}

function createDependencies(options: EvoCommandExtensionOptions): EvoCommandDependencies {
	const paths = options.service?.paths ?? options.paths ?? getEvoPaths(options.root);
	return {
		paths,
		service: options.service ?? new EvoService(paths),
		runner: options.runner ?? createPiModelRunner(),
		cwd: options.cwd,
		agentDir: options.agentDir,
		model: options.model,
	};
}

function modelOptions(dependencies: EvoCommandDependencies, signal?: AbortSignal) {
	return {
		paths: dependencies.paths,
		runner: dependencies.runner,
		...(dependencies.cwd ? { cwd: dependencies.cwd } : {}),
		...(dependencies.agentDir ? { agentDir: dependencies.agentDir } : {}),
		...(dependencies.model ? { model: dependencies.model } : {}),
		...(signal ? { signal } : {}),
	};
}

export async function refreshEvoStatusIndicator(
	dependencies: { service: EvoService; paths: EvoPaths },
	ctx: ExtensionContext,
	now: () => Date = () => new Date(),
	includeTrialComparison = true,
): Promise<void> {
	const status = await dependencies.service.status();
	const parts: string[] = [];
	const runs = (await listEvolutionRuns(dependencies.paths)).filter(
		(run) => !["completed", "failed", "cancelled"].includes(run.status),
	);
	const awaitingCanary = runs.filter((run) => run.status === "awaiting-canary-approval");
	if (awaitingCanary.length > 0) {
		parts.push(`${awaitingCanary.length} waiting Canary approval [/evo inspect]`);
	} else if (runs.length === 1) {
		const run = runs[0];
		if (run) {
			const action =
				run.status === "awaiting-evidence" && run.proposalId
					? ` [/evo permit ${run.proposalId}]`
					: run.status === "awaiting-decision" && run.proposalId
						? ` [/evo show ${run.proposalId}]`
						: "";
			parts.push(`${run.id.slice(-8)} ${evolutionRunStatusText(run.status)}${action}`);
		}
	} else if (runs.length > 1) parts.push(`${runs.length} active tasks [/evo inspect]`);
	if (status.pendingProposals > 0) {
		const quick = await findPendingT0Proposal(dependencies);
		parts.push(
			quick
				? `T0 ${compactStatusText(quick.motivation)} [Ctrl+Alt+E apply; /evo show ${quick.id}]`
				: `${status.pendingProposals} pending`,
		);
	}
	if (status.trial) {
		const proposal = await dependencies.service.getProposal(status.trial.proposalId);
		if (proposal.artifacts.retrospective) {
			parts.push(`trial ${status.trial.proposalId} comparison ready [/evo show ${status.trial.proposalId}]`);
		} else if (!includeTrialComparison) parts.push(`trial ${status.trial.proposalId} active`);
		else {
			const schedule = await readScheduleConfig(dependencies.paths);
			const comparison = await buildTrialComparison(dependencies.paths, proposal, status.trial);
			const dueAt = Date.parse(status.trial.startedAt) + schedule.trialDueAfterDays * DAY_MS;
			if (
				(Number.isFinite(dueAt) && now().getTime() >= dueAt) ||
				comparison.after.totals.sessions >= schedule.trialDueAfterSessions
			) {
				parts.push(`trial ${status.trial.proposalId} due [automatic comparison pending]`);
			}
		}
	}
	ctx.ui.setStatus("evo", parts.length > 0 ? `evo: ${parts.join("; ")}` : undefined);
}

function sendCustomCard(
	pi: Parameters<ExtensionFactory>[0],
	customType: string,
	content: string,
	details: Record<string, unknown>,
): void {
	pi.sendMessage(
		{
			customType,
			content,
			display: true,
			details,
		},
		{ triggerTurn: false },
	);
}

async function showProposal(
	pi: Parameters<ExtensionFactory>[0],
	dependencies: EvoCommandDependencies,
	proposal: Proposal,
): Promise<void> {
	sendCustomCard(pi, "evo.proposal", await formatProposalCard(dependencies.paths, proposal), {
		proposalId: proposal.id,
		status: proposal.status,
		tier: proposal.tier,
		approvalDigest: proposal.approvalDigest,
	});
}

async function confirmExtensionMutation(
	ctx: ExtensionCommandContext,
	title: string,
	message: string,
): Promise<boolean> {
	if (!ctx.hasUI) throw new Error("Changing Evo-Pi state requires an interactive UI");
	return ctx.ui.confirm(title, message);
}

async function confirmProposal(proposal: Proposal, ctx: ExtensionCommandContext): Promise<boolean> {
	if (!ctx.hasUI) throw new Error("Proposal approval requires an interactive UI");
	if (proposal.kind === "code" || proposal.tier === "T2") {
		const digest = proposal.kind === "code" ? proposal.approvalDigest : proposal.diffDigest;
		const label = proposal.kind === "code" ? "code approval context digest" : "final diff digest";
		const confirmed = await ctx.ui.input(`Approve ${proposal.id}`, `Type the ${label}: ${digest}`);
		if (confirmed?.trim() !== digest) {
			ctx.ui.notify("Approval digest did not match; proposal remains pending", "error");
			return false;
		}
		return true;
	}
	return ctx.ui.confirm(
		`Approve ${proposal.id}`,
		`${proposal.tier}/${proposal.kind}: ${proposal.motivation}\n\nApply final diff ${proposal.diffDigest}?`,
	);
}

async function runExtensionPermit(
	pi: Parameters<ExtensionFactory>[0],
	dependencies: EvoCommandDependencies,
	id: string,
	ctx: ExtensionCommandContext,
): Promise<Proposal | undefined> {
	if (!ctx.hasUI) throw new Error("Proposal approval requires an interactive UI");
	let proposal = await dependencies.service.getProposal(id);
	while (true) {
		await showProposal(pi, dependencies, proposal);
		const strictPermit = proposal.kind === "code" || proposal.tier === "T2";
		if (!strictPermit && proposal.tier === "T0" && proposal.status === "pending") {
			if (!(await confirmProposal(proposal, ctx))) return undefined;
			return dependencies.service.approve(id, proposalApproval(proposal));
		}

		const actions =
			proposal.status === "deferred"
				? ["Reopen", ...(!strictPermit && proposal.tier === "T0" ? [] : ["Ask why"]), "Reject", "Close"]
				: ["Ask why", ...(strictPermit ? ["Request revision"] : []), "Approve", "Reject", "Defer", "Close"];
		const action = await ctx.ui.select(`Permit ${proposal.id} r${proposal.revision}`, actions);
		if (!action || action === "Close") return undefined;
		const expected = proposalApproval(proposal);
		if (action === "Ask why") {
			const question = await ctx.ui.input(`Question ${proposal.id}`, "Ask why, or request evidence");
			if (!question?.trim()) continue;
			const answer = await askProposalQuestion({
				paths: dependencies.paths,
				runner: dependencies.runner,
				proposalId: proposal.id,
				expected,
				question,
				...(dependencies.cwd ? { cwd: dependencies.cwd } : {}),
				...(dependencies.agentDir ? { agentDir: dependencies.agentDir } : {}),
				...(dependencies.model ? { model: dependencies.model } : {}),
			});
			sendCustomCard(pi, "evo.permit-answer", answer.answerMarkdown, {
				proposalId: proposal.id,
				revision: proposal.revision,
			});
			proposal = await dependencies.service.getProposal(id);
			continue;
		}
		if (action === "Request revision") {
			const instruction = await ctx.ui.input(
				`Revise ${proposal.id}`,
				"Describe the exact constraints for the revised diff",
			);
			if (!instruction?.trim()) continue;
			proposal = await reviseProposalFromInstruction({
				paths: dependencies.paths,
				runner: dependencies.runner,
				proposalId: proposal.id,
				expected,
				instruction,
				...(dependencies.cwd ? { cwd: dependencies.cwd, repositoryCwd: dependencies.cwd } : {}),
				...(dependencies.agentDir ? { agentDir: dependencies.agentDir } : {}),
				...(dependencies.model ? { model: dependencies.model } : {}),
			});
			continue;
		}
		if (action === "Approve") {
			if (!(await confirmProposal(proposal, ctx))) return undefined;
			return dependencies.service.approve(id, expected);
		}
		if (action === "Reject") {
			const reason = await ctx.ui.input(`Reject ${proposal.id}`, "Reason for rejection");
			if (!reason?.trim()) continue;
			return dependencies.service.reject(id, reason);
		}
		if (action === "Defer") {
			const reason = await ctx.ui.input(`Defer ${proposal.id}`, "Reason for deferral");
			if (!reason?.trim()) continue;
			proposal = await dependencies.service.defer(id, reason);
			await recordPermitDefer({
				paths: dependencies.paths,
				proposalId: proposal.id,
				revision: proposal.revision,
				diffDigest: proposal.diffDigest,
				reason,
			});
			continue;
		}
		if (action === "Reopen") {
			proposal = await dependencies.service.reopen(id, "User reopened deferred proposal");
			await recordPermitReopen({
				paths: dependencies.paths,
				proposalId: proposal.id,
				revision: proposal.revision,
				diffDigest: proposal.diffDigest,
				reason: "User reopened deferred proposal",
			});
		}
	}
}

export async function approveCanaryRun(
	dependencies: { service: EvoService; paths: EvoPaths },
	runId: string,
): Promise<void> {
	const run = await readEvolutionRun(dependencies.paths, runId);
	if (run.status !== "awaiting-canary-approval" || !run.proposalId) {
		throw new Error(`Evolution task ${runId} is not awaiting Canary approval`);
	}
	const proposal = await dependencies.service.getProposal(run.proposalId);
	if (!changesComponentSelection(proposal) || !proposal.candidateDigest || !proposal.targetAbi) {
		throw new Error("The proposal does not replace a component");
	}
	if (
		run.canaryParentDigest !== proposal.parentBundleDigest ||
		run.canaryCandidateDigest !== proposal.candidateDigest ||
		run.canaryTargetAbi !== proposal.targetAbi
	) {
		throw new Error("Canary review metadata no longer matches the exact proposal");
	}
	const stable = await dependencies.service.registry.readStableDigest();
	if (!stable || stable !== proposal.parentBundleDigest) {
		throw new Error("Stable bundle changed; rebuild and review the Canary against the new baseline");
	}
	if (proposal.status === "trialing") {
		const trial = await dependencies.service.registry.readTrial();
		if (!trial || trial.proposalId !== proposal.id || trial.digest !== proposal.candidateDigest) {
			throw new Error("Component proposal and active Canary state disagree");
		}
		await updateEvolutionRun(dependencies.paths, run.id, {
			status: "trialing",
			canaryApprovalDigest: proposal.approvalDigest,
			canaryStableDigest: stable,
		});
		return;
	}
	if (proposal.status !== "pending") throw new Error(`Component proposal is ${proposal.status}`);
	const approved = await dependencies.service.approve(proposal.id, proposalApproval(proposal));
	await updateEvolutionRun(dependencies.paths, run.id, {
		status: "trialing",
		canaryApprovedAt: new Date().toISOString(),
		canaryApprovalDigest: approved.approvalDigest,
		canaryStableDigest: stable,
	});
}

async function openEvolutionInspector(
	dependencies: EvoCommandDependencies,
	ctx: ExtensionContext,
	initialRunId?: string,
): Promise<void> {
	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) =>
			new EvolutionProcessInspector(
				tui,
				theme,
				dependencies.paths,
				initialRunId,
				() => done(undefined),
				(runId) => approveCanaryRun(dependencies, runId),
			),
	);
}

async function dispatchExtensionCommand(
	pi: Parameters<ExtensionFactory>[0],
	dependencies: EvoCommandDependencies,
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const { command, rest } = parseSubcommand(args);
	await ctx.waitForIdle();

	switch (command) {
		case "help":
			sendCustomCard(pi, "evo.help", EVO_HELP, { command: "help" });
			return;
		case "init": {
			const bundle = await dependencies.service.init(pi.getActiveTools());
			ctx.ui.notify(`Evo-Pi initialized at ${bundle.digest}`, "info");
			return;
		}
		case "status":
			ctx.ui.notify(formatStatus(await dependencies.service.status()), "info");
			return;
		case "report": {
			const report = await runReport(modelOptions(dependencies));
			sendCustomCard(pi, "evo.report", report.observationsMarkdown, { file: report.file });
			return;
		}
		case "go": {
			const run = await startBackgroundEvolution({
				paths: dependencies.paths,
				cwd: dependencies.cwd ?? ctx.cwd,
				...(rest ? { request: rest } : {}),
			});
			ctx.ui.notify(`Evolution task ${run.id} started in the background`, "info");
			return;
		}
		case "inspect": {
			const runs = await inspectBackgroundEvolutions(dependencies.paths);
			if (ctx.mode !== "tui") {
				ctx.ui.notify(formatEvolutionRuns(runs, rest || undefined), "info");
				return;
			}
			await openEvolutionInspector(dependencies, ctx, rest || undefined);
			return;
		}
		case "pause": {
			const id = requireValue(rest, "/evo pause <run-id>");
			await pauseBackgroundEvolution(dependencies.paths, id);
			ctx.ui.notify(`Evolution task ${id} paused`, "info");
			return;
		}
		case "resume": {
			const id = requireValue(rest, "/evo resume <run-id>");
			await resumeBackgroundEvolution(dependencies.paths, id);
			ctx.ui.notify(`Evolution task ${id} resumed`, "info");
			return;
		}
		case "retry": {
			const id = parseRetryArgs(rest, "/evo retry <run-id> [--from validating]");
			const sandboxAvailable = await canUseEvoComponentSandbox();
			if (!sandboxAvailable && !ctx.hasUI) {
				throw new Error(
					"Component sandbox is unavailable and one-time direct execution requires an interactive UI",
				);
			}
			const allowDirect =
				!sandboxAvailable &&
				(await ctx.ui.confirm(
					"One-time component permission",
					`The OS sandbox is unavailable. Allow the built component from ${id} to run directly once for validation with your user permissions? This grant is not saved and does not activate the Canary.`,
				));
			if (!sandboxAvailable && !allowDirect) {
				ctx.ui.notify("Retry cancelled; no component permission was granted", "info");
				return;
			}
			const retried = await retryEvolutionFromValidation({
				paths: dependencies.paths,
				sourceRunId: id,
				cwd: dependencies.cwd ?? ctx.cwd,
				...(allowDirect ? { sandbox: false } : {}),
			});
			ctx.ui.notify(
				retried.status === "awaiting-canary-approval"
					? `Evolution task ${retried.runId} is ready for Canary review [/evo inspect]`
					: `Evolution task ${retried.runId} is waiting for its frozen evidence strategy`,
				"info",
			);
			return;
		}
		case "delete": {
			const id = requireValue(rest, "/evo delete <run-id>");
			if (!(await confirmExtensionMutation(ctx, "Delete evolution task", `Permanently delete ${id}?`))) {
				ctx.ui.notify("Delete cancelled", "info");
				return;
			}
			await removeBackgroundEvolution(dependencies.paths, id);
			ctx.ui.notify(`Evolution task ${id} deleted`, "info");
			return;
		}
		case "scheduled-improve": {
			const scheduled = await runConfiguredImprove({
				paths: dependencies.paths,
				improve: (signal) =>
					runEvolutionCycle({
						paths: dependencies.paths,
						service: dependencies.service,
						runner: dependencies.runner,
						cwd: dependencies.cwd,
						agentDir: dependencies.agentDir,
						trigger: "scheduled",
						signal,
					}),
			});
			if (scheduled.status === "skipped") {
				ctx.ui.notify(describeImproveSkip(scheduled), "info");
				return;
			}
			for (const proposal of scheduled.value.proposals) await showProposal(pi, dependencies, proposal);
			ctx.ui.notify(`Evolution run ${scheduled.value.run.id} completed`, "info");
			return;
		}
		case "schedule": {
			if (rest) {
				const cadence = parseScheduleCadence(rest);
				if (!cadence) throw new Error(`Usage: ${SCHEDULE_USAGE}`);
				const updated = await writeScheduleConfig(dependencies.paths, cadence);
				ctx.ui.notify(`Evo-Pi schedule updated — ${describeScheduleCadence(updated)}`, "info");
				return;
			}
			const status = await getScheduleStatus(dependencies.paths);
			if (!ctx.hasUI) {
				ctx.ui.notify(formatScheduleStatus(status), "info");
				return;
			}
			const choice = await ctx.ui.select(
				`Evo-Pi schedule — ${describeScheduleCadence(status.config)}`,
				SCHEDULE_CADENCE_CHOICES.map((entry) => entry.label).concat("Keep current"),
			);
			const selected = SCHEDULE_CADENCE_CHOICES.find((entry) => entry.label === choice);
			if (!selected) {
				ctx.ui.notify(formatScheduleStatus(status), "info");
				return;
			}
			const updated = await writeScheduleConfig(dependencies.paths, selected.input);
			ctx.ui.notify(`Evo-Pi schedule updated — ${describeScheduleCadence(updated)}`, "info");
			return;
		}
		case "workflow": {
			if (rest === "reset") await resetEvolutionWorkflow(dependencies.paths);
			else if (rest) throw new Error("Usage: /evo workflow [reset]");
			const workflow = await readEvolutionWorkflow(dependencies.paths);
			sendCustomCard(pi, "evo.workflow", workflow, { path: dependencies.paths.workflow });
			return;
		}
		case "list": {
			const proposals = await dependencies.service.listProposals();
			if (proposals.length === 0) {
				ctx.ui.notify("No Evo-Pi proposals", "info");
				return;
			}
			sendCustomCard(pi, "evo.proposal-list", proposals.map(formatProposalSummary).join("\n"), {
				proposalIds: proposals.map((proposal) => proposal.id),
			});
			return;
		}
		case "show": {
			const id = requireValue(rest, "/evo show <proposal-id>");
			await showProposal(pi, dependencies, await dependencies.service.getProposal(id));
			return;
		}
		case "note": {
			const note = await dependencies.service.note(
				ctx.sessionManager.getSessionId(),
				requireValue(rest, "/evo note <text>"),
			);
			ctx.ui.notify(`Saved ${note.fileName}`, "info");
			return;
		}
		case "request": {
			const request = await dependencies.service.request(
				ctx.sessionManager.getSessionId(),
				requireValue(rest, "/evo request <text>"),
			);
			ctx.ui.notify(`Saved ${request.fileName}`, "info");
			return;
		}
		case "preference": {
			const preference = await dependencies.service.preference(
				ctx.sessionManager.getSessionId(),
				requireValue(rest, "/evo preference <text>"),
			);
			ctx.ui.notify(`Activated durable preference from ${preference.fileName}`, "info");
			return;
		}
		case "preferences": {
			if (rest) throw new Error("Usage: /evo preferences");
			sendCustomCard(pi, "evo.preferences", await formatActivePreferences(dependencies), {});
			return;
		}
		case "forget": {
			const preferenceId = requireValue(rest, "/evo forget <preference-id>");
			const request = await dependencies.service.forgetPreference(ctx.sessionManager.getSessionId(), preferenceId);
			ctx.ui.notify(`Saved removal request ${request.fileName}`, "info");
			return;
		}
		case "resolve": {
			const { first: file, rest: reason } = splitFirst(rest);
			requireValue(file, "/evo resolve <inbox-file> [reason]");
			if (!(await confirmExtensionMutation(ctx, "Resolve Evo-Pi input", `Mark ${file} fulfilled and collect it?`))) {
				ctx.ui.notify("Resolve cancelled", "info");
				return;
			}
			await dependencies.service.resolveInbox(file, reason || "User confirmed the input was fulfilled externally");
			ctx.ui.notify(`Resolved ${file}`, "info");
			return;
		}
		case "gc": {
			if (rest && rest !== "--dry-run") throw new Error("Usage: /evo gc [--dry-run]");
			const dryRun = rest === "--dry-run";
			if (
				!dryRun &&
				!(await confirmExtensionMutation(ctx, "Collect Evo-Pi inbox", "Delete terminal inbox payloads?"))
			) {
				ctx.ui.notify("GC cancelled", "info");
				return;
			}
			const result = await dependencies.service.gcInbox(dryRun);
			ctx.ui.notify(`${dryRun ? "GC would collect" : "GC collected"} ${result.files.length} inbox payloads`, "info");
			return;
		}
		case "permit": {
			const id = requireValue(rest, "/evo permit <proposal-id>");
			const result = await runExtensionPermit(pi, dependencies, id, ctx);
			if (!result) return;
			await showProposal(pi, dependencies, result);
			ctx.ui.notify(`Proposal ${id} is ${result.status}`, "info");
			return;
		}
		case "reject": {
			const { first: id, rest: reason } = splitFirst(rest);
			requireValue(id, "/evo reject <proposal-id> <reason>");
			requireValue(reason, "/evo reject <proposal-id> <reason>");
			if (!(await confirmExtensionMutation(ctx, `Reject ${id}`, `Reject proposal ${id}?`))) {
				ctx.ui.notify("Rejection cancelled", "info");
				return;
			}
			await dependencies.service.reject(id, reason);
			ctx.ui.notify(`Rejected ${id}`, "info");
			return;
		}
		case "rollback": {
			const { first, rest: trailing } = splitFirst(rest);
			const hasDigest = /^[a-f0-9]{64}$/.test(first);
			const reason = (hasDigest ? trailing : rest).trim() || "User requested rollback";
			const target = hasDigest ? `bundle ${first}` : "the active trial or stable bundle parent";
			if (!(await confirmExtensionMutation(ctx, "Roll back Evo-Pi", `Roll back ${target}?`))) {
				ctx.ui.notify("Rollback cancelled", "info");
				return;
			}
			const result = await dependencies.service.rollback(hasDigest ? first : undefined, reason);
			ctx.ui.notify(`Rolled back ${result.from} → ${result.to}`, "info");
			return;
		}
		case "keep": {
			if (!ctx.hasUI) throw new Error("Keeping a trial requires an interactive UI");
			const retrospective = await runRetrospective(modelOptions(dependencies));
			sendCustomCard(pi, "evo.retrospective", retrospective.retrospectiveMarkdown, {
				proposalId: retrospective.proposal.id,
			});
			const confirmed = await ctx.ui.confirm(
				`Keep ${retrospective.proposal.id}`,
				"Keep this trial after reviewing the retrospective?",
			);
			if (!confirmed) {
				ctx.ui.notify("Trial remains active", "info");
				return;
			}
			const kept = await dependencies.service.keep(rest || "User kept trial after retrospective");
			ctx.ui.notify(`Kept ${kept.id}`, "info");
			return;
		}
		case "retrospect": {
			const retrospective = await runRetrospective(modelOptions(dependencies));
			sendCustomCard(pi, "evo.retrospective", retrospective.retrospectiveMarkdown, {
				proposalId: retrospective.proposal.id,
			});
			return;
		}
		default:
			throw new Error(`Unknown /evo command: ${command}`);
	}
}

export function createEvoCommandExtension(options: EvoCommandExtensionOptions = {}): ExtensionFactory {
	const dependencies = createDependencies(options);
	return (pi) => {
		let statusTimer: NodeJS.Timeout | undefined;
		let refreshingStatus = false;
		let canPromptForCanary = false;
		let canaryInspectorOpen = false;
		const promptedCanaryRuns = new Set<string>();
		pi.on("session_start", async (_event, ctx) => {
			const refresh = async (): Promise<void> => {
				if (refreshingStatus) return;
				refreshingStatus = true;
				try {
					await refreshEvoStatusIndicator(dependencies, ctx, () => new Date(), false);
					if (canPromptForCanary && ctx.mode === "tui" && !canaryInspectorOpen) {
						const awaiting = (await listEvolutionRuns(dependencies.paths)).find(
							(run) => run.status === "awaiting-canary-approval" && !promptedCanaryRuns.has(run.id),
						);
						if (awaiting) {
							promptedCanaryRuns.add(awaiting.id);
							canaryInspectorOpen = true;
							try {
								await openEvolutionInspector(dependencies, ctx, awaiting.id);
							} finally {
								canaryInspectorOpen = false;
							}
						}
					}
				} catch {
					ctx.ui.setStatus("evo", undefined);
				} finally {
					refreshingStatus = false;
				}
			};
			if (statusTimer) clearInterval(statusTimer);
			await refresh();
			canPromptForCanary = true;
			statusTimer = setInterval(() => void refresh(), 1_000);
			statusTimer.unref?.();
		});
		pi.on("session_shutdown", (_event, ctx) => {
			if (statusTimer) clearInterval(statusTimer);
			statusTimer = undefined;
			canPromptForCanary = false;
			canaryInspectorOpen = false;
			promptedCanaryRuns.clear();
			ctx.ui.setStatus("evo", undefined);
		});
		pi.registerShortcut(QUICK_APPROVE_SHORTCUT, {
			description: "Apply the first pending T0 Evo-Pi proposal",
			handler: async (ctx) => {
				if (!ctx.hasUI || ctx.mode !== "tui") {
					ctx.ui.notify("T0 quick approval requires the interactive TUI", "error");
					return;
				}
				if (!ctx.isIdle()) {
					ctx.ui.notify("Wait for the active turn before applying a T0 proposal", "warning");
					return;
				}
				try {
					const proposal = await findPendingT0Proposal(dependencies);
					if (!proposal) {
						ctx.ui.notify("No pending T0 proposal", "info");
						return;
					}
					const approved = await dependencies.service.approve(proposal.id, proposalApproval(proposal));
					ctx.ui.notify(`Applied T0 proposal ${approved.id}`, "info");
				} catch (error) {
					ctx.ui.notify(`Evo-Pi: ${errorMessage(error)}`, "error");
				} finally {
					try {
						await refreshEvoStatusIndicator(dependencies, ctx);
					} catch {
						ctx.ui.setStatus("evo", undefined);
					}
				}
			},
		});
		pi.registerCommand("evo", {
			description: "Inspect and control Evo-Pi",
			getArgumentCompletions: (prefix) => {
				const commandPrefix = prefix.trimStart().toLowerCase();
				if (/\s/.test(commandPrefix)) return null;
				const matches = SUBCOMMANDS.filter((command) => command.startsWith(commandPrefix));
				return matches.map((command) => ({ value: command, label: command }));
			},
			handler: async (args, ctx) => {
				try {
					await dispatchExtensionCommand(pi, dependencies, args, ctx);
				} catch (error) {
					ctx.ui.notify(`Evo-Pi: ${errorMessage(error)}`, "error");
				} finally {
					try {
						await refreshEvoStatusIndicator(dependencies, ctx);
					} catch {
						ctx.ui.setStatus("evo", undefined);
					}
				}
			},
		});
	};
}

function createNodeCliIO(): EvoCliIO {
	return {
		interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
		write: (message) => console.log(message),
		writeError: (message) => console.error(message),
		question: async (prompt) => {
			const readline = createInterface({ input: process.stdin, output: process.stdout });
			try {
				return await readline.question(prompt);
			} finally {
				readline.close();
			}
		},
	};
}

function requireInteractive(io: EvoCliIO): void {
	if (!io.interactive) throw new Error("Changing Evo-Pi state requires an interactive terminal");
}

async function confirmLocalMutation(io: EvoCliIO, prompt: string): Promise<boolean> {
	requireInteractive(io);
	const answer = await io.question(`${prompt} [y/N] `);
	return /^(?:y|yes)$/i.test(answer.trim());
}

async function confirmLocalProposal(io: EvoCliIO, proposal: Proposal): Promise<boolean> {
	requireInteractive(io);
	if (proposal.kind === "code" || proposal.tier === "T2") {
		const expected = proposal.kind === "code" ? proposal.approvalDigest : proposal.diffDigest;
		const label = proposal.kind === "code" ? "code approval context digest" : "final diff digest";
		const digest = await io.question(`Type the ${label} ${expected}: `);
		if (digest.trim() !== expected) throw new Error("Approval digest did not match");
		return true;
	}
	const answer = await io.question(`Approve ${proposal.id} (${proposal.tier}/${proposal.kind})? [y/N] `);
	return /^(?:y|yes)$/i.test(answer.trim());
}

async function runLocalPermit(
	io: EvoCliIO,
	dependencies: EvoCommandDependencies,
	id: string,
): Promise<Proposal | undefined> {
	requireInteractive(io);
	let proposal = await dependencies.service.getProposal(id);
	while (true) {
		io.write(await formatProposalCard(dependencies.paths, proposal));
		const strictPermit = proposal.kind === "code" || proposal.tier === "T2";
		if (!strictPermit && proposal.tier === "T0" && proposal.status === "pending") {
			if (!(await confirmLocalProposal(io, proposal))) return undefined;
			return dependencies.service.approve(id, proposalApproval(proposal));
		}
		if (proposal.status !== "pending" && proposal.status !== "deferred") return proposal;
		const prompt =
			proposal.status === "deferred"
				? !strictPermit && proposal.tier === "T0"
					? "Action: [o] reopen, [x] reject, [c] close: "
					: "Action: [o] reopen, [q] ask why, [x] reject, [c] close: "
				: `Action: [q] ask why, ${strictPermit ? "[v] revise, " : ""}[a] approve, [x] reject, [d] defer, [c] close: `;
		const action = (await io.question(prompt)).trim().toLowerCase();
		if (!action || action === "c" || action === "close") return undefined;
		const expected = proposalApproval(proposal);
		if (action === "q" || action === "ask") {
			const question = await io.question("Question: ");
			if (!question.trim()) continue;
			const answer = await askProposalQuestion({
				paths: dependencies.paths,
				runner: dependencies.runner,
				proposalId: proposal.id,
				expected,
				question,
				...(dependencies.cwd ? { cwd: dependencies.cwd } : {}),
				...(dependencies.agentDir ? { agentDir: dependencies.agentDir } : {}),
				...(dependencies.model ? { model: dependencies.model } : {}),
			});
			io.write(answer.answerMarkdown);
			proposal = await dependencies.service.getProposal(id);
			continue;
		}
		if ((action === "v" || action === "revise") && strictPermit && proposal.status === "pending") {
			const instruction = await io.question("Revision instruction: ");
			if (!instruction.trim()) continue;
			proposal = await reviseProposalFromInstruction({
				paths: dependencies.paths,
				runner: dependencies.runner,
				proposalId: proposal.id,
				expected,
				instruction,
				...(dependencies.cwd ? { cwd: dependencies.cwd, repositoryCwd: dependencies.cwd } : {}),
				...(dependencies.agentDir ? { agentDir: dependencies.agentDir } : {}),
				...(dependencies.model ? { model: dependencies.model } : {}),
			});
			continue;
		}
		if ((action === "a" || action === "approve") && proposal.status === "pending") {
			if (!(await confirmLocalProposal(io, proposal))) continue;
			return dependencies.service.approve(id, expected);
		}
		if (action === "x" || action === "reject") {
			const reason = await io.question("Rejection reason: ");
			if (!reason.trim()) continue;
			return dependencies.service.reject(id, reason);
		}
		if ((action === "d" || action === "defer") && proposal.status === "pending") {
			const reason = await io.question("Deferral reason: ");
			if (!reason.trim()) continue;
			proposal = await dependencies.service.defer(id, reason);
			await recordPermitDefer({
				paths: dependencies.paths,
				proposalId: proposal.id,
				revision: proposal.revision,
				diffDigest: proposal.diffDigest,
				reason,
			});
			continue;
		}
		if ((action === "o" || action === "reopen") && proposal.status === "deferred") {
			const reason = "User reopened deferred proposal";
			proposal = await dependencies.service.reopen(id, reason);
			await recordPermitReopen({
				paths: dependencies.paths,
				proposalId: proposal.id,
				revision: proposal.revision,
				diffDigest: proposal.diffDigest,
				reason,
			});
		}
	}
}

function parseSessionText(value: string, usage: string): { sessionId: string; text: string } {
	const { first: sessionId, rest: text } = splitFirst(value);
	requireValue(sessionId, usage);
	requireValue(text, usage);
	return { sessionId, text };
}

export async function runEvoCli(args: string[], options: RunEvoCliOptions = {}): Promise<void> {
	const dependencies = createDependencies(options);
	const io = options.io ?? createNodeCliIO();
	const command = args[0]?.toLowerCase() ?? "help";
	const rest = args.slice(1).join(" ").trim();

	switch (command) {
		case "help":
		case "--help":
		case "-h":
			io.write(EVO_CLI_HELP);
			return;
		case "init": {
			const bundle = await dependencies.service.init();
			io.write(`Initialized ${bundle.digest}`);
			return;
		}
		case "status":
			io.write(formatStatus(await dependencies.service.status()));
			return;
		case "report": {
			const report = await runReport(modelOptions(dependencies));
			io.write(`${report.observationsMarkdown}\n\nSaved: ${report.file}`);
			return;
		}
		case "go": {
			const run = await startBackgroundEvolution({
				paths: dependencies.paths,
				cwd: dependencies.cwd ?? process.cwd(),
				...(rest ? { request: rest } : {}),
			});
			io.write(`Evolution task ${run.id} started in the background`);
			return;
		}
		case "inspect":
			io.write(formatEvolutionRuns(await inspectBackgroundEvolutions(dependencies.paths), rest || undefined));
			return;
		case "pause": {
			const id = requireValue(rest, "evo-pi pause <run-id>");
			await pauseBackgroundEvolution(dependencies.paths, id);
			io.write(`Evolution task ${id} paused`);
			return;
		}
		case "resume": {
			const id = requireValue(rest, "evo-pi resume <run-id>");
			await resumeBackgroundEvolution(dependencies.paths, id);
			io.write(`Evolution task ${id} resumed`);
			return;
		}
		case "retry": {
			const id = parseRetryArgs(rest, "evo-pi-admin retry <run-id> [--from validating]");
			const sandboxAvailable = await canUseEvoComponentSandbox();
			const allowDirect =
				!sandboxAvailable &&
				(await confirmLocalMutation(
					io,
					`OS sandbox unavailable. Run the built component from ${id} directly once for validation with your user permissions?`,
				));
			if (!sandboxAvailable && !allowDirect) {
				io.write("Retry cancelled; no component permission was granted");
				return;
			}
			const retried = await retryEvolutionFromValidation({
				paths: dependencies.paths,
				sourceRunId: id,
				cwd: dependencies.cwd ?? process.cwd(),
				...(allowDirect ? { sandbox: false } : {}),
			});
			io.write(
				retried.status === "awaiting-canary-approval"
					? `Evolution task ${retried.runId} is ready for Canary review`
					: `Evolution task ${retried.runId} is waiting for its frozen evidence strategy`,
			);
			return;
		}
		case "delete": {
			const id = requireValue(rest, "evo-pi delete <run-id>");
			if (!(await confirmLocalMutation(io, `Permanently delete ${id}?`))) {
				io.write("Delete cancelled");
				return;
			}
			await removeBackgroundEvolution(dependencies.paths, id);
			io.write(`Evolution task ${id} deleted`);
			return;
		}
		case "scheduled-improve": {
			const scheduled = await runConfiguredImprove({
				paths: dependencies.paths,
				improve: (signal) =>
					runEvolutionCycle({
						paths: dependencies.paths,
						service: dependencies.service,
						runner: dependencies.runner,
						cwd: dependencies.cwd,
						agentDir: dependencies.agentDir,
						trigger: "scheduled",
						signal,
					}),
			});
			if (scheduled.status === "skipped") {
				io.write(describeImproveSkip(scheduled));
				return;
			}
			io.write(`Evolution run ${scheduled.value.run.id} completed`);
			for (const proposal of scheduled.value.proposals)
				io.write(await formatProposalCard(dependencies.paths, proposal));
			return;
		}
		case "schedule": {
			if (!rest) {
				io.write(formatScheduleStatus(await getScheduleStatus(dependencies.paths)));
				return;
			}
			const cadence = parseScheduleCadence(rest);
			if (!cadence) throw new Error(`Usage: ${SCHEDULE_USAGE.replace("/evo", "evo-pi")}`);
			const updated = await writeScheduleConfig(dependencies.paths, cadence);
			io.write(`Evo-Pi schedule updated — ${describeScheduleCadence(updated)}`);
			return;
		}
		case "workflow": {
			if (rest === "reset") await resetEvolutionWorkflow(dependencies.paths);
			else if (rest) throw new Error("Usage: evo-pi workflow [reset]");
			io.write(`${dependencies.paths.workflow}\n\n${await readEvolutionWorkflow(dependencies.paths)}`);
			return;
		}
		case "list": {
			const proposals = await dependencies.service.listProposals();
			io.write(proposals.length ? proposals.map(formatProposalSummary).join("\n") : "No Evo-Pi proposals");
			return;
		}
		case "show":
			io.write(
				await formatProposalCard(
					dependencies.paths,
					await dependencies.service.getProposal(requireValue(args[1] ?? "", "evo-pi show <proposal-id>")),
				),
			);
			return;
		case "note": {
			const value = parseSessionText(rest, "evo-pi note <session-id> <text>");
			io.write((await dependencies.service.note(value.sessionId, value.text)).path);
			return;
		}
		case "request": {
			const value = parseSessionText(rest, "evo-pi request <session-id> <text>");
			io.write((await dependencies.service.request(value.sessionId, value.text)).path);
			return;
		}
		case "preference": {
			const value = parseSessionText(rest, "evo-pi preference <session-id> <text>");
			io.write(
				`Activated durable preference from ${(await dependencies.service.preference(value.sessionId, value.text)).fileName}`,
			);
			return;
		}
		case "preferences":
			if (rest) throw new Error("Usage: evo-pi preferences");
			io.write(await formatActivePreferences(dependencies));
			return;
		case "forget": {
			const value = parseSessionText(rest, "evo-pi forget <session-id> <preference-id>");
			io.write((await dependencies.service.forgetPreference(value.sessionId, value.text)).path);
			return;
		}
		case "resolve": {
			const { first: file, rest: reason } = splitFirst(rest);
			requireValue(file, "evo-pi resolve <inbox-file> [reason]");
			if (!(await confirmLocalMutation(io, `Mark ${file} fulfilled and collect it?`))) {
				io.write("Resolve cancelled");
				return;
			}
			await dependencies.service.resolveInbox(file, reason || "User confirmed the input was fulfilled externally");
			io.write(`Resolved ${file}`);
			return;
		}
		case "gc": {
			if (rest && rest !== "--dry-run") throw new Error("Usage: evo-pi gc [--dry-run]");
			const dryRun = rest === "--dry-run";
			if (!dryRun && !(await confirmLocalMutation(io, "Delete terminal inbox payloads?"))) {
				io.write("GC cancelled");
				return;
			}
			const result = await dependencies.service.gcInbox(dryRun);
			io.write(`${dryRun ? "GC would collect" : "GC collected"} ${result.files.length} inbox payloads`);
			return;
		}
		case "permit": {
			const id = requireValue(args[1] ?? "", "evo-pi permit <proposal-id>");
			const result = await runLocalPermit(io, dependencies, id);
			io.write(result ? `Proposal ${id} is ${result.status}` : "Approval closed without a decision");
			return;
		}
		case "reject": {
			const id = requireValue(args[1] ?? "", "evo-pi reject <proposal-id> <reason>");
			const reason = requireValue(args.slice(2).join(" "), "evo-pi reject <proposal-id> <reason>");
			if (!(await confirmLocalMutation(io, `Reject proposal ${id}?`))) {
				io.write("Rejection cancelled");
				return;
			}
			await dependencies.service.reject(id, reason);
			io.write(`Rejected ${id}`);
			return;
		}
		case "rollback": {
			const hasDigest = /^[a-f0-9]{64}$/.test(args[1] ?? "");
			const reason =
				args
					.slice(hasDigest ? 2 : 1)
					.join(" ")
					.trim() || "User requested rollback";
			const target = hasDigest ? `to ${args[1]}` : "the active trial or stable bundle";
			if (!(await confirmLocalMutation(io, `Roll back ${target}?`))) {
				io.write("Rollback cancelled");
				return;
			}
			const result = await dependencies.service.rollback(hasDigest ? args[1] : undefined, reason);
			io.write(`Rolled back ${result.from} → ${result.to}`);
			return;
		}
		case "keep": {
			requireInteractive(io);
			const retrospective = await runRetrospective(modelOptions(dependencies));
			io.write(retrospective.retrospectiveMarkdown);
			const answer = await io.question(`Keep trial ${retrospective.proposal.id}? [y/N] `);
			if (!/^(?:y|yes)$/i.test(answer.trim())) {
				io.write("Trial remains active");
				return;
			}
			io.write(`Kept ${(await dependencies.service.keep(rest || "User kept trial after retrospective")).id}`);
			return;
		}
		case "retrospect": {
			const retrospective = await runRetrospective(modelOptions(dependencies));
			io.write(retrospective.retrospectiveMarkdown);
			return;
		}
		default:
			io.writeError(`Unknown command: ${command}`);
			throw new Error(`Unknown command: ${command}`);
	}
}
