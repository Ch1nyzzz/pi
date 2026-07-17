import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadCompiledBundle } from "./bundle/compile.ts";
import { renderTrialComparisonMarkdown, type TrialComparison } from "./comparison.ts";
import { EvoCapabilityBroker } from "./components/capabilities/broker.ts";
import {
	pauseBackgroundEvolution,
	removeBackgroundEvolution,
	resumeBackgroundEvolution,
	startBackgroundEvolution,
} from "./evolve/background.ts";
import {
	readEvoControlConfig,
	readEvolutionWorkflow,
	resetEvolutionWorkflow,
	updateEvoControlConfigValue,
} from "./evolve/config.ts";
import { runEvolutionCycle } from "./evolve/cycle.ts";
import { getSessionTriageStatus, runSessionTriage } from "./evolve/triage.ts";
import { readInboxEntry, readInboxLifecycleStates } from "./inbox.ts";
import { readBundlePreferenceMemory } from "./memory/preferences.ts";
import { DEEP_RESEARCH_TRIGGER, writeDeepResearchPack } from "./pack/templates/deep-research.ts";
import { DEEP_REVIEW_TRIGGER, writeDeepReviewPack } from "./pack/templates/deep-review.ts";
import { DEEPCODE_TRIGGER, writeDeepcodePack } from "./pack/templates/deepcode.ts";
import type { WrittenWorkflowPack } from "./pack/templates/write-pack.ts";
import type { EvoPaths } from "./paths.ts";
import { readEvaluationArtifact } from "./proposal-artifacts.ts";
import type { ModelRunner } from "./reflect/model-runner.ts";
import { runRetrospective } from "./reflect/retrospective.ts";
import { renderModelUsageSummary, summarizeModelUsage } from "./reflect/usage.ts";
import { runConfiguredImprove, type ScheduledImproveResult } from "./scheduler.ts";
import type { EvoService } from "./service.ts";
import type { EvoStatus, HistoryEntry, Proposal, ProposalArtifactKind } from "./types.ts";

/**
 * Presentation seam between the two command surfaces: the in-session /evo
 * extension (cards + notifications + UI confirms) and the standalone evo-pi
 * CLI (stdout + readline confirms). Shared handlers below are written once
 * against this interface; each dispatcher supplies its own implementation.
 */
export interface EvoCommandPresenter {
	/** "/evo" or "evo-pi"; only used inside usage strings. */
	commandPrefix: string;
	/** Resolved working directory for spawned background work. */
	cwd: string;
	/** Full-content result (extension: custom card; CLI: stdout). */
	print(customType: string, content: string, details?: Record<string, unknown>): void;
	/** Short one-line status message. */
	notify(message: string): void;
	/** Yes/no confirmation gating a state change; rejects when non-interactive. */
	confirm(title: string, message: string): Promise<boolean>;
}

/** The dependency slice shared handlers need; EvoCommandDependencies satisfies it. */
export interface EvoSharedCommandContext {
	paths: EvoPaths;
	service: EvoService;
	runner: ModelRunner;
	cwd?: string;
	agentDir?: string;
	model?: string;
}

export function modelRunOptions(context: EvoSharedCommandContext, signal?: AbortSignal) {
	return {
		paths: context.paths,
		runner: context.runner,
		...(context.cwd ? { cwd: context.cwd } : {}),
		...(context.agentDir ? { agentDir: context.agentDir } : {}),
		...(context.model ? { model: context.model } : {}),
		...(signal ? { signal } : {}),
	};
}

export function splitFirst(value: string): { first: string; rest: string } {
	const trimmed = value.trim();
	const separator = trimmed.search(/\s/);
	if (separator === -1) return { first: trimmed, rest: "" };
	return { first: trimmed.slice(0, separator), rest: trimmed.slice(separator).trim() };
}

export function requireValue(value: string, usage: string): string {
	if (!value.trim()) throw new Error(`Usage: ${usage}`);
	return value.trim();
}

