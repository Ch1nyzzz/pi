import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { ExtensionCommandContext, ExtensionContext, ExtensionFactory } from "@ch1nyzzz/pi-coding-agent";
import { loadCompiledBundle } from "./bundle/compile.ts";
import { DEFAULT_SPAWN_AGENT_TOOL_NAMES } from "./bundle/runtime.ts";
import { parseTrialDurationDays, renderTrialComparisonMarkdown, type TrialComparison } from "./comparison.ts";
import type { EvoBudgetedCapabilityGrant, EvoCapabilityGrant } from "./components/capabilities/broker.ts";
import { EvoCapabilityBroker, parseEvoCapabilityGrants } from "./components/capabilities/broker.ts";
import { canUseEvoComponentSandbox } from "./components/process-runtime.ts";
import type { EvoDiscoveredPack } from "./discovery/client.ts";
import { getEvoPackDiscoveryConfigPath, readEvoPackDiscoveryConfig } from "./discovery/config.ts";
import {
	type EvoPackRegistryInspection,
	type EvoPackRegistryInstallResult,
	type EvoPackRegistrySearchResult,
	EvoPackRegistryService,
} from "./discovery/service.ts";
import { type EvoDiscoveryFetch, EvoPackDiscoveryTransport } from "./discovery/transport.ts";
import { listEvoActivityItems } from "./evolve/activity.ts";
import {
	formatEvolutionRuns,
	inspectBackgroundEvolutions,
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
import { runEvolutionCycle, runUnknownAbiBuilderCycle, type UnknownAbiBuilderCycleResult } from "./evolve/cycle.ts";
import { EvolutionProcessInspector } from "./evolve/inspect-ui.ts";
import { changesComponentSelection } from "./evolve/release.ts";
import { retryEvolutionFromValidation } from "./evolve/retry.ts";
import {
	listEvolutionRuns,
	readEvolutionRun,
	readFrozenExperimentForProposal,
	updateEvolutionRun,
} from "./evolve/run.ts";
import type { UnknownAbiBuilderRequest } from "./evolve/unknown-abi.ts";
import { readInboxEntry, readInboxLifecycleStates } from "./inbox.ts";
import { readBundlePreferenceMemory } from "./memory/preferences.ts";
import { exportEvoPack } from "./pack/export.ts";
import { type EvoPackImportPreflight, type EvoPackImportResult, importEvoPack } from "./pack/import.ts";
import { type EvoPackManifest, loadEvoPack } from "./pack/pack.ts";
import { DEEP_RESEARCH_TRIGGER, writeDeepResearchPack } from "./pack/templates/deep-research.ts";
import { DEEP_REVIEW_TRIGGER, writeDeepReviewPack } from "./pack/templates/deep-review.ts";
import { DEEPCODE_TRIGGER, writeDeepcodePack } from "./pack/templates/deepcode.ts";
import type { WrittenWorkflowPack } from "./pack/templates/write-pack.ts";
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
import { renderModelUsageSummary, summarizeModelUsage } from "./reflect/usage.ts";
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
import type {
	CanaryTrialControl,
	ComponentApprovalDecision,
	EvoStatus,
	Proposal,
	ProposalArtifactKind,
} from "./types.ts";

const SUBCOMMANDS = [
	"help",
	"init",
	"search",
	"install",
	"import",
	"export",
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
	"playbook",
	"workflows",
	"packs",
	"config",
	"inbox",
	"usage",
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
const DISCOVERY_SEARCH_LIMIT = 50;
const SCHEDULE_USAGE = "/evo schedule [daily | 3d | weekly | every <n>d | manual]";

const EVO_HELP = `Usage: /evo <command>

  help                         Show this help
  init                         Initialize and migrate Pi data into a bundle
  search [query]               Search configured optimization-pack registries
  install <name> [version]     Verify a trusted registry pack and stage proposals
  import <directory>           Verify a pack and stage proposals; never activate it
  export <directory>           Export the active bundle as an optimization pack
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
  playbook [reset]             Show or reset the evolution playbook (guides research)
  workflows                    List active workflow components and their triggers
  packs [init <name> [dir]]    List bundled workflow pack templates or write one
  config [set <key> <value>]   Show or update the evo control config
  inbox                        List inbox entries with lifecycle status
  usage [<n>d]                 Show model usage and cost by phase (default 7d)
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
	.replace("export <directory>", "export <directory> [name] [version]")
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
	spawnAgentToolNames?: readonly string[];
	getDiscoveryService(): Promise<EvoCommandDiscoveryService>;
}

export type EvoCommandDiscoveryService = Pick<EvoPackRegistryService, "search" | "inspect" | "install">;

export interface EvoCommandDiscoveryOptions {
	configPath?: string;
	fetch?: EvoDiscoveryFetch;
	service?: EvoCommandDiscoveryService;
}

export interface EvoCommandExtensionOptions {
	root?: string;
	paths?: EvoPaths;
	service?: EvoService;
	runner?: ModelRunner;
	cwd?: string;
	agentDir?: string;
	model?: string;
	/** Exact trusted tool names available through the runtime spawn-agent host. */
	spawnAgentToolNames?: readonly string[];
	/** Local registry/trust config and injectable discovery dependencies. */
	discovery?: EvoCommandDiscoveryOptions;
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

function requireArgumentCount(args: string[], minimum: number, maximum: number, usage: string): void {
	if (args.length < minimum || args.length > maximum) throw new Error(`Usage: ${usage}`);
}

function parseRetryArgs(value: string, usage: string): string {
	const { first: id, rest } = splitFirst(value);
	requireValue(id, usage);
	if (rest && rest !== "--from validating") throw new Error(`Usage: ${usage}`);
	return id;
}

function parsePackSelection(value: string, usage: string): { name: string; version?: string } {
	const { first: name, rest } = splitFirst(value);
	requireValue(name, usage);
	if (!rest) return { name };
	const { first: version, rest: extra } = splitFirst(rest);
	if (!version || extra) throw new Error(`Usage: ${usage}`);
	return { name, version };
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

function formatPackImportResult(
	result: EvoPackImportResult,
	unknownAbiResults: readonly UnknownAbiBuilderCycleResult[] = [],
): string {
	const proposalCount = (result.proposal ? 1 : 0) + result.importedComponents.length + unknownAbiResults.length;
	const lines = [
		`Pack: ${result.manifest.name}@${result.manifest.version}`,
		`Integrity: ${result.manifest.integrity ?? "not declared"}`,
		`Prompt/skill imports: ${result.addedPromptPaths.length} prompt(s), ${result.addedSkillPaths.length} skill(s)`,
	];
	if (result.proposal) {
		lines.push(
			`Data proposal: ${result.proposal.id} -> ${result.proposal.candidateDigest ?? "candidate unavailable"}`,
		);
	}
	for (const component of result.importedComponents) {
		lines.push(
			`Component ${component.id} (${component.abi}): artifact ${component.artifactDigest}; proposal ${component.proposal.id} -> ${component.proposal.candidateDigest ?? "candidate unavailable"}`,
		);
	}
	if (result.unregisteredAbis.length > 0) {
		lines.push(`Unregistered ABIs: ${result.unregisteredAbis.join(", ")}`);
	}
	for (const built of unknownAbiResults) {
		lines.push(
			`ABI Builder ${built.request.targetAbi}: run ${built.run.id}; pending T2 proposal ${built.proposal.id}`,
			`Next: ${built.nextAction}`,
		);
	}
	if (result.pendingWorkflows > 0) lines.push(`Pending workflows: ${result.pendingWorkflows}`);
	lines.push(`Activation: none; ${proposalCount} proposal(s) staged for review.`);
	return lines.join("\n");
}

interface ActivePackExport {
	bundleDigest: string;
	targetDirectory: string;
	manifest: EvoPackManifest;
}

interface PackCapabilityGrantPreview {
	manifest: EvoPackManifest;
	integrity: string;
	grantsByComponent: Readonly<Record<string, readonly EvoCapabilityGrant[]>>;
}

const DEFAULT_CALL_CAPABILITY_MAX_CALLS = 1_000;

function createBudgetedCapabilityGrant(
	capability: EvoBudgetedCapabilityGrant["capability"],
	model: string,
	tools: readonly string[],
): EvoBudgetedCapabilityGrant {
	if (capability === "spawn-agent") {
		// The broker holds a worst-case reservation of contextWindow x maxTurns
		// input tokens per in-flight spawn (~16.8M tokens for a 256k-context
		// model at the 64-turn host default), so these caps are sized to keep
		// several large-context child agents runnable in parallel while still
		// bounding runaway loops. Actual charged usage is real consumption.
		return {
			capability,
			maxCalls: 100,
			models: [model],
			maxInputTokens: 268_435_456,
			maxOutputTokens: 16_777_216,
			maxTotalTokens: 285_212_672,
			maxCostUsd: 500,
			maxOutputTokensPerCall: 65_536,
			tools: [...new Set(tools)].sort(),
		};
	}
	return {
		capability,
		maxCalls: 200,
		models: [model],
		maxInputTokens: 1_048_576,
		maxOutputTokens: 262_144,
		maxTotalTokens: 1_310_720,
		maxCostUsd: 50,
		maxOutputTokensPerCall: 16_384,
	};
}

async function previewPackCapabilityGrants(
	packDirectory: string,
	model: string | undefined,
	tools: readonly string[],
): Promise<PackCapabilityGrantPreview> {
	const loaded = await loadEvoPack(packDirectory);
	if (!loaded.integrity.ok) {
		throw new Error(
			`pack integrity check failed: expected ${loaded.integrity.expected ?? "(none declared)"}, got ${loaded.integrity.actual}`,
		);
	}
	return createPackCapabilityGrantPreview(loaded.manifest, loaded.integrity.actual, model, tools);
}

function createPackCapabilityGrantPreview(
	manifest: EvoPackManifest,
	integrity: string,
	model: string | undefined,
	tools: readonly string[],
): PackCapabilityGrantPreview {
	const grantsByComponent: Record<string, readonly EvoCapabilityGrant[]> = {};
	const codeParts = [...manifest.contents.components, ...manifest.contents.workflows];
	for (const part of codeParts) {
		if (part.capabilities.length === 0) continue;
		const grants: unknown[] = [];
		for (const capability of part.capabilities) {
			if (capability === "infer" || capability === "spawn-agent") {
				if (!model) {
					throw new Error(
						`Pack component ${part.id} requests ${capability}; select or configure an allowed provider/model before import`,
					);
				}
				grants.push(createBudgetedCapabilityGrant(capability, model, tools));
				continue;
			}
			grants.push({ capability, maxCalls: DEFAULT_CALL_CAPABILITY_MAX_CALLS });
		}
		grantsByComponent[part.id] = parseEvoCapabilityGrants(grants, `grants for ${part.id}`);
	}
	return {
		manifest,
		integrity,
		grantsByComponent,
	};
}

function formatPackCapabilityGrantPreview(preview: PackCapabilityGrantPreview): string {
	return [
		`Pack: ${preview.manifest.name}@${preview.manifest.version}`,
		`Integrity: ${preview.integrity}`,
		"Exact persisted grants:",
		JSON.stringify(preview.grantsByComponent, undefined, 2),
		"These grants remain inactive until the corresponding code proposal is approved and its trial starts.",
	].join("\n");
}

function formatPackSource(source: EvoDiscoveredPack["entry"]["source"]): string {
	if (source.kind === "https") return `https ${source.rawUrl}`;
	if (source.kind === "git") {
		return `git ${source.repository}@${source.revision}:${source.path} (${source.rawUrl})`;
	}
	return `gist ${source.gistId}@${source.revision}:${source.file} (${source.rawUrl})`;
}

function formatPackTrust(trust: EvoDiscoveredPack["trust"]): string {
	if (trust.status === "trusted") return `trusted (${trust.signer})`;
	if (trust.status === "untrusted-signer") return `untrusted signer (${trust.signer})`;
	return "unsigned";
}

function formatPackRequirements(manifest: EvoPackManifest | undefined): string[] {
	if (!manifest) return ["Required ABIs: unavailable (entry is not trusted)", "Required capabilities: unavailable"];
	return [
		`Required ABIs: ${manifest.requiresAbis.join(", ") || "none"}`,
		`Required capabilities: ${manifest.requiresCapabilities.join(", ") || "none"}`,
	];
}

function formatPackInspection(inspection: EvoPackRegistryInspection): string {
	return [
		`Pack: ${inspection.entry.name}@${inspection.entry.version}`,
		`Trust: ${formatPackTrust(inspection.trust)}`,
		`Registry: ${formatPackSource(inspection.registrySource)}`,
		`Source: ${formatPackSource(inspection.packSource)}`,
		`Integrity: ${inspection.entry.integrity}`,
		...formatPackRequirements(inspection.manifest),
	].join("\n");
}

function formatPackSearchResults(results: readonly EvoPackRegistrySearchResult[]): string {
	if (results.length === 0) return "No optimization packs found";
	const cards: string[] = [];
	for (const result of results) {
		cards.push(
			[
				`Pack: ${result.entry.name}@${result.entry.version}`,
				`Trust: ${formatPackTrust(result.trust)}`,
				`Registry: ${formatPackSource(result.registrySource)}`,
				`Source: ${formatPackSource(result.entry.source)}`,
				`Integrity: ${result.entry.integrity}`,
				...formatPackRequirements(result.manifest),
				...(result.entry.description ? [`Description: ${result.entry.description}`] : []),
			].join("\n"),
		);
	}
	return cards.join("\n\n");
}

function formatRegistryPackInstallResult(
	result: EvoPackRegistryInstallResult,
	unknownAbiResults: readonly UnknownAbiBuilderCycleResult[],
): string {
	return [
		`Trust: ${formatPackTrust(result.trust)}`,
		`Registry: ${formatPackSource(result.registrySource)}`,
		`Source: ${formatPackSource(result.packSource)}`,
		`Downloaded: ${result.fileCount} file(s), ${result.totalBytes} byte(s)`,
		formatPackImportResult(result.imported, unknownAbiResults),
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

async function formatActiveWorkflows(dependencies: EvoCommandDependencies): Promise<string> {
	const digest = await requireActiveBundleDigest(dependencies);
	const bundle = await loadCompiledBundle(dependencies.paths, digest);
	const workflows = bundle.policy.workflows ?? [];
	if (workflows.length === 0) {
		return "No workflow components are active in the current bundle. Use 'packs' to see bundled templates.";
	}
	const broker = await new EvoCapabilityBroker({ paths: dependencies.paths }).getState();
	const lines = workflows.map((selection) => {
		const spawn = (selection.grants ?? []).find((grant) => grant.capability === "spawn-agent");
		const grantLabel =
			spawn && "models" in spawn
				? `spawn-agent \u2264${spawn.maxCalls} calls \u00b7 ${spawn.models.join(",")}`
				: "no spawn-agent grant";
		const usage = broker.components
			.find((component) => component.id === selection.id && component.artifactDigest === selection.artifactDigest)
			?.usage.find((entry) => entry.capability === "spawn-agent");
		const usageLabel = usage ? ` \u00b7 used ${usage.calls} call(s)` : "";
		return `- ${selection.trigger} \u2192 ${selection.id} (${selection.artifactDigest.slice(0, 12)}) \u00b7 ${grantLabel}${usageLabel}`;
	});
	return [`Active workflows in bundle ${digest.slice(0, 12)}:`, ...lines].join("\n");
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

async function requireActiveBundleDigest(dependencies: EvoCommandDependencies): Promise<string> {
	const digest = await dependencies.service.registry.readStableDigest();
	if (!digest) throw new Error("Evo-Pi is not initialized; run evo-pi init first");
	return digest;
}

async function stagePackImport(
	dependencies: EvoCommandDependencies,
	packDirectory: string,
	expectedIntegrity: string,
	grantsByComponent?: Readonly<Record<string, readonly EvoCapabilityGrant[]>>,
	parentDigest?: string,
	beforeStage?: (preflight: EvoPackImportPreflight) => Promise<void>,
): Promise<EvoPackImportResult> {
	return importEvoPack({
		paths: dependencies.paths,
		parentDigest: parentDigest ?? (await requireActiveBundleDigest(dependencies)),
		packDir: packDirectory,
		expectedIntegrity,
		...(grantsByComponent ? { grantsByComponent } : {}),
		...(beforeStage ? { beforeStage } : {}),
	});
}

async function stageUnknownPackAbis(
	dependencies: EvoCommandDependencies,
	parentDigest: string,
	requests: readonly UnknownAbiBuilderRequest[],
): Promise<UnknownAbiBuilderCycleResult[]> {
	const built: UnknownAbiBuilderCycleResult[] = [];
	for (const request of requests) {
		built.push(
			await runUnknownAbiBuilderCycle({
				paths: dependencies.paths,
				request,
				runner: dependencies.runner,
				service: dependencies.service,
				parentDigest,
				...(dependencies.cwd ? { cwd: dependencies.cwd } : {}),
				...(dependencies.agentDir ? { agentDir: dependencies.agentDir } : {}),
			}),
		);
	}
	return built;
}

async function exportActiveBundle(
	dependencies: EvoCommandDependencies,
	targetDirectory: string,
	name?: string,
	version?: string,
): Promise<ActivePackExport> {
	const bundleDigest = await requireActiveBundleDigest(dependencies);
	const manifest = await exportEvoPack({
		paths: dependencies.paths,
		bundleDigest,
		targetDirectory,
		name: name ?? `bundle-${bundleDigest.slice(0, 12)}`,
		version: version ?? "0.0.0",
	});
	return { bundleDigest, targetDirectory, manifest };
}

function formatPackExportResult(result: ActivePackExport): string {
	return [
		`Exported active bundle ${result.bundleDigest} to ${result.targetDirectory}`,
		`Pack: ${result.manifest.name}@${result.manifest.version}`,
		`Integrity: ${result.manifest.integrity ?? "not declared"}`,
	].join("\n");
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
	let discoveryService = options.discovery?.service;
	const discoveryFetch: EvoDiscoveryFetch = options.discovery?.fetch ?? ((url, init) => globalThis.fetch(url, init));
	return {
		paths,
		service: options.service ?? new EvoService(paths),
		runner: options.runner ?? createPiModelRunner(),
		cwd: options.cwd,
		agentDir: options.agentDir,
		model: options.model,
		spawnAgentToolNames: options.spawnAgentToolNames,
		getDiscoveryService: async () => {
			if (discoveryService) return discoveryService;
			const config = await readEvoPackDiscoveryConfig(
				options.discovery?.configPath ?? getEvoPackDiscoveryConfigPath(paths),
			);
			discoveryService = new EvoPackRegistryService({
				registrySources: config.registrySources,
				trustedSigners: config.trustedSigners,
				transport: new EvoPackDiscoveryTransport({ fetch: discoveryFetch }),
			});
			return discoveryService;
		},
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
	_now: () => Date = () => new Date(),
	_includeTrialComparison = true,
): Promise<void> {
	const items = await listEvoActivityItems(dependencies, {
		includeTrialComparison: _includeTrialComparison,
		now: _now,
	});
	ctx.ui.setStatus("evo", undefined);
	ctx.ui.setStatusItems(
		"evo",
		items.length > 0
			? items.map((item) => {
					const status = item.kind === "run" ? item.run.status : item.proposal.status;
					const text =
						status === "failed" || status === "cancelled"
							? ctx.ui.theme.fg("error", item.text)
							: status === "awaiting-canary-approval" || status === "awaiting-decision"
								? ctx.ui.theme.fg("warning", item.text)
								: status === "trialing"
									? ctx.ui.theme.fg("accent", item.text)
									: item.text;
					return {
						id: item.key,
						text,
						onSelect: () => openEvolutionInspector(dependencies, ctx, item.key),
					};
				})
			: undefined,
	);
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

async function packGrantsNeedConfirmation(paths: EvoPaths): Promise<boolean> {
	return (await readEvoControlConfig(paths)).grants.approval === "prompt";
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

async function resolveCanaryControl(
	dependencies: { paths: EvoPaths },
	proposalId: string,
	decision: Extract<ComponentApprovalDecision, { mode: "canary" }>,
): Promise<CanaryTrialControl> {
	if (decision.customization === "custom") {
		if (
			!Number.isSafeInteger(decision.minimumSamples) ||
			decision.minimumSamples <= 0 ||
			decision.minimumSamples > 10_000 ||
			!Number.isSafeInteger(decision.maximumDurationDays) ||
			decision.maximumDurationDays <= 0 ||
			decision.maximumDurationDays > 365
		) {
			throw new Error("Custom Canary controls must use 1-10000 sessions and 1-365 days");
		}
		return {
			customization: "custom",
			minimumSamples: decision.minimumSamples,
			maximumDurationDays: decision.maximumDurationDays,
		};
	}
	const [schedule, experiment] = await Promise.all([
		readScheduleConfig(dependencies.paths),
		readFrozenExperimentForProposal(dependencies.paths, proposalId),
	]);
	const online = experiment?.evidenceStrategy.online;
	const contractDays = online && online.mode !== "none" ? parseTrialDurationDays(online.maximumDuration) : undefined;
	return {
		customization: "default",
		minimumSamples:
			online && online.mode !== "none"
				? Math.max(schedule.trialDueAfterSessions, online.minimumSamples)
				: schedule.trialDueAfterSessions,
		maximumDurationDays:
			contractDays === undefined ? schedule.trialDueAfterDays : Math.min(schedule.trialDueAfterDays, contractDays),
	};
}

export async function approveCanaryRun(
	dependencies: { service: EvoService; paths: EvoPaths },
	runId: string,
	decision: ComponentApprovalDecision = { mode: "canary", customization: "default" },
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
	if (proposal.status === "trialing") {
		if (decision.mode === "direct") throw new Error("The component is already running as a Canary");
		const trial = await dependencies.service.registry.readTrial();
		if (
			!stable ||
			stable !== proposal.candidateDigest ||
			!trial ||
			trial.proposalId !== proposal.id ||
			trial.digest !== proposal.candidateDigest
		) {
			throw new Error("Component proposal and active Canary state disagree");
		}
		await updateEvolutionRun(dependencies.paths, run.id, {
			status: "trialing",
			canaryApprovalDigest: proposal.approvalDigest,
			canaryStableDigest: proposal.parentBundleDigest,
			componentApprovalMode: trial.canary?.customization === "custom" ? "custom-canary" : "default-canary",
			...(trial.canary
				? {
						canaryMinimumSamples: trial.canary.minimumSamples,
						canaryMaximumDurationDays: trial.canary.maximumDurationDays,
					}
				: {}),
		});
		return;
	}
	if (proposal.status === "kept") {
		if (!stable || stable !== proposal.candidateDigest || (await dependencies.service.registry.readTrial())) {
			throw new Error("Directly activated component state disagrees with the reviewed proposal");
		}
		await updateEvolutionRun(dependencies.paths, run.id, {
			status: "completed",
			canaryApprovalDigest: proposal.approvalDigest,
			canaryStableDigest: proposal.parentBundleDigest,
			componentApprovalMode: "direct",
		});
		return;
	}
	if (proposal.status !== "pending") throw new Error(`Component proposal is ${proposal.status}`);
	if (!stable || stable !== proposal.parentBundleDigest) {
		throw new Error("Stable bundle changed; rebuild and review the Canary against the new baseline");
	}
	const canary =
		decision.mode === "canary" ? await resolveCanaryControl(dependencies, proposal.id, decision) : undefined;
	const approved = await dependencies.service.approveComponent(
		proposal.id,
		proposalApproval(proposal),
		decision.mode === "direct" ? { mode: "direct" } : { mode: "trial", canary },
	);
	await updateEvolutionRun(dependencies.paths, run.id, {
		status: decision.mode === "direct" ? "completed" : "trialing",
		canaryApprovedAt: new Date().toISOString(),
		canaryApprovalDigest: approved.approvalDigest,
		canaryStableDigest: stable,
		componentApprovalMode:
			decision.mode === "direct"
				? "direct"
				: canary?.customization === "custom"
					? "custom-canary"
					: "default-canary",
		...(canary
			? {
					canaryMinimumSamples: canary.minimumSamples,
					canaryMaximumDurationDays: canary.maximumDurationDays,
				}
			: {}),
	});
}

export async function directKeepCanaryRun(
	dependencies: { service: EvoService; paths: EvoPaths },
	runId: string,
): Promise<void> {
	const run = await readEvolutionRun(dependencies.paths, runId);
	if (run.status !== "trialing" || !run.proposalId) {
		throw new Error(`Evolution task ${runId} is not running a component Canary`);
	}
	const proposal = await dependencies.service.getProposal(run.proposalId);
	if (!changesComponentSelection(proposal) || !proposal.candidateDigest || !proposal.targetAbi) {
		throw new Error("The active trial does not replace a component");
	}
	if (
		run.canaryParentDigest !== proposal.parentBundleDigest ||
		run.canaryCandidateDigest !== proposal.candidateDigest ||
		run.canaryTargetAbi !== proposal.targetAbi
	) {
		throw new Error("Canary run metadata no longer matches the exact proposal");
	}
	const [stable, trial] = await Promise.all([
		dependencies.service.registry.readStableDigest(),
		dependencies.service.registry.readTrial(),
	]);
	if (proposal.status === "kept") {
		if (stable !== proposal.candidateDigest || trial) {
			throw new Error("Directly kept component state disagrees with the reviewed proposal");
		}
	} else {
		if (
			proposal.status !== "trialing" ||
			stable !== proposal.candidateDigest ||
			!trial ||
			trial.proposalId !== proposal.id ||
			trial.digest !== proposal.candidateDigest
		) {
			throw new Error("Component proposal and active Canary state disagree");
		}
		await dependencies.service.directKeepComponentTrial(
			proposal.id,
			"Human directly kept the active validated component and ended Canary evidence collection",
		);
	}
	await updateEvolutionRun(dependencies.paths, run.id, {
		status: "completed",
		componentApprovalMode: "direct",
	});
}

async function openEvolutionInspector(
	dependencies: { service: EvoService; paths: EvoPaths },
	ctx: ExtensionContext,
	initialItem?: string,
): Promise<void> {
	const itemKey = initialItem && !initialItem.includes(":") ? `run:${initialItem}` : initialItem;
	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) =>
			new EvolutionProcessInspector(
				tui,
				theme,
				dependencies.paths,
				dependencies.service,
				itemKey,
				() => done(undefined),
				(runId, decision) => approveCanaryRun(dependencies, runId, decision),
				(runId) => directKeepCanaryRun(dependencies, runId),
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
		case "search": {
			const discovery = await dependencies.getDiscoveryService();
			const results = await discovery.search({
				...(rest ? { query: rest } : {}),
				limit: DISCOVERY_SEARCH_LIMIT,
				includeTrustedManifests: true,
			});
			sendCustomCard(pi, "evo.pack-search", formatPackSearchResults(results), {
				query: rest,
				count: results.length,
			});
			return;
		}
		case "install": {
			const selection = parsePackSelection(rest, "/evo install <name> [version]");
			const discovery = await dependencies.getDiscoveryService();
			const inspection = await discovery.inspect(selection.name, selection.version);
			const preview = createPackCapabilityGrantPreview(
				inspection.manifest,
				inspection.entry.integrity,
				dependencies.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined),
				dependencies.spawnAgentToolNames ?? DEFAULT_SPAWN_AGENT_TOOL_NAMES,
			);
			sendCustomCard(pi, "evo.pack-inspect", formatPackInspection(inspection), {
				pack: inspection.entry.name,
				version: inspection.entry.version,
				integrity: inspection.entry.integrity,
			});
			const parentDigest = await requireActiveBundleDigest(dependencies);
			if (Object.keys(preview.grantsByComponent).length > 0) {
				if (await packGrantsNeedConfirmation(dependencies.paths)) {
					if (
						!(await confirmExtensionMutation(
							ctx,
							"Approve executable pack capability budgets",
							formatPackCapabilityGrantPreview(preview),
						))
					) {
						ctx.ui.notify("Pack install cancelled before staging", "info");
						return;
					}
				} else {
					sendCustomCard(pi, "evo.pack-grants", formatPackCapabilityGrantPreview(preview), {
						pack: inspection.entry.name,
						approval: "auto",
					});
				}
			}
			let unknownAbiResults: UnknownAbiBuilderCycleResult[] = [];
			const result = await discovery.install({
				name: inspection.entry.name,
				version: inspection.entry.version,
				expectedIntegrity: inspection.entry.integrity,
				paths: dependencies.paths,
				parentDigest,
				grantsByComponent: preview.grantsByComponent,
				beforeStage: async ({ preflight }) => {
					unknownAbiResults = await stageUnknownPackAbis(dependencies, parentDigest, preflight.unknownAbiRequests);
				},
			});
			sendCustomCard(pi, "evo.pack-install", formatRegistryPackInstallResult(result, unknownAbiResults), {
				pack: result.imported.manifest.name,
				version: result.imported.manifest.version,
				integrity: result.imported.manifest.integrity,
			});
			return;
		}
		case "import": {
			const packDirectory = requireValue(rest, "/evo import <directory>");
			const parentDigest = await requireActiveBundleDigest(dependencies);
			const preview = await previewPackCapabilityGrants(
				packDirectory,
				dependencies.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined),
				dependencies.spawnAgentToolNames ?? DEFAULT_SPAWN_AGENT_TOOL_NAMES,
			);
			if (Object.keys(preview.grantsByComponent).length > 0) {
				if (await packGrantsNeedConfirmation(dependencies.paths)) {
					if (
						!(await confirmExtensionMutation(
							ctx,
							"Approve executable pack capability budgets",
							formatPackCapabilityGrantPreview(preview),
						))
					) {
						ctx.ui.notify("Pack import cancelled before staging", "info");
						return;
					}
				} else {
					sendCustomCard(pi, "evo.pack-grants", formatPackCapabilityGrantPreview(preview), {
						pack: preview.manifest.name,
						approval: "auto",
					});
				}
			}
			let unknownAbiResults: UnknownAbiBuilderCycleResult[] = [];
			const result = await stagePackImport(
				dependencies,
				packDirectory,
				preview.integrity,
				preview.grantsByComponent,
				parentDigest,
				async (preflight) => {
					unknownAbiResults = await stageUnknownPackAbis(dependencies, parentDigest, preflight.unknownAbiRequests);
				},
			);
			sendCustomCard(pi, "evo.pack-import", formatPackImportResult(result, unknownAbiResults), {
				pack: result.manifest.name,
				integrity: result.manifest.integrity,
			});
			return;
		}
		case "export": {
			const result = await exportActiveBundle(dependencies, requireValue(rest, "/evo export <directory>"));
			sendCustomCard(pi, "evo.pack-export", formatPackExportResult(result), {
				bundleDigest: result.bundleDigest,
				integrity: result.manifest.integrity,
			});
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
		// "workflow" is a deprecated alias: the evolution playbook is unrelated to
		// workflow components, which live under "workflows" and "packs".
		case "workflow":
		case "playbook": {
			if (rest === "reset") await resetEvolutionWorkflow(dependencies.paths);
			else if (rest) throw new Error("Usage: /evo playbook [reset]");
			const playbook = await readEvolutionWorkflow(dependencies.paths);
			sendCustomCard(pi, "evo.playbook", playbook, { path: dependencies.paths.workflow });
			return;
		}
		case "workflows": {
			sendCustomCard(pi, "evo.workflows", await formatActiveWorkflows(dependencies), {});
			return;
		}
		case "packs": {
			const parts = rest.split(/\s+/).filter(Boolean);
			if (parts.length === 0) {
				sendCustomCard(pi, "evo.packs", formatWorkflowPackTemplates(), {});
				return;
			}
			if (parts[0] !== "init") throw new Error("Usage: /evo packs [init <template> [directory]]");
			sendCustomCard(pi, "evo.packs", await initWorkflowPackTemplate(parts[1] ?? "", parts[2]), {
				template: parts[1],
			});
			return;
		}
		case "config": {
			const parts = rest.split(/\s+/).filter(Boolean);
			if (parts[0] === "set") {
				const key = parts[1];
				const value = parts.slice(2).join(" ");
				if (!key || !value) throw new Error("Usage: /evo config set <key> <value>");
				await updateEvoControlConfigValue(dependencies.paths, key, value);
				ctx.ui.notify(`Config updated: ${key} = ${value}`, "info");
				return;
			}
			if (parts.length > 0) throw new Error("Usage: /evo config [set <key> <value>]");
			sendCustomCard(pi, "evo.config", await formatControlConfig(dependencies.paths), {});
			return;
		}
		case "inbox": {
			sendCustomCard(pi, "evo.inbox", await formatInboxListing(dependencies.paths), {});
			return;
		}
		case "usage": {
			sendCustomCard(pi, "evo.usage", await formatUsageSummary(dependencies.paths, rest), {});
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
					ctx.ui.setStatusItems("evo", undefined);
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
			ctx.ui.setStatusItems("evo", undefined);
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
						ctx.ui.setStatusItems("evo", undefined);
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
						ctx.ui.setStatusItems("evo", undefined);
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
		case "search": {
			const discovery = await dependencies.getDiscoveryService();
			const results = await discovery.search({
				...(rest ? { query: rest } : {}),
				limit: DISCOVERY_SEARCH_LIMIT,
				includeTrustedManifests: true,
			});
			io.write(formatPackSearchResults(results));
			return;
		}
		case "install": {
			requireArgumentCount(args, 2, 3, "evo-pi install <name> [version]");
			const selection = parsePackSelection(args.slice(1).join(" "), "evo-pi install <name> [version]");
			const discovery = await dependencies.getDiscoveryService();
			const inspection = await discovery.inspect(selection.name, selection.version);
			const preview = createPackCapabilityGrantPreview(
				inspection.manifest,
				inspection.entry.integrity,
				dependencies.model,
				dependencies.spawnAgentToolNames ?? DEFAULT_SPAWN_AGENT_TOOL_NAMES,
			);
			io.write(formatPackInspection(inspection));
			const parentDigest = await requireActiveBundleDigest(dependencies);
			if (Object.keys(preview.grantsByComponent).length > 0) {
				io.write(formatPackCapabilityGrantPreview(preview));
				if (await packGrantsNeedConfirmation(dependencies.paths)) {
					if (!(await confirmLocalMutation(io, "Stage this pack with the exact capability grants shown above?"))) {
						io.write("Pack install cancelled before staging");
						return;
					}
				} else {
					io.write("Capability grants auto-approved (grants.approval is 'auto')");
				}
			}
			let unknownAbiResults: UnknownAbiBuilderCycleResult[] = [];
			const result = await discovery.install({
				name: inspection.entry.name,
				version: inspection.entry.version,
				expectedIntegrity: inspection.entry.integrity,
				paths: dependencies.paths,
				parentDigest,
				grantsByComponent: preview.grantsByComponent,
				beforeStage: async ({ preflight }) => {
					unknownAbiResults = await stageUnknownPackAbis(dependencies, parentDigest, preflight.unknownAbiRequests);
				},
			});
			io.write(formatRegistryPackInstallResult(result, unknownAbiResults));
			return;
		}
		case "import": {
			requireArgumentCount(args, 2, 2, "evo-pi import <directory>");
			const packDirectory = requireValue(args[1] ?? "", "evo-pi import <directory>");
			const parentDigest = await requireActiveBundleDigest(dependencies);
			const preview = await previewPackCapabilityGrants(
				packDirectory,
				dependencies.model,
				dependencies.spawnAgentToolNames ?? DEFAULT_SPAWN_AGENT_TOOL_NAMES,
			);
			if (Object.keys(preview.grantsByComponent).length > 0) {
				io.write(formatPackCapabilityGrantPreview(preview));
				if (await packGrantsNeedConfirmation(dependencies.paths)) {
					if (!(await confirmLocalMutation(io, "Stage this pack with the exact capability grants shown above?"))) {
						io.write("Pack import cancelled before staging");
						return;
					}
				} else {
					io.write("Capability grants auto-approved (grants.approval is 'auto')");
				}
			}
			let unknownAbiResults: UnknownAbiBuilderCycleResult[] = [];
			const result = await stagePackImport(
				dependencies,
				packDirectory,
				preview.integrity,
				preview.grantsByComponent,
				parentDigest,
				async (preflight) => {
					unknownAbiResults = await stageUnknownPackAbis(dependencies, parentDigest, preflight.unknownAbiRequests);
				},
			);
			io.write(formatPackImportResult(result, unknownAbiResults));
			return;
		}
		case "export": {
			requireArgumentCount(args, 2, 4, "evo-pi export <directory> [name] [version]");
			io.write(
				formatPackExportResult(
					await exportActiveBundle(
						dependencies,
						requireValue(args[1] ?? "", "evo-pi export <directory> [name] [version]"),
						args[2],
						args[3],
					),
				),
			);
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
		// "workflow" is a deprecated alias for "playbook"; workflow components
		// live under "workflows" and "packs".
		case "workflow":
		case "playbook": {
			if (rest === "reset") await resetEvolutionWorkflow(dependencies.paths);
			else if (rest) throw new Error("Usage: evo-pi playbook [reset]");
			io.write(`${dependencies.paths.workflow}\n\n${await readEvolutionWorkflow(dependencies.paths)}`);
			return;
		}
		case "workflows": {
			io.write(await formatActiveWorkflows(dependencies));
			return;
		}
		case "packs": {
			const parts = rest.split(/\s+/).filter(Boolean);
			if (parts.length === 0) {
				io.write(formatWorkflowPackTemplates());
				return;
			}
			if (parts[0] !== "init") throw new Error("Usage: evo-pi packs [init <template> [directory]]");
			io.write(await initWorkflowPackTemplate(parts[1] ?? "", parts[2]));
			return;
		}
		case "config": {
			const parts = rest.split(/\s+/).filter(Boolean);
			if (parts[0] === "set") {
				const key = parts[1];
				const value = parts.slice(2).join(" ");
				if (!key || !value) throw new Error("Usage: evo-pi config set <key> <value>");
				await updateEvoControlConfigValue(dependencies.paths, key, value);
				io.write(`Config updated: ${key} = ${value}`);
				return;
			}
			if (parts.length > 0) throw new Error("Usage: evo-pi config [set <key> <value>]");
			io.write(await formatControlConfig(dependencies.paths));
			return;
		}
		case "inbox": {
			io.write(await formatInboxListing(dependencies.paths));
			return;
		}
		case "usage": {
			io.write(await formatUsageSummary(dependencies.paths, rest));
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
