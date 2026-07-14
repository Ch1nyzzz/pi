import { createInterface } from "node:readline/promises";
import type { ExtensionCommandContext, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
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
import { runReflector, runReport } from "./reflect/reflector.ts";
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
	"improve",
	"scheduled-improve",
	"schedule",
	"list",
	"show",
	"note",
	"request",
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

export const EVO_HELP = `Usage: /evo <command>

  help                         Show this help
  init                         Initialize and migrate Pi data into a bundle
  status                       Show registry and trial status
  report                       Generate a read-only evidence report
  improve                      Run reflection and stage proposals
  scheduled-improve            Run one guarded background reflection attempt
  schedule [cadence]           Show or set the reflection cadence (daily, 3d, weekly, manual)
  list                         List proposals
  show <proposal-id>           Show a proposal card
  note <text>                  Record an explicit note
  request <text>               Record an explicit feature request
  permit <proposal-id>         Review and approve a proposal
  reject <proposal-id> <why>   Reject a pending proposal
  rollback [digest] [why]      Roll back the active trial or stable bundle
  keep [why]                   Run retrospective, then keep the active trial
  retrospect                   Run and show the active-trial retrospective
  pause [why]                  Pause reflection work
  resume [why]                 Resume reflection work`;

const EVO_CLI_HELP = EVO_HELP.replaceAll("/evo", "evo-pi")
	.replace("note <text>", "note <session-id> <text>")
	.replace("request <text>", "request <session-id> <text>");

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

export function describeScheduleCadence(config: EvoScheduleConfig): string {
	if (config.mode === "manual") return "manual (reflection only runs through /evo improve)";
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
		`trial reminder after: ${status.config.trialDueAfterDays} days`,
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

export async function formatProposalCard(paths: EvoPaths, proposal: Proposal): Promise<string> {
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
): Promise<void> {
	const status = await dependencies.service.status();
	const parts: string[] = [];
	if (status.pendingProposals > 0) {
		const quick = await findPendingT0Proposal(dependencies);
		parts.push(
			quick
				? `T0 ${compactStatusText(quick.motivation)} [Ctrl+Alt+E apply; /evo show ${quick.id}]`
				: `${status.pendingProposals} pending`,
		);
	}
	if (status.trial) {
		const schedule = await readScheduleConfig(dependencies.paths);
		const dueAt = Date.parse(status.trial.startedAt) + schedule.trialDueAfterDays * DAY_MS;
		if (Number.isFinite(dueAt) && now().getTime() >= dueAt) {
			parts.push(`trial ${status.trial.proposalId} due [/evo keep or /evo rollback]`);
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
		case "improve": {
			const result = await runReflector(modelOptions(dependencies));
			sendCustomCard(pi, "evo.observations", result.observationsMarkdown, {
				proposalIds: result.proposals.map((proposal) => proposal.id),
			});
			for (const proposal of result.proposals) await showProposal(pi, dependencies, proposal);
			if (result.proposals.length === 0) ctx.ui.notify("No grounded proposal was produced", "info");
			return;
		}
		case "scheduled-improve": {
			const scheduled = await runConfiguredImprove({
				paths: dependencies.paths,
				improve: (signal) => runReflector(modelOptions(dependencies, signal)),
			});
			if (scheduled.status === "skipped") {
				ctx.ui.notify(describeImproveSkip(scheduled), "info");
				return;
			}
			const result = scheduled.value;
			sendCustomCard(pi, "evo.observations", result.observationsMarkdown, {
				proposalIds: result.proposals.map((proposal) => proposal.id),
				runId: scheduled.runId,
			});
			for (const proposal of result.proposals) await showProposal(pi, dependencies, proposal);
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
		case "pause": {
			if (!(await confirmExtensionMutation(ctx, "Pause Evo-Pi", "Pause reflection work?"))) {
				ctx.ui.notify("Pause cancelled", "info");
				return;
			}
			await dependencies.service.pause(rest || "User paused Evo-Pi");
			ctx.ui.notify("Evo-Pi paused", "info");
			return;
		}
		case "resume": {
			if (!(await confirmExtensionMutation(ctx, "Resume Evo-Pi", "Resume reflection work?"))) {
				ctx.ui.notify("Resume cancelled", "info");
				return;
			}
			await dependencies.service.resume(rest || "User resumed Evo-Pi");
			ctx.ui.notify("Evo-Pi resumed", "info");
			return;
		}
		default:
			throw new Error(`Unknown /evo command: ${command}`);
	}
}

export function createEvoCommandExtension(options: EvoCommandExtensionOptions = {}): ExtensionFactory {
	const dependencies = createDependencies(options);
	return (pi) => {
		pi.on("session_start", async (_event, ctx) => {
			try {
				await refreshEvoStatusIndicator(dependencies, ctx);
			} catch {
				ctx.ui.setStatus("evo", undefined);
			}
		});
		pi.on("session_shutdown", (_event, ctx) => {
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
		case "improve": {
			const result = await runReflector(modelOptions(dependencies));
			io.write(result.observationsMarkdown);
			for (const proposal of result.proposals) io.write(await formatProposalCard(dependencies.paths, proposal));
			return;
		}
		case "scheduled-improve": {
			const scheduled = await runConfiguredImprove({
				paths: dependencies.paths,
				improve: (signal) => runReflector(modelOptions(dependencies, signal)),
			});
			if (scheduled.status === "skipped") {
				io.write(describeImproveSkip(scheduled));
				return;
			}
			io.write(scheduled.value.observationsMarkdown);
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
		case "pause":
			if (!(await confirmLocalMutation(io, "Pause Evo-Pi reflection work?"))) {
				io.write("Pause cancelled");
				return;
			}
			await dependencies.service.pause(rest || "User paused Evo-Pi");
			io.write("Evo-Pi paused");
			return;
		case "resume":
			if (!(await confirmLocalMutation(io, "Resume Evo-Pi reflection work?"))) {
				io.write("Resume cancelled");
				return;
			}
			await dependencies.service.resume(rest || "User resumed Evo-Pi");
			io.write("Evo-Pi resumed");
			return;
		default:
			io.writeError(`Unknown command: ${command}`);
			throw new Error(`Unknown command: ${command}`);
	}
}