export async function requireActiveBundleDigest(context: { service: EvoService }): Promise<string> {
	const digest = await context.service.registry.readStableDigest();
	if (!digest) throw new Error("Evo-Pi is not initialized; run evo-pi init first");
	return digest;
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

function proposalCardDetails(proposal: Proposal): Record<string, unknown> {
	return {
		proposalId: proposal.id,
		status: proposal.status,
		tier: proposal.tier,
		approvalDigest: proposal.approvalDigest,
	};
}

async function formatActivePreferences(context: EvoSharedCommandContext): Promise<string> {
	const digest = await context.service.registry.readStableDigest();
	if (!digest) return "No active Evo-Pi preferences";
	const memory = await readBundlePreferenceMemory(await loadCompiledBundle(context.paths, digest));
	if (memory.preferences.length === 0) return "No active Evo-Pi preferences";
	return [
		"# Active Evo-Pi preferences",
		"",
		...memory.preferences.map((preference) => `- ${preference.id}: ${preference.instruction}`),
	].join("\n");
}

const WORKFLOW_PACK_TEMPLATES: Record<
	string,
	{ trigger: string; description: string; write(directory: string): Promise<WrittenWorkflowPack> }
> = {
	"deep-review": {
		trigger: DEEP_REVIEW_TRIGGER,
		description: "Voting-style code review: per-file reviewers plus adversarial verification",
		write: writeDeepReviewPack,
	},
	"deep-research": {
		trigger: DEEP_RESEARCH_TRIGGER,
		description: "Multi-source research: parallel searchers, adversarial claim verification, cited report",
		write: writeDeepResearchPack,
	},
	deepcode: {
		trigger: DEEPCODE_TRIGGER,
		description: "Multi-agent coding: parallel explorers, frozen step plan, serial implementation, verify-fix loop",
		write: writeDeepcodePack,
	},
};

function formatWorkflowPackTemplates(): string {
	return [
		"Bundled workflow pack templates:",
		...Object.entries(WORKFLOW_PACK_TEMPLATES).map(
			([name, template]) => `- ${name} (${template.trigger}): ${template.description}`,
		),
		"",
		"Write one with 'packs init <template> [directory]', then import the directory to stage it.",
	].join("\n");
}

async function initWorkflowPackTemplate(name: string, directory: string | undefined): Promise<string> {
	const template = WORKFLOW_PACK_TEMPLATES[name];
	if (!template) {
		throw new Error(
			`Unknown pack template: ${name || "(none)"}. Available: ${Object.keys(WORKFLOW_PACK_TEMPLATES).join(", ")}`,
		);
	}
	const target = resolve(directory ?? `${name}-pack`);
	const written = await template.write(target);
	return [
		`Wrote ${written.manifest.name}@${written.manifest.version} (${template.trigger}) to ${target}`,
		`Integrity: ${written.integrity}`,
		`Next: run 'import ${target}' to stage the workflow proposal.`,
	].join("\n");
}

async function formatActiveWorkflows(context: EvoSharedCommandContext): Promise<string> {
	const digest = await requireActiveBundleDigest(context);
	const bundle = await loadCompiledBundle(context.paths, digest);
	const workflows = bundle.policy.workflows ?? [];
	if (workflows.length === 0) {
		return "No workflow components are active in the current bundle. Use 'packs' to see bundled templates.";
	}
	const broker = await new EvoCapabilityBroker({ paths: context.paths }).getState();
	const lines = workflows.map((selection) => {
		const spawn = (selection.grants ?? []).find((grant) => grant.capability === "spawn-agent");
		const grantLabel =
			spawn && "models" in spawn
				? `spawn-agent ≤${spawn.maxCalls} calls · ${spawn.models.join(",")}`
				: "no spawn-agent grant";
		const usage = broker.components
			.find((component) => component.id === selection.id && component.artifactDigest === selection.artifactDigest)
			?.usage.find((entry) => entry.capability === "spawn-agent");
		const usageLabel = usage ? ` · used ${usage.calls} call(s)` : "";
		return `- ${selection.trigger} → ${selection.id} (${selection.artifactDigest.slice(0, 12)}) · ${grantLabel}${usageLabel}`;
	});
	return [`Active workflows in bundle ${digest.slice(0, 12)}:`, ...lines].join("\n");
}

async function formatCapabilityGrants(paths: EvoPaths): Promise<string> {
	const state = await new EvoCapabilityBroker({ paths }).getState();
	if (state.components.length === 0) {
		return "No components hold capability grants. Grants are persisted when an imported pack's proposal is staged.";
	}
	const lines = [`Capability grants (${state.components.length} component(s)):`];
	for (const component of state.components) {
		lines.push(`- ${component.id} (${component.artifactDigest.slice(0, 12)})`);
		for (const grant of component.grants) {
			const usage = component.usage.find((entry) => entry.capability === grant.capability);
			const calls = usage?.calls ?? 0;
			if ("models" in grant) {
				const cost = usage?.costUsd ?? 0;
				const tokens = usage?.totalTokens ?? 0;
				const tools = grant.tools ? ` · ${grant.tools.length} tool(s)` : "";
				lines.push(
					`    ${grant.capability}: ${calls}/${grant.maxCalls} calls · $${cost.toFixed(4)}/$${grant.maxCostUsd} · ${tokens}/${grant.maxTotalTokens} total tokens · models ${grant.models.join(",")}${tools}`,
				);
			} else {
				lines.push(`    ${grant.capability}: ${calls}/${grant.maxCalls} calls`);
			}
		}
	}
	if (state.operations.length > 0 || state.reservations.length > 0) {
		lines.push(`In-flight: ${state.operations.length} operation(s), ${state.reservations.length} reservation(s)`);
	}
	return lines.join("\n");
}

const DEFAULT_HISTORY_LIMIT = 20;

function shortDigest(digest: string | undefined): string {
	return digest ? digest.slice(0, 12) : "none";
}

async function formatBundleHistory(paths: EvoPaths, rest: string, prefix: string): Promise<string> {
	const trimmed = rest.trim();
	const match = /^([1-9][0-9]*)$/.exec(trimmed);
	if (trimmed && !match) throw new Error(`Usage: ${prefix} history [<count>]`);
	const limit = match ? Number(match[1]) : DEFAULT_HISTORY_LIMIT;
	let content: string;
	try {
		content = await readFile(paths.history, "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return "No bundle transitions recorded yet.";
		}
		throw error;
	}
	const entries: HistoryEntry[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as HistoryEntry;
			if (typeof entry.timestamp === "string" && typeof entry.action === "string") entries.push(entry);
		} catch {
			// A torn final line from a crashed writer is repaired by the registry
			// on its next transaction; the read-only view just skips it.
		}
	}
	if (entries.length === 0) return "No bundle transitions recorded yet.";
	const shown = entries.slice(-limit);
	const lines = shown.map((entry) => {
		const digests =
			entry.fromDigest || entry.toDigest ? ` ${shortDigest(entry.fromDigest)} → ${shortDigest(entry.toDigest)}` : "";
		const proposal = entry.proposalId ? ` · ${entry.proposalId}` : "";
		return `- ${entry.timestamp} ${entry.action} (${entry.actor})${digests}${proposal}\n    ${entry.reason}`;
	});
	return [`Bundle history (showing ${shown.length} of ${entries.length} transition(s), oldest first):`, ...lines].join(
		"\n",
	);
}

