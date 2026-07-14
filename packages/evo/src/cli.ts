import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { ExtensionCommandContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { type EvoPaths, getEvoPaths } from "./paths.ts";
import { createPiModelRunner, type ModelRunner } from "./reflect/model-runner.ts";
import { runReflector, runReport } from "./reflect/reflector.ts";
import { runRetrospective } from "./reflect/retrospective.ts";
import { EvoService } from "./service.ts";
import type { EvoStatus, Proposal } from "./types.ts";

const SUBCOMMANDS = [
	"help",
	"init",
	"status",
	"report",
	"improve",
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

export const EVO_HELP = `Usage: /evo <command>

  help                         Show this help
  init                         Initialize an empty data bundle
  status                       Show registry and trial status
  report                       Generate a read-only evidence report
  improve                      Run reflection and stage proposals
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
		`paused: ${String(status.paused)}`,
	].join("\n");
}

function formatProposalSummary(proposal: Proposal): string {
	return `${proposal.id}  ${proposal.status}  ${proposal.tier}/${proposal.kind}  ${proposal.motivation}`;
}

async function readProposalArtifact(
	paths: EvoPaths,
	proposal: Proposal,
	file: string | undefined,
): Promise<string | undefined> {
	if (!file || !["review.md", "replay.md", "retrospective.md"].includes(file)) return undefined;
	try {
		return (await readFile(join(paths.proposals, proposal.id, file), "utf8")).trim();
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
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
	const review = await readProposalArtifact(paths, proposal, proposal.reviewFile);
	const replay = await readProposalArtifact(paths, proposal, proposal.replayFile);
	const retrospective = await readProposalArtifact(paths, proposal, proposal.retrospectiveFile);
	return [
		`# Evo proposal ${proposal.id}`,
		"",
		`Status: ${proposal.status}`,
		`Tier: ${proposal.tier}`,
		`Kind: ${proposal.kind}`,
		`Parent bundle: ${proposal.parentBundleDigest}`,
		`Approval digest: ${proposal.approvalDigest}`,
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

function modelOptions(dependencies: EvoCommandDependencies) {
	return {
		paths: dependencies.paths,
		runner: dependencies.runner,
		...(dependencies.cwd ? { cwd: dependencies.cwd } : {}),
		...(dependencies.agentDir ? { agentDir: dependencies.agentDir } : {}),
		...(dependencies.model ? { model: dependencies.model } : {}),
	};
}

async function refreshPendingStatus(dependencies: EvoCommandDependencies, ctx: ExtensionCommandContext): Promise<void> {
	const pending = (await dependencies.service.status()).pendingProposals;
	ctx.ui.setStatus("evo", pending > 0 ? `evo: ${pending} pending` : undefined);
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

async function confirmProposal(proposal: Proposal, ctx: ExtensionCommandContext): Promise<boolean> {
	if (!ctx.hasUI) throw new Error("Proposal approval requires an interactive UI");
	if (proposal.tier === "T2") {
		const digest = await ctx.ui.input(
			`Approve ${proposal.id}`,
			`Type the full approval digest: ${proposal.approvalDigest}`,
		);
		if (digest?.trim() !== proposal.approvalDigest) {
			ctx.ui.notify("Approval digest did not match; proposal remains pending", "error");
			return false;
		}
		return true;
	}
	return ctx.ui.confirm(
		`Approve ${proposal.id}`,
		`${proposal.tier}/${proposal.kind}: ${proposal.motivation}\n\nApply digest ${proposal.approvalDigest}?`,
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
			const bundle = await dependencies.service.init();
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
			const proposal = await dependencies.service.getProposal(id);
			await showProposal(pi, dependencies, proposal);
			if (!(await confirmProposal(proposal, ctx))) return;
			const approved = await dependencies.service.approve(id, proposal.approvalDigest);
			await showProposal(pi, dependencies, approved);
			ctx.ui.notify(`Proposal ${id} is ${approved.status}`, "info");
			return;
		}
		case "reject": {
			const { first: id, rest: reason } = splitFirst(rest);
			requireValue(id, "/evo reject <proposal-id> <reason>");
			requireValue(reason, "/evo reject <proposal-id> <reason>");
			await dependencies.service.reject(id, reason);
			ctx.ui.notify(`Rejected ${id}`, "info");
			return;
		}
		case "rollback": {
			const { first, rest: trailing } = splitFirst(rest);
			const hasDigest = /^[a-f0-9]{64}$/.test(first);
			const reason = (hasDigest ? trailing : rest).trim() || "User requested rollback";
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
		case "pause":
			await dependencies.service.pause(rest || "User paused Evo-Pi");
			ctx.ui.notify("Evo-Pi paused", "info");
			return;
		case "resume":
			await dependencies.service.resume(rest || "User resumed Evo-Pi");
			ctx.ui.notify("Evo-Pi resumed", "info");
			return;
		default:
			throw new Error(`Unknown /evo command: ${command}`);
	}
}

export function createEvoCommandExtension(options: EvoCommandExtensionOptions = {}): ExtensionFactory {
	const dependencies = createDependencies(options);
	return (pi) => {
		pi.on("session_start", async (_event, ctx) => {
			try {
				await refreshPendingStatus(dependencies, ctx as ExtensionCommandContext);
			} catch {
				ctx.ui.setStatus("evo", undefined);
			}
		});
		pi.on("session_shutdown", (_event, ctx) => {
			ctx.ui.setStatus("evo", undefined);
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
						await refreshPendingStatus(dependencies, ctx);
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
	if (!io.interactive) throw new Error("This approval requires an interactive terminal");
}

async function confirmLocalProposal(io: EvoCliIO, proposal: Proposal): Promise<boolean> {
	requireInteractive(io);
	if (proposal.tier === "T2") {
		const digest = await io.question(`Type the full approval digest ${proposal.approvalDigest}: `);
		if (digest.trim() !== proposal.approvalDigest) throw new Error("Approval digest did not match");
		return true;
	}
	const answer = await io.question(`Approve ${proposal.id} (${proposal.tier}/${proposal.kind})? [y/N] `);
	return /^(?:y|yes)$/i.test(answer.trim());
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
			const proposal = await dependencies.service.getProposal(id);
			io.write(await formatProposalCard(dependencies.paths, proposal));
			if (!(await confirmLocalProposal(io, proposal))) {
				io.write("Approval cancelled");
				return;
			}
			io.write(`Proposal ${id} is ${(await dependencies.service.approve(id, proposal.approvalDigest)).status}`);
			return;
		}
		case "reject": {
			const id = requireValue(args[1] ?? "", "evo-pi reject <proposal-id> <reason>");
			const reason = requireValue(args.slice(2).join(" "), "evo-pi reject <proposal-id> <reason>");
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
			await dependencies.service.pause(rest || "User paused Evo-Pi");
			io.write("Evo-Pi paused");
			return;
		case "resume":
			await dependencies.service.resume(rest || "User resumed Evo-Pi");
			io.write("Evo-Pi resumed");
			return;
		default:
			io.writeError(`Unknown command: ${command}`);
			throw new Error(`Unknown command: ${command}`);
	}
}