async function formatInboxListing(paths: EvoPaths): Promise<string> {
	const states = await readInboxLifecycleStates(paths);
	const files = (await readdir(paths.inbox)).filter((file) => file.endsWith(".json")).sort();
	if (files.length === 0) return "Inbox is empty.";
	const lines: string[] = [];
	for (const file of files) {
		try {
			const entry = await readInboxEntry(paths, file);
			const state = states.get(file);
			const preview = entry.text.replaceAll("\n", " ").slice(0, 96);
			lines.push(`- [${state?.status ?? "open"}/${state?.kind ?? entry.kind ?? "unclassified"}] ${file}`);
			lines.push(`    ${preview}`);
		} catch {
			lines.push(`- [unreadable] ${file}`);
		}
	}
	return [`Inbox entries (${files.length}):`, ...lines].join("\n");
}

async function formatUsageSummary(paths: EvoPaths, rest: string): Promise<string> {
	const trimmed = rest.trim();
	const match = /^([1-9][0-9]*)d$/.exec(trimmed);
	if (trimmed && !match) throw new Error("Usage: usage [<n>d]");
	const days = match ? Number(match[1]) : 7;
	const summary = await summarizeModelUsage(paths, {
		since: new Date(Date.now() - days * 24 * 60 * 60 * 1_000),
	});
	return [`Model usage over the last ${days}d:`, "", renderModelUsageSummary(summary)].join("\n");
}

async function formatControlConfig(paths: EvoPaths): Promise<string> {
	const config = await readEvoControlConfig(paths);
	return [`Config file: ${paths.config}`, "", JSON.stringify(config, undefined, 2)].join("\n");
}

function describeImproveSkip(result: Extract<ScheduledImproveResult<unknown>, { status: "skipped" }>): string {
	const detail =
		result.reason === "interval-not-elapsed" && result.nextEligibleDay
			? ` (next eligible ${result.nextEligibleDay})`
			: "";
	return `Scheduled improve skipped: ${result.reason}${detail}`;
}

/** One guarded, cadence-gated evolution attempt (the old `scheduled-improve`). */
async function runScheduledImprove(context: EvoSharedCommandContext, presenter: EvoCommandPresenter): Promise<void> {
	const scheduled = await runConfiguredImprove({
		paths: context.paths,
		improve: (signal) =>
			runEvolutionCycle({
				paths: context.paths,
				service: context.service,
				runner: context.runner,
				cwd: context.cwd,
				agentDir: context.agentDir,
				trigger: "scheduled",
				signal,
			}),
	});
	if (scheduled.status === "skipped") {
		presenter.notify(describeImproveSkip(scheduled));
		return;
	}
	presenter.notify(`Evolution run ${scheduled.value.run.id} completed`);
	for (const proposal of scheduled.value.proposals) {
		presenter.print("evo.proposal", await formatProposalCard(context.paths, proposal), proposalCardDetails(proposal));
	}
}

async function runTriageCommand(
	context: EvoSharedCommandContext,
	rest: string,
	presenter: EvoCommandPresenter,
): Promise<void> {
	if (rest && rest !== "now") throw new Error(`Usage: ${presenter.commandPrefix} triage [now]`);
	const config = await readEvoControlConfig(context.paths);
	if (rest !== "now") {
		const status = await getSessionTriageStatus(context.paths);
		presenter.print(
			"evo.triage",
			[
				`Last triage run: ${status.lastRunAt ?? "never"}`,
				`New complete sessions since then: ${status.newSessions} (auto-triage runs at ${config.triage.everyNSessions})`,
				`Triage model: ${config.models.triage.model}`,
				`Run '${presenter.commandPrefix} triage now' to scan the new sessions immediately.`,
			].join("\n"),
			{},
		);
		return;
	}
	const outcome = await runSessionTriage({
		paths: context.paths,
		runner: context.runner,
		model: config.models.triage.model,
		...(config.models.triage.thinkingLevel ? { thinkingLevel: config.models.triage.thinkingLevel } : {}),
		everyNSessions: 1,
		cwd: presenter.cwd,
		...(context.agentDir ? { agentDir: context.agentDir } : {}),
	});
	if (!outcome.ran) {
		presenter.notify("Triage skipped: no new complete sessions since the last run");
		return;
	}
	if (outcome.hypotheses.length === 0) {
		presenter.notify(`Triage scanned ${outcome.newSessions} new session(s); no hypotheses were filed`);
		return;
	}
	presenter.print(
		"evo.triage",
		[
			`Triage filed ${outcome.hypotheses.length} hypothesis(es) from ${outcome.newSessions} new session(s):`,
			...outcome.hypotheses.map((hypothesis) => `- ${hypothesis.direction}: ${hypothesis.summary}`),
			"",
			`Inbox files: ${outcome.inboxFiles.join(", ")}`,
			"The next research run consumes these as pre-triaged evidence.",
		].join("\n"),
		{ hypotheses: outcome.hypotheses.length },
	);
}

type SharedCommandHandler = (
	context: EvoSharedCommandContext,
	rest: string,
	presenter: EvoCommandPresenter,
) => Promise<void>;

async function runPlaybookCommand(
	context: EvoSharedCommandContext,
	rest: string,
	presenter: EvoCommandPresenter,
): Promise<void> {
	if (rest === "reset") await resetEvolutionWorkflow(context.paths);
	else if (rest) throw new Error(`Usage: ${presenter.commandPrefix} playbook [reset]`);
	const playbook = await readEvolutionWorkflow(context.paths);
	presenter.print("evo.playbook", `Playbook: ${context.paths.workflow}\n\n${playbook}`, {
		path: context.paths.workflow,
	});
}

const SHARED_COMMAND_HANDLERS: Record<string, SharedCommandHandler> = {
	status: async (context, _rest, presenter) => {
		presenter.notify(formatStatus(await context.service.status()));
	},
	go: async (context, rest, presenter) => {
		if (rest === "--scheduled") {
			await runScheduledImprove(context, presenter);
			return;
		}
		if (rest.startsWith("--")) throw new Error(`Usage: ${presenter.commandPrefix} go [request | --scheduled]`);
		const run = await startBackgroundEvolution({
			paths: context.paths,
			cwd: presenter.cwd,
			...(rest ? { request: rest } : {}),
		});
		presenter.notify(`Evolution task ${run.id} started in the background`);
	},
	// Deprecated alias for `go --scheduled`.
	"scheduled-improve": async (context, _rest, presenter) => {
		await runScheduledImprove(context, presenter);
	},
	pause: async (context, rest, presenter) => {
		const id = requireValue(rest, `${presenter.commandPrefix} pause <run-id>`);
		await pauseBackgroundEvolution(context.paths, id);
		presenter.notify(`Evolution task ${id} paused`);
	},
	resume: async (context, rest, presenter) => {
		const id = requireValue(rest, `${presenter.commandPrefix} resume <run-id>`);
		await resumeBackgroundEvolution(context.paths, id);
		presenter.notify(`Evolution task ${id} resumed`);
	},
	delete: async (context, rest, presenter) => {
		const id = requireValue(rest, `${presenter.commandPrefix} delete <run-id>`);
		if (!(await presenter.confirm("Delete evolution task", `Permanently delete ${id}?`))) {
			presenter.notify("Delete cancelled");
			return;
		}
		await removeBackgroundEvolution(context.paths, id);
		presenter.notify(`Evolution task ${id} deleted`);
	},
	// "workflow" is a deprecated alias: the evolution playbook is unrelated to
	// workflow components, which live under "workflows" and "packs".
	workflow: runPlaybookCommand,
	playbook: runPlaybookCommand,
	workflows: async (context, _rest, presenter) => {
		presenter.print("evo.workflows", await formatActiveWorkflows(context), {});
	},
	packs: async (_context, rest, presenter) => {
		const parts = rest.split(/\s+/).filter(Boolean);
		if (parts.length === 0) {
			presenter.print("evo.packs", formatWorkflowPackTemplates(), {});
			return;
		}
		if (parts[0] !== "init") throw new Error(`Usage: ${presenter.commandPrefix} packs [init <template> [directory]]`);
		presenter.print("evo.packs", await initWorkflowPackTemplate(parts[1] ?? "", parts[2]), { template: parts[1] });
	},
	config: async (context, rest, presenter) => {
		const parts = rest.split(/\s+/).filter(Boolean);
		if (parts[0] === "set") {
			const key = parts[1];
			const value = parts.slice(2).join(" ");
			if (!key || !value) throw new Error(`Usage: ${presenter.commandPrefix} config set <key> <value>`);
			await updateEvoControlConfigValue(context.paths, key, value);
			presenter.notify(`Config updated: ${key} = ${value}`);
			return;
		}
		if (parts.length > 0) throw new Error(`Usage: ${presenter.commandPrefix} config [set <key> <value>]`);
		presenter.print("evo.config", await formatControlConfig(context.paths), {});
	},
	grants: async (context, rest, presenter) => {
		if (rest) throw new Error(`Usage: ${presenter.commandPrefix} grants`);
		presenter.print("evo.grants", await formatCapabilityGrants(context.paths), {});
	},
	history: async (context, rest, presenter) => {
		presenter.print("evo.history", await formatBundleHistory(context.paths, rest, presenter.commandPrefix), {});
	},
	triage: runTriageCommand,
	inbox: async (context, _rest, presenter) => {
		presenter.print("evo.inbox", await formatInboxListing(context.paths), {});
	},
	usage: async (context, rest, presenter) => {
		presenter.print("evo.usage", await formatUsageSummary(context.paths, rest), {});
	},
	list: async (context, _rest, presenter) => {
		const proposals = await context.service.listProposals();
		if (proposals.length === 0) {
			presenter.notify("No Evo-Pi proposals");
			return;
		}
		presenter.print("evo.proposal-list", proposals.map(formatProposalSummary).join("\n"), {
			proposalIds: proposals.map((proposal) => proposal.id),
		});
	},
	show: async (context, rest, presenter) => {
		const { first: id } = splitFirst(rest);
		requireValue(id, `${presenter.commandPrefix} show <proposal-id>`);
		const proposal = await context.service.getProposal(id);
		presenter.print("evo.proposal", await formatProposalCard(context.paths, proposal), proposalCardDetails(proposal));
	},
	preferences: async (context, rest, presenter) => {
		if (rest) throw new Error(`Usage: ${presenter.commandPrefix} preferences`);
		presenter.print("evo.preferences", await formatActivePreferences(context), {});
	},
	resolve: async (context, rest, presenter) => {
		const { first: file, rest: reason } = splitFirst(rest);
		requireValue(file, `${presenter.commandPrefix} resolve <inbox-file> [reason]`);
		if (!(await presenter.confirm("Resolve Evo-Pi input", `Mark ${file} fulfilled and collect it?`))) {
			presenter.notify("Resolve cancelled");
			return;
		}
		await context.service.resolveInbox(file, reason || "User confirmed the input was fulfilled externally");
		presenter.notify(`Resolved ${file}`);
	},
	gc: async (context, rest, presenter) => {
		if (rest && rest !== "--dry-run") throw new Error(`Usage: ${presenter.commandPrefix} gc [--dry-run]`);
		const dryRun = rest === "--dry-run";
		if (!dryRun && !(await presenter.confirm("Collect Evo-Pi inbox", "Delete terminal inbox payloads?"))) {
			presenter.notify("GC cancelled");
			return;
		}
		const result = await context.service.gcInbox(dryRun);
		presenter.notify(`${dryRun ? "GC would collect" : "GC collected"} ${result.files.length} inbox payloads`);
	},
	reject: async (context, rest, presenter) => {
		const { first: id, rest: reason } = splitFirst(rest);
		requireValue(id, `${presenter.commandPrefix} reject <proposal-id> <reason>`);
		requireValue(reason, `${presenter.commandPrefix} reject <proposal-id> <reason>`);
		if (!(await presenter.confirm(`Reject ${id}`, `Reject proposal ${id}?`))) {
			presenter.notify("Rejection cancelled");
			return;
		}
		await context.service.reject(id, reason);
		presenter.notify(`Rejected ${id}`);
	},
	retrospect: async (context, _rest, presenter) => {
		const retrospective = await runRetrospective(modelRunOptions(context));
		presenter.print("evo.retrospective", retrospective.retrospectiveMarkdown, {
			proposalId: retrospective.proposal.id,
		});
	},
};

/**
 * Run `command` when it is one of the surface-independent commands; returns
 * false when the command is surface-specific and the caller must dispatch it.
 */
export async function runSharedEvoCommand(
	context: EvoSharedCommandContext,
	command: string,
	rest: string,
	presenter: EvoCommandPresenter,
): Promise<boolean> {
	const handler = SHARED_COMMAND_HANDLERS[command];
	if (!handler) return false;
	await handler(context, rest, presenter);
	return true;
}
