import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTool, ThinkingLevel } from "@ch1nyzzz/pi-agent-core";
import {
	convertToLlm,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionContext,
	type ExtensionFactory,
	type SessionStartEvent,
	serializeConversation,
	type ToolDefinition,
} from "@ch1nyzzz/pi-coding-agent";
import { Type } from "typebox";
import { type LoadedEvoComponentArtifact, validateEvoComponentSelection } from "../components/artifact.ts";
import { EvoCapabilityBroker } from "../components/capabilities/broker.ts";
import { createFileCapabilityServices } from "../components/capabilities/host-services.ts";
import { createInferCapabilityService, createModelRegistryInferHost } from "../components/capabilities/infer.ts";
import { createMemoryCapabilityServices } from "../components/capabilities/memory.ts";
import type { EvoCapabilityName } from "../components/capabilities/protocol.ts";
import type { EvoCapabilityComponentIdentity, EvoCapabilityService } from "../components/capabilities/service.ts";
import { createSpawnAgentCapabilityService } from "../components/capabilities/spawn-agent.ts";
import { createModelRegistrySpawnAgentHost } from "../components/capabilities/spawn-agent-host.ts";
import { type EvoMemoryNamespace, EvoMemoryStore, parseEvoMemoryFragmentInput } from "../components/memory/store.ts";
import {
	canUseEvoComponentSandbox,
	type EvoComponentCapabilityBroker,
	EvoComponentProcess,
	type EvoComponentProcessOptions,
} from "../components/process-runtime.ts";
import {
	COMPACTION_V1_ABI,
	CONTEXT_V1_ABI,
	CONTROL_V1_ABI,
	type CompactionV1Config,
	type CompactionV1Input,
	type CompactionV1Output,
	type ContextV1Config,
	type ContextV1Input,
	type ContextV1Output,
	type ControlV1Input,
	type ControlV1Output,
	createDefaultEvoAbiRegistry,
	type EvoAbiDefinition,
	GENERATION_V1_ABI,
	type GenerationV1Input,
	type GenerationV1Output,
	GUARD_V1_ABI,
	type GuardV1Input,
	type GuardV1Output,
	INSTRUCTIONS_V1_ABI,
	type InstructionsV1Input,
	type InstructionsV1Output,
	MEMORY_V1_ABI,
	type MemoryV1Input,
	type MemoryV1Output,
	TOOL_V1_ABI,
	type ToolV1Input,
	type ToolV1Output,
	WORKFLOW_V1_ABI,
	type WorkflowV1Input,
	type WorkflowV1Output,
} from "../components/registry.ts";
import { renderBundlePreferenceInstructions } from "../memory/preferences.ts";
import { getEvoPaths } from "../paths.ts";
import { BundleRegistry } from "../registry/registry.ts";
import { canonicalJson } from "../storage.ts";
import type { CompiledBundle, EvoComponentSelection, EvoToolSelection, EvoWorkflowSelection } from "../types.ts";
import { filterEvoCodeFeatureTools } from "./code-feature.ts";
import { loadCompiledBundle } from "./compile.ts";
import { activateEvoFeatureSession } from "./feature-gate.ts";
import {
	type ManagedRuntimeResources,
	prepareManagedRuntimeResources,
	replaceManagedHostResources,
	verifyManagedSourceSnapshots,
} from "./managed-sources.ts";
import { isDigest } from "./schema.ts";

export { createEvoFeatureHandler, guardEvoFeature, isEvoFeatureEnabled } from "./feature-gate.ts";

const BUNDLE_BEGIN = "<!-- evo-pi bundle begin -->";
const BUNDLE_END = "<!-- evo-pi bundle end -->";
const EVO_TOOL_PARAMETERS = Type.Record(Type.String(), Type.Unknown());
const DEFAULT_SPAWN_AGENT_SYSTEM_PROMPT =
	"You are an isolated child agent. Complete the requested task using only explicitly provided tools.";
const DEFAULT_SPAWN_AGENT_MAX_TURNS = 64;
/**
 * A workflow invoke spans an entire orchestration (potentially dozens of
 * sequential child-agent rounds), so it gets a far larger request timeout
 * than the single-transform invokes of the other ABIs.
 */
const WORKFLOW_INVOKE_TIMEOUT_MS = 60 * 60_000;

/**
 * Tool names offered to spawned child agents when the embedder does not supply
 * its own trusted tool set. Grant previews default their spawn-agent allowlist
 * to this same list so imported packs work against the default host.
 */
export const DEFAULT_SPAWN_AGENT_TOOL_NAMES: readonly string[] = [
	"bash",
	"edit",
	"find",
	"grep",
	"ls",
	"read",
	"write",
];

/**
 * The host's standard coding tools, rebuilt against the session cwd. The
 * `agent` tool is deliberately excluded: spawned children must not recurse.
 */
function createDefaultSpawnAgentTools(cwd: string): AgentTool[] {
	const definitions: ToolDefinition<any, any>[] = [
		createBashToolDefinition(cwd),
		createEditToolDefinition(cwd),
		createFindToolDefinition(cwd),
		createGrepToolDefinition(cwd),
		createLsToolDefinition(cwd),
		createReadToolDefinition(cwd),
		createWriteToolDefinition(cwd),
	];
	return definitions.map((definition) => ({
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		prepareArguments: definition.prepareArguments,
		executionMode: definition.executionMode,
		execute: (toolCallId, params, signal, onUpdate) =>
			definition.execute(toolCallId, params, signal, onUpdate, undefined as unknown as ExtensionContext),
	}));
}

export type RuntimeBundleSectionPlacement = "stable" | "regular" | "memory" | "dynamic";

export interface RuntimeBundleSection {
	path: string;
	content: string;
	placement: RuntimeBundleSectionPlacement;
}

export interface RuntimeBundle {
	bundle: CompiledBundle;
	systemPromptAppend: string;
	sections: readonly RuntimeBundleSection[];
	managedResources: ManagedRuntimeResources;
	skillDirectory?: string;
	enabledTools?: string[];
}

function renderRuntimeBundleSections(
	bundle: CompiledBundle,
	sections: readonly RuntimeBundleSection[],
	excludedPaths: ReadonlySet<string>,
): string {
	const content = (placement: RuntimeBundleSectionPlacement): string[] =>
		sections
			.filter((section) => section.placement === placement && !excludedPaths.has(section.path))
			.map((section) => section.content);
	return [
		BUNDLE_BEGIN,
		...content("stable"),
		`Bundle: ${bundle.digest}`,
		...content("regular"),
		...content("memory"),
		...content("dynamic"),
		BUNDLE_END,
	].join("\n\n");
}

export function renderRuntimeBundlePrompt(
	runtime: RuntimeBundle,
	excludedPaths: ReadonlySet<string> = new Set(),
): string {
	return renderRuntimeBundleSections(runtime.bundle, runtime.sections, excludedPaths);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseBundleEntry(entry: unknown): { digest: string; sessionId?: string } | undefined {
	if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== "evo.bundle" || !isRecord(entry.data)) {
		return undefined;
	}
	if (typeof entry.data.digest !== "string" || !isDigest(entry.data.digest)) return undefined;
	if ("sessionId" in entry.data && typeof entry.data.sessionId !== "string") return undefined;
	return {
		digest: entry.data.digest,
		sessionId: typeof entry.data.sessionId === "string" ? entry.data.sessionId : undefined,
	};
}

export function resolveSessionBundleDigest(
	entries: readonly unknown[],
	sessionId: string,
	reason: SessionStartEvent["reason"],
): string | undefined {
	let legacyDigest: string | undefined;
	for (let index = entries.length - 1; index >= 0; index--) {
		const bundleEntry = parseBundleEntry(entries[index]);
		if (!bundleEntry) continue;
		if (bundleEntry.sessionId === sessionId) return bundleEntry.digest;
		if (bundleEntry.sessionId === undefined && legacyDigest === undefined) legacyDigest = bundleEntry.digest;
	}
	return reason === "startup" || reason === "resume" || reason === "reload" ? legacyDigest : undefined;
}

async function listMarkdown(directory: string): Promise<string[]> {
	try {
		return (await readdir(directory, { withFileTypes: true }))
			.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
			.map((entry) => entry.name)
			.sort();
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
}

export async function renderRuntimeBundle(bundle: CompiledBundle): Promise<RuntimeBundle> {
	const promptFiles = await listMarkdown(join(bundle.directory, "prompts"));
	const orderedPaths = [
		...(bundle.policy.promptOrder ?? []),
		...promptFiles.map((file) => `prompts/${file}`).filter((path) => !bundle.policy.promptOrder?.includes(path)),
	];
	const stablePaths = new Set(bundle.policy.stablePromptPaths ?? []);
	const dynamicPaths = new Set(bundle.policy.dynamicPromptPaths ?? []);
	const sections: RuntimeBundleSection[] = [];
	for (const path of orderedPaths) {
		const content = (await readFile(join(bundle.directory, path), "utf8")).trim();
		if (!content) continue;
		const placement: RuntimeBundleSectionPlacement = stablePaths.has(path)
			? "stable"
			: dynamicPaths.has(path)
				? "dynamic"
				: "regular";
		sections.push({ path, content, placement });
	}
	const preferenceInstructions = await renderBundlePreferenceInstructions(bundle);
	if (preferenceInstructions) {
		sections.push({
			path: "memory/preferences.json",
			content: preferenceInstructions,
			placement: "memory",
		});
	}
	for (const file of await listMarkdown(join(bundle.directory, "memory"))) {
		const content = (await readFile(join(bundle.directory, "memory", file), "utf8")).trim();
		if (!content) continue;
		sections.push({
			path: `memory/${file}`,
			content: `## Remembered user context\n\n${content}`,
			placement: "memory",
		});
	}
	const skillDirectory = bundle.manifest.files.some((file) => file.path.startsWith("skills/"))
		? join(bundle.directory, "skills")
		: undefined;
	return {
		bundle,
		systemPromptAppend: renderRuntimeBundleSections(bundle, sections, new Set()),
		sections,
		managedResources: await prepareManagedRuntimeResources(bundle),
		skillDirectory,
		enabledTools: bundle.policy.enabledTools,
	};
}

export function replaceRuntimeBundlePrompt(systemPrompt: string, replacement: string): string {
	const start = systemPrompt.indexOf(BUNDLE_BEGIN);
	const end = systemPrompt.indexOf(BUNDLE_END);
	if (start === -1 || end === -1 || end < start) return `${systemPrompt}\n\n${replacement}`;
	return `${systemPrompt.slice(0, start)}${replacement}${systemPrompt.slice(end + BUNDLE_END.length)}`;
}

function resolveWorkerModel(ctx: ExtensionContext, route: string): NonNullable<ExtensionContext["model"]> {
	const separator = route.indexOf("/");
	if (separator !== -1) {
		const provider = route.slice(0, separator);
		const modelId = route.slice(separator + 1);
		const model = ctx.modelRegistry.find(provider, modelId);
		if (!model) throw new Error(`Evo-Pi worker model does not exist: ${route}`);
		return model;
	}
	const matches = ctx.modelRegistry.getAll().filter((model) => model.id === route);
	if (matches.length === 0) throw new Error(`Evo-Pi worker model does not exist: ${route}`);
	if (matches.length > 1) {
		throw new Error(`Evo-Pi worker model id is ambiguous: ${route}`);
	}
	return matches[0];
}

interface PreparedRuntimeComponent<TInput, TOutput, TConfig> {
	artifact: LoadedEvoComponentArtifact;
	abi: EvoAbiDefinition<TInput, TOutput, TConfig>;
	config: TConfig;
	processOptions: EvoComponentProcessOptions;
	memoryNamespace?: EvoMemoryNamespace;
}

export interface EvoPolicyRuntimeOptions {
	root?: string;
	componentSandbox?: boolean;
	/** Trusted, pre-constructed tools available to isolated spawned agents. */
	spawnAgentTools?: readonly AgentTool[];
	/** Fixed prompt for isolated spawned agents. */
	spawnAgentSystemPrompt?: string;
	/** Hard provider-turn limit for one isolated spawned-agent run. */
	spawnAgentMaxTurns?: number;
	/**
	 * Trusted host adapters supplied by the embedding extension. Built-in
	 * workspace file, infer, spawn-agent, and component-memory services are
	 * merged around these adapters; memory adapters cannot be replaced.
	 */
	capabilityServices?: Partial<Record<EvoCapabilityName, EvoCapabilityService>>;
}

function isSupportedAgentMessage(value: unknown): boolean {
	if (!isRecord(value) || typeof value.role !== "string") return false;
	return ["user", "assistant", "toolResult", "bashExecution", "custom", "branchSummary", "compactionSummary"].includes(
		value.role,
	);
}

function resolveThinkingLevel(value: string): ThinkingLevel {
	switch (value) {
		case "off":
		case "minimal":
		case "low":
		case "medium":
		case "high":
		case "xhigh":
		case "max":
			return value;
		default:
			throw new Error(`Unsupported reasoning level: ${value}`);
	}
}

function componentIdentity(
	artifact: LoadedEvoComponentArtifact,
	abi: { capabilityCeiling: readonly string[] },
): EvoCapabilityComponentIdentity {
	return {
		id: artifact.manifest.id,
		abi: artifact.manifest.abi,
		artifactDigest: artifact.manifest.artifactDigest,
		declaredCapabilities: artifact.manifest.capabilities,
		abiCapabilityCeiling: abi.capabilityCeiling,
	};
}

const MEMORY_NAMESPACE_CAPABILITIES = new Set<EvoCapabilityName>(["memory-read", "memory-write", "retrieve"]);

function persistedGrantCapabilities(selection: EvoComponentSelection): Set<EvoCapabilityName> {
	return new Set((selection.grants ?? []).map((grant) => grant.capability));
}

function usesGrantedComponentMemory(surface: string, selection: EvoComponentSelection): boolean {
	const granted = persistedGrantCapabilities(selection);
	if (surface === "memory" && (!granted.has("memory-read") || !granted.has("memory-write"))) {
		throw new Error("memory/v1 requires persisted memory-read and memory-write grants for its full lifecycle");
	}
	return [...granted].some((capability) => MEMORY_NAMESPACE_CAPABILITIES.has(capability));
}

async function prepareMemoryNamespace(
	paths: ReturnType<typeof getEvoPaths>,
	registry: BundleRegistry,
	bundle: CompiledBundle,
	artifact: LoadedEvoComponentArtifact,
): Promise<EvoMemoryNamespace> {
	const store = new EvoMemoryStore({
		paths,
		componentId: artifact.manifest.id,
		artifactDigest: artifact.manifest.artifactDigest,
	});
	return registry.withMemoryLifecycle(async ({ stableDigest, trial, verifiedBundleLineage }) => {
		if (stableDigest !== bundle.digest) {
			throw new Error(`Bundle ${bundle.digest} is no longer active while preparing component memory`);
		}
		if (verifiedBundleLineage[0] !== bundle.digest) {
			throw new Error(`Bundle ${bundle.digest} does not match the registry-verified active lineage`);
		}
		if (trial?.digest === bundle.digest) {
			if (verifiedBundleLineage[1] !== trial.parent) {
				throw new Error(`Trial parent ${trial.parent} does not match the registry-verified active lineage`);
			}
			await store.materializeStableForBundle({
				targetBundleDigest: trial.parent,
				targetAncestorBundleDigests: verifiedBundleLineage.slice(2),
			});
			return store.beginTrial({ parentBundleDigest: trial.parent, trialBundleDigest: bundle.digest });
		}
		return store.materializeStableForBundle({
			targetBundleDigest: bundle.digest,
			targetAncestorBundleDigests: verifiedBundleLineage.slice(1),
		});
	});
}

async function applyMemoryFragment(
	namespace: EvoMemoryNamespace,
	operation: "append" | "update",
	value: unknown,
	expectedStateDigest?: string,
): Promise<void> {
	const fragment = parseEvoMemoryFragmentInput(value);
	if (operation === "append") await namespace.append(fragment, expectedStateDigest);
	else await namespace.update(fragment, expectedStateDigest);
}

async function upsertMemoryFragments(
	namespace: EvoMemoryNamespace,
	values: readonly Record<string, unknown>[],
): Promise<void> {
	const state = await namespace.read();
	const known = new Set(state.fragments.map((fragment) => fragment.id));
	for (const value of values) {
		const fragment = parseEvoMemoryFragmentInput(value);
		if (known.has(fragment.id)) await namespace.update(fragment);
		else {
			await namespace.append(fragment);
			known.add(fragment.id);
		}
	}
}

async function applyMemoryComponentOutput(namespace: EvoMemoryNamespace, output: MemoryV1Output): Promise<void> {
	if (output.mode === "recall") return;
	if (output.mode === "encode") {
		for (const fragment of output.writes) await applyMemoryFragment(namespace, "append", fragment);
		for (const fragment of output.updates) await applyMemoryFragment(namespace, "update", fragment);
		for (const id of output.forgets) await namespace.forget(id);
		return;
	}
	await upsertMemoryFragments(namespace, [...output.merged, ...output.insights]);
	for (const id of output.forget) await namespace.forget(id);
}

function requireExpectedStateDigest(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !isDigest(value)) {
		throw new Error("control/v1 memory delta expectedStateDigest must be a sha256 digest");
	}
	return value;
}

async function applyControlMemoryDeltas(
	namespace: EvoMemoryNamespace,
	deltas: readonly Record<string, unknown>[],
): Promise<void> {
	for (const [index, delta] of deltas.entries()) {
		const label = `control/v1 memoryDeltas[${index}]`;
		const operation = delta.operation;
		const allowed =
			operation === "forget"
				? new Set(["operation", "id", "expectedStateDigest"])
				: new Set(["operation", "fragment", "expectedStateDigest"]);
		for (const key of Object.keys(delta)) {
			if (!allowed.has(key)) throw new Error(`${label} has unknown key: ${key}`);
		}
		const expectedStateDigest = requireExpectedStateDigest(delta.expectedStateDigest);
		if (operation === "append" || operation === "update") {
			await applyMemoryFragment(namespace, operation, delta.fragment, expectedStateDigest);
			continue;
		}
		if (operation !== "forget") {
			throw new Error(`${label}.operation must be 'append', 'update', or 'forget'`);
		}
		if (typeof delta.id !== "string") throw new Error(`${label}.id must be a string`);
		await namespace.forget(delta.id, expectedStateDigest);
	}
}

export function createPolicyRuntimeExtension(options: EvoPolicyRuntimeOptions = {}): ExtensionFactory {
	const paths = getEvoPaths(options.root);
	const registry = new BundleRegistry(paths);
	return (pi) => {
		let pinned: RuntimeBundle | undefined;
		let activeToolsBeforeBundle: string[] | undefined;
		let activeModelBeforeBundle: ExtensionContext["model"];
		let clearFeatureSession: (() => void) | undefined;
		let compactionProcess: EvoComponentProcess<CompactionV1Input, CompactionV1Output, CompactionV1Config> | undefined;
		let contextProcess: EvoComponentProcess<ContextV1Input, ContextV1Output, ContextV1Config> | undefined;
		let guardProcess: EvoComponentProcess<GuardV1Input, GuardV1Output, Record<string, never>> | undefined;
		let controlProcess: EvoComponentProcess<ControlV1Input, ControlV1Output, Record<string, never>> | undefined;
		let controlMemoryNamespace: EvoMemoryNamespace | undefined;
		let memoryProcess: EvoComponentProcess<MemoryV1Input, MemoryV1Output, Record<string, never>> | undefined;
		let memoryNamespace: EvoMemoryNamespace | undefined;
		const toolProcesses = new Map<string, EvoComponentProcess<ToolV1Input, ToolV1Output, Record<string, never>>>();
		const workflowComponents = new Map<
			string,
			PreparedRuntimeComponent<WorkflowV1Input, WorkflowV1Output, Record<string, never>>
		>();
		const registeredEvoToolNames = new Set<string>();
		const registeredEvoWorkflowCommands = new Set<string>();
		let instructionsComponent:
			| PreparedRuntimeComponent<InstructionsV1Input, InstructionsV1Output, Record<string, never>>
			| undefined;
		let generationComponent:
			| PreparedRuntimeComponent<GenerationV1Input, GenerationV1Output, Record<string, never>>
			| undefined;
		const activeTurnProcesses = new Set<{ shutdown(): Promise<void> }>();
		let guardInvocationTail = Promise.resolve();
		let memoryInvocationTail = Promise.resolve();

		async function stopComponentProcesses(): Promise<void> {
			const processes = [
				compactionProcess,
				contextProcess,
				guardProcess,
				controlProcess,
				memoryProcess,
				...toolProcesses.values(),
				...activeTurnProcesses,
			].filter((process): process is { shutdown(): Promise<void> } => process !== undefined);
			compactionProcess = undefined;
			contextProcess = undefined;
			guardProcess = undefined;
			controlProcess = undefined;
			controlMemoryNamespace = undefined;
			memoryProcess = undefined;
			memoryNamespace = undefined;
			toolProcesses.clear();
			workflowComponents.clear();
			instructionsComponent = undefined;
			generationComponent = undefined;
			activeTurnProcesses.clear();
			guardInvocationTail = Promise.resolve();
			memoryInvocationTail = Promise.resolve();
			await Promise.all(processes.map(async (process) => process.shutdown()));
		}

		async function prepareComponent<TInput, TOutput, TConfig>(
			surface: string,
			selection: EvoComponentSelection,
			abi: EvoAbiDefinition<TInput, TOutput, TConfig>,
			bundle: CompiledBundle,
			ctx: ExtensionContext,
		): Promise<PreparedRuntimeComponent<TInput, TOutput, TConfig>> {
			const abiRegistry = createDefaultEvoAbiRegistry();
			const artifact = await validateEvoComponentSelection(paths, surface, selection, abiRegistry);
			const config = abi.validateConfig(selection.config ?? {});
			let sandboxOptions: Pick<EvoComponentProcessOptions, "sandbox"> = {};
			if (options.componentSandbox === false) {
				sandboxOptions = { sandbox: false };
			} else if (!(await canUseEvoComponentSandbox())) {
				if (!ctx.hasUI) {
					throw new Error(
						"Component sandbox is unavailable and direct execution requires one-time user permission",
					);
				}
				const allowDirect = await ctx.ui.confirm(
					"One-time component permission",
					`The OS sandbox is unavailable. Allow ${selection.id} (${selection.artifactDigest.slice(0, 12)}) to run directly with your user permissions for this session only?`,
				);
				if (!allowDirect) throw new Error("User declined one-time direct component execution");
				sandboxOptions = { sandbox: false };
			}
			const usesMemory = usesGrantedComponentMemory(surface, selection);
			const componentMemory = usesMemory
				? await prepareMemoryNamespace(paths, registry, bundle, artifact)
				: undefined;
			const services: Partial<Record<EvoCapabilityName, EvoCapabilityService>> = {
				...createFileCapabilityServices({
					readRoots: { workspace: ctx.cwd, bundle: bundle.directory },
					writeRoots: { workspace: ctx.cwd },
				}),
				infer: createInferCapabilityService(createModelRegistryInferHost(ctx.modelRegistry)),
				"spawn-agent": createSpawnAgentCapabilityService(
					createModelRegistrySpawnAgentHost({
						modelRegistry: ctx.modelRegistry,
						tools: options.spawnAgentTools ?? createDefaultSpawnAgentTools(ctx.cwd),
						systemPrompt: options.spawnAgentSystemPrompt ?? DEFAULT_SPAWN_AGENT_SYSTEM_PROMPT,
						maxTurns: options.spawnAgentMaxTurns ?? DEFAULT_SPAWN_AGENT_MAX_TURNS,
					}),
				),
				...options.capabilityServices,
				...(componentMemory ? createMemoryCapabilityServices(componentMemory) : {}),
			};
			const capabilityBroker = new EvoCapabilityBroker({ paths, services });
			const identity = componentIdentity(artifact, abi);
			const authorityId = await capabilityBroker.replaceComponentGrants(identity, selection.grants ?? []);
			const scopedCapabilityBroker: EvoComponentCapabilityBroker = {
				request(component, frame, signal) {
					return capabilityBroker.request(authorityId, component, frame, signal);
				},
			};
			return {
				artifact,
				abi,
				config,
				processOptions: {
					...sandboxOptions,
					capabilityBroker: scopedCapabilityBroker,
					...(surface === "workflow" ? { requestTimeoutMs: WORKFLOW_INVOKE_TIMEOUT_MS } : {}),
				},
				...(componentMemory ? { memoryNamespace: componentMemory } : {}),
			};
		}

		async function startSessionComponent<TInput, TOutput, TConfig>(
			component: PreparedRuntimeComponent<TInput, TOutput, TConfig>,
		): Promise<EvoComponentProcess<TInput, TOutput, TConfig>> {
			const process = new EvoComponentProcess(
				component.artifact,
				component.abi,
				component.config,
				component.processOptions,
			);
			await process.start();
			return process;
		}

		async function invokeTurnComponent<TInput, TOutput, TConfig>(
			component: PreparedRuntimeComponent<TInput, TOutput, TConfig>,
			input: TInput,
		): Promise<TOutput> {
			const process = new EvoComponentProcess(
				component.artifact,
				component.abi,
				component.config,
				component.processOptions,
			);
			activeTurnProcesses.add(process);
			try {
				return await process.invoke(input);
			} finally {
				activeTurnProcesses.delete(process);
				await process.shutdown();
			}
		}

		function registerToolComponent(
			selection: EvoToolSelection,
			process: EvoComponentProcess<ToolV1Input, ToolV1Output, Record<string, never>>,
		): void {
			toolProcesses.set(selection.id, process);
			if (!registeredEvoToolNames.has(selection.id) && pi.getAllTools().some((tool) => tool.name === selection.id)) {
				throw new Error(`Evo tool name conflicts with an existing host tool: ${selection.id}`);
			}
			registeredEvoToolNames.add(selection.id);
			pi.registerTool({
				name: selection.id,
				label: selection.id,
				description: `Sandboxed Evo tool component ${selection.id}. Parameters are passed as a JSON object.`,
				parameters: EVO_TOOL_PARAMETERS,
				executionMode: "sequential",
				async execute(_toolCallId, params, signal) {
					const active = toolProcesses.get(selection.id);
					if (!active || active !== process) {
						throw new Error(`Evo tool component is not active: ${selection.id}`);
					}
					let abortError: Error | undefined;
					let abortTermination: Promise<void> | undefined;
					const abort = (): void => {
						toolProcesses.delete(selection.id);
						abortError =
							signal?.reason instanceof Error ? signal.reason : new Error("Evo tool execution aborted");
						abortTermination ??= active.terminate(abortError);
						void abortTermination.catch(() => undefined);
					};
					signal?.addEventListener("abort", abort, { once: true });
					if (signal?.aborted) abort();
					try {
						if (abortTermination) {
							await abortTermination;
							throw abortError ?? new Error("Evo tool execution aborted");
						}
						return await active.invoke({ params });
					} catch (error) {
						toolProcesses.delete(selection.id);
						if (abortTermination) await abortTermination;
						else await active.shutdown();
						throw error;
					} finally {
						signal?.removeEventListener("abort", abort);
					}
				},
			});
		}

		function registerWorkflowComponent(
			selection: EvoWorkflowSelection,
			component: PreparedRuntimeComponent<WorkflowV1Input, WorkflowV1Output, Record<string, never>>,
		): void {
			const command = selection.trigger.slice(1);
			if (
				!registeredEvoWorkflowCommands.has(command) &&
				pi.getCommands().some((candidate) => candidate.name === command)
			) {
				throw new Error(`Evo workflow trigger conflicts with an existing command: ${selection.trigger}`);
			}
			registeredEvoWorkflowCommands.add(command);
			workflowComponents.set(selection.trigger, component);
			const spawnGrant = (selection.grants ?? []).find((grant) => grant.capability === "spawn-agent");
			const host =
				spawnGrant && "models" in spawnGrant
					? {
							...(spawnGrant.models[0] ? { model: spawnGrant.models[0] } : {}),
							tools: [...(spawnGrant.tools ?? [])],
							maxOutputTokensPerCall: spawnGrant.maxOutputTokensPerCall,
						}
					: undefined;
			pi.registerCommand(command, {
				description: `Run sandboxed Evo workflow ${selection.id}`,
				async handler(args) {
					const active = workflowComponents.get(selection.trigger);
					if (!active || active !== component) {
						throw new Error(`Evo workflow is not active: ${selection.trigger}`);
					}
					const output = await invokeTurnComponent(active, {
						trigger: selection.trigger,
						args: { text: args },
						...(host ? { host } : {}),
					});
					pi.sendMessage(
						{
							customType: "evo.workflow-result",
							content: canonicalJson(output.result),
							display: true,
							details: {
								id: selection.id,
								trigger: selection.trigger,
								result: output.result,
							},
						},
						{ triggerTurn: false },
					);
				},
			});
		}

		async function invokeGuard(input: GuardV1Input): Promise<GuardV1Output | undefined> {
			const process = guardProcess;
			if (!process) return undefined;
			const invocation = guardInvocationTail.then(async () => process.invoke(input));
			guardInvocationTail = invocation.then(
				() => undefined,
				() => undefined,
			);
			return invocation;
		}

		async function invokeMemory(input: MemoryV1Input): Promise<MemoryV1Output | undefined> {
			const process = memoryProcess;
			if (!process) return undefined;
			const invocation = memoryInvocationTail.then(async () => process.invoke(input));
			memoryInvocationTail = invocation.then(
				() => undefined,
				() => undefined,
			);
			return invocation;
		}

		function clearActiveFeatures(): void {
			clearFeatureSession?.();
			clearFeatureSession = undefined;
		}

		function restoreActiveTools(): void {
			if (activeToolsBeforeBundle === undefined) return;
			try {
				pi.setActiveTools(activeToolsBeforeBundle);
			} finally {
				activeToolsBeforeBundle = undefined;
			}
		}

		async function restoreActiveModel(): Promise<void> {
			if (activeModelBeforeBundle === undefined) return;
			const restored = await pi.setModel(activeModelBeforeBundle);
			if (!restored) throw new Error("Evo-Pi could not restore the model active before bundle routing");
			activeModelBeforeBundle = undefined;
		}

		pi.on("session_start", async (event, ctx) => {
			pinned = undefined;
			clearActiveFeatures();
			await stopComponentProcesses();
			try {
				restoreActiveTools();
				await restoreActiveModel();
				activeToolsBeforeBundle = [...pi.getActiveTools()];
				const sessionId = ctx.sessionManager.getSessionId();
				const recordedDigest = resolveSessionBundleDigest(ctx.sessionManager.getEntries(), sessionId, event.reason);
				const digest = recordedDigest ?? (await registry.readStableDigest());
				if (!digest) {
					pi.setActiveTools(filterEvoCodeFeatureTools(activeToolsBeforeBundle, [], { root: paths.root }));
					return;
				}
				const compiledBundle = await loadCompiledBundle(paths, digest);
				await verifyManagedSourceSnapshots(compiledBundle.policy.managedSources ?? []);
				const runtimeBundle = await renderRuntimeBundle(compiledBundle);
				const components = compiledBundle.policy.components ?? {};
				const compactionSelection = components.compaction;
				if (compactionSelection) {
					compactionProcess = await startSessionComponent(
						await prepareComponent("compaction", compactionSelection, COMPACTION_V1_ABI, compiledBundle, ctx),
					);
				}
				const contextSelection = components.context;
				if (contextSelection) {
					contextProcess = await startSessionComponent(
						await prepareComponent("context", contextSelection, CONTEXT_V1_ABI, compiledBundle, ctx),
					);
				}
				const guardSelection = components.guard;
				if (guardSelection) {
					guardProcess = await startSessionComponent(
						await prepareComponent("guard", guardSelection, GUARD_V1_ABI, compiledBundle, ctx),
					);
				}
				const instructionsSelection = components.instructions;
				if (instructionsSelection) {
					instructionsComponent = await prepareComponent(
						"instructions",
						instructionsSelection,
						INSTRUCTIONS_V1_ABI,
						compiledBundle,
						ctx,
					);
				}
				const generationSelection = components.generation;
				if (generationSelection) {
					generationComponent = await prepareComponent(
						"generation",
						generationSelection,
						GENERATION_V1_ABI,
						compiledBundle,
						ctx,
					);
				}
				const controlSelection = components.control;
				if (controlSelection) {
					const prepared = await prepareComponent(
						"control",
						controlSelection,
						CONTROL_V1_ABI,
						compiledBundle,
						ctx,
					);
					controlMemoryNamespace = persistedGrantCapabilities(controlSelection).has("memory-write")
						? prepared.memoryNamespace
						: undefined;
					controlProcess = await startSessionComponent(prepared);
				}
				const memorySelection = components.memory;
				if (memorySelection) {
					const prepared = await prepareComponent("memory", memorySelection, MEMORY_V1_ABI, compiledBundle, ctx);
					if (!prepared.memoryNamespace) {
						throw new Error("memory/v1 component did not receive a host-owned memory namespace");
					}
					memoryNamespace = prepared.memoryNamespace;
					memoryProcess = await startSessionComponent(prepared);
				}
				for (const selection of compiledBundle.policy.tools ?? []) {
					const process = await startSessionComponent(
						await prepareComponent("tool", selection, TOOL_V1_ABI, compiledBundle, ctx),
					);
					registerToolComponent(selection, process);
				}
				for (const selection of compiledBundle.policy.workflows ?? []) {
					registerWorkflowComponent(
						selection,
						await prepareComponent("workflow", selection, WORKFLOW_V1_ABI, compiledBundle, ctx),
					);
				}
				if (recordedDigest === undefined) pi.appendEntry("evo.bundle", { digest, sessionId });
				const workerRoute = runtimeBundle.bundle.policy.modelRouting?.worker;
				if (workerRoute) {
					const originalModel = ctx.model;
					if (!originalModel)
						throw new Error("Evo-Pi cannot route a worker model without a current model to restore");
					const workerModel = resolveWorkerModel(ctx, workerRoute);
					activeModelBeforeBundle = originalModel;
					if (!(await pi.setModel(workerModel))) {
						throw new Error(`Evo-Pi worker model is unavailable: ${workerRoute}`);
					}
				}
				clearFeatureSession = activateEvoFeatureSession(runtimeBundle.bundle.policy.enabledFeatures ?? [], {
					root: paths.root,
					sessionId,
				});
				pi.setActiveTools(
					filterEvoCodeFeatureTools(
						runtimeBundle.enabledTools ?? [
							...new Set([
								...activeToolsBeforeBundle,
								...(compiledBundle.policy.tools ?? []).map((tool) => tool.id),
							]),
						],
						runtimeBundle.bundle.policy.enabledFeatures ?? [],
						{ root: paths.root },
					),
				);
				pinned = runtimeBundle;
			} catch (error) {
				pinned = undefined;
				clearActiveFeatures();
				const detail = error instanceof Error ? error.message : String(error);
				let recoveryError: unknown;
				try {
					await stopComponentProcesses();
				} catch (shutdownError) {
					recoveryError = shutdownError;
				}
				try {
					pi.setActiveTools([]);
				} catch (disableError) {
					recoveryError ??= disableError;
				}
				try {
					await restoreActiveModel();
				} catch (modelError) {
					recoveryError ??= modelError;
				}
				if (recoveryError !== undefined) {
					const recoveryDetail = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
					ctx.ui.notify(`Evo-Pi bundle failed and recovery was incomplete: ${detail}; ${recoveryDetail}`, "error");
					throw new Error("Evo-Pi could not fail closed after bundle activation failed", { cause: recoveryError });
				}
				ctx.ui.notify(`Evo-Pi bundle disabled with all tools blocked: ${detail}`, "error");
			}
		});

		pi.on("session_shutdown", async () => {
			try {
				try {
					restoreActiveTools();
				} finally {
					try {
						await restoreActiveModel();
					} finally {
						try {
							clearActiveFeatures();
						} finally {
							await stopComponentProcesses();
						}
					}
				}
			} finally {
				pinned = undefined;
			}
		});

		pi.on("session_before_compact", async (event, ctx) => {
			const activeContextProcess = contextProcess;
			if (activeContextProcess && !compactionProcess && pinned) {
				try {
					const { preparation } = event;
					const conversation = serializeConversation(
						convertToLlm([...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]),
					);
					const result = await activeContextProcess.invoke({
						mode: "checkpoint",
						conversation,
						...(preparation.previousSummary ? { previousSummary: preparation.previousSummary } : {}),
						firstKeptEntryId: preparation.firstKeptEntryId,
						tokensBefore: preparation.tokensBefore,
						reason: event.reason,
						...(event.customInstructions ? { customInstructions: event.customInstructions } : {}),
					});
					if ("messages" in result) {
						throw new Error("context/v1 checkpoint returned a transform result");
					}
					if (result.firstKeptEntryId !== preparation.firstKeptEntryId) {
						throw new Error("context/v1 checkpoint changed the prepared kept-message boundary");
					}
					return {
						compaction: {
							summary: result.summary,
							firstKeptEntryId: result.firstKeptEntryId,
							tokensBefore: preparation.tokensBefore,
							details: {
								abi: CONTEXT_V1_ABI.id,
								componentId: pinned.bundle.policy.components?.context?.id,
								artifactDigest: pinned.bundle.policy.components?.context?.artifactDigest,
								...(result.metrics ? { metrics: result.metrics } : {}),
								...(result.details === undefined ? {} : { componentDetails: result.details }),
							},
						},
					};
				} catch (error) {
					const detail = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Evo-Pi context checkpoint failed; using default compaction: ${detail}`, "warning");
					contextProcess = undefined;
					await activeContextProcess.shutdown();
					return undefined;
				}
			}
			const process = compactionProcess;
			if (!process || !pinned) return undefined;
			try {
				const { preparation } = event;
				const conversation = serializeConversation(
					convertToLlm([...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]),
				);
				const result = await process.invoke({
					conversation,
					...(preparation.previousSummary ? { previousSummary: preparation.previousSummary } : {}),
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
					reason: event.reason,
					...(event.customInstructions ? { customInstructions: event.customInstructions } : {}),
				});
				if (result.firstKeptEntryId !== preparation.firstKeptEntryId) {
					throw new Error("compaction/v1 component changed the prepared kept-message boundary");
				}
				return {
					compaction: {
						summary: result.summary,
						firstKeptEntryId: result.firstKeptEntryId,
						tokensBefore: preparation.tokensBefore,
						details: {
							abi: COMPACTION_V1_ABI.id,
							componentId: pinned.bundle.policy.components?.compaction?.id,
							artifactDigest: pinned.bundle.policy.components?.compaction?.artifactDigest,
							...(result.metrics ? { metrics: result.metrics } : {}),
							...(result.details === undefined ? {} : { componentDetails: result.details }),
						},
					},
				};
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Evo-Pi compaction component failed; using default compaction: ${detail}`, "warning");
				compactionProcess = undefined;
				await process.shutdown();
				return undefined;
			}
		});

		pi.on("context", async (event, ctx) => {
			const process = contextProcess;
			if (!process || !pinned) return undefined;
			try {
				const usage = ctx.getContextUsage();
				const result = await process.invoke({
					mode: "transform",
					messages: event.messages,
					...(typeof usage?.tokens === "number" ? { tokenEstimate: usage.tokens } : {}),
					...(usage ? { contextWindow: usage.contextWindow } : {}),
					...(ctx.model ? { model: `${ctx.model.provider}/${ctx.model.id}` } : {}),
					reason: "turn",
				});
				if (!("messages" in result)) {
					throw new Error("context/v1 transform returned a checkpoint result");
				}
				if (result.messages.some((message) => !isSupportedAgentMessage(message))) {
					throw new Error("context/v1 transform returned an unsupported AgentMessage");
				}
				return { messages: result.messages as typeof event.messages };
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Evo-Pi context component failed; using the original messages: ${detail}`, "warning");
				contextProcess = undefined;
				await process.shutdown();
				return undefined;
			}
		});

		pi.on("tool_call", async (event, ctx) => {
			const process = guardProcess;
			if (!process || !pinned) return undefined;
			try {
				const result = await invokeGuard({
					mode: "before",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.input,
				});
				if (!result || result.mode !== "before") {
					throw new Error("guard/v1 before invocation returned an after result");
				}
				if (result.args) {
					const mutableInput = event.input as Record<string, unknown>;
					for (const key of Object.keys(mutableInput)) delete mutableInput[key];
					Object.assign(mutableInput, result.args);
				}
				return {
					...(result.block === undefined ? {} : { block: result.block }),
					...(result.reason === undefined ? {} : { reason: result.reason }),
				};
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Evo-Pi guard component failed; blocking the tool call: ${detail}`, "error");
				guardProcess = undefined;
				await process.shutdown();
				return { block: true, reason: `Evo-Pi guard failed closed: ${detail}` };
			}
		});

		pi.on("tool_result", async (event, ctx) => {
			const process = guardProcess;
			if (!process || !pinned) return undefined;
			try {
				const result = await invokeGuard({
					mode: "after",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.input,
					content: event.content,
					...(event.details === undefined ? {} : { details: event.details }),
					isError: event.isError,
				});
				if (!result || result.mode !== "after") {
					throw new Error("guard/v1 after invocation returned a before result");
				}
				return {
					...(result.content === undefined ? {} : { content: result.content as typeof event.content }),
					...(result.details === undefined ? {} : { details: result.details }),
					...(result.isError === undefined ? {} : { isError: result.isError }),
					...(result.terminate === undefined ? {} : { terminate: result.terminate }),
				};
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(
					`Evo-Pi guard component failed after tool execution; terminating the batch: ${detail}`,
					"error",
				);
				guardProcess = undefined;
				await process.shutdown();
				return {
					content: [{ type: "text", text: `Evo-Pi guard failed closed after tool execution: ${detail}` }],
					isError: true,
					terminate: true,
				};
			}
		});

		pi.on("prepare_next_turn", async (event, ctx) => {
			const activeMemoryProcess = memoryProcess;
			const activeMemoryNamespace = memoryNamespace;
			if (activeMemoryProcess && activeMemoryNamespace && pinned) {
				try {
					const usage = ctx.getContextUsage();
					const result = await invokeMemory({
						mode: "encode",
						turnDigest: {
							turnIndex: event.turnIndex,
							message: event.message,
							toolResults: event.toolResults,
							...(usage ? { usage } : {}),
							...(ctx.model ? { model: `${ctx.model.provider}/${ctx.model.id}` } : {}),
							reasoning: pi.getThinkingLevel(),
						},
					});
					if (!result || result.mode !== "encode") {
						throw new Error("memory/v1 encode invocation returned a non-encode result");
					}
					await applyMemoryComponentOutput(activeMemoryNamespace, result);
				} catch (error) {
					const detail = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Evo-Pi memory encode failed; disabling memory for this session: ${detail}`, "warning");
					memoryProcess = undefined;
					memoryNamespace = undefined;
					await activeMemoryProcess.shutdown();
				}
			}
			const process = controlProcess;
			if (!process || !pinned) return undefined;
			try {
				const usage = ctx.getContextUsage();
				const result = await process.invoke({
					turnIndex: event.turnIndex,
					message: event.message,
					toolResults: event.toolResults,
					...(usage ? { usage } : {}),
					...(ctx.model ? { model: `${ctx.model.provider}/${ctx.model.id}` } : {}),
					reasoning: pi.getThinkingLevel(),
				});
				if (result.model !== undefined) {
					const model = resolveWorkerModel(ctx, result.model);
					if (!(await pi.setModel(model))) {
						throw new Error(`control/v1 model is unavailable: ${result.model}`);
					}
				}
				if (result.reasoning !== undefined) pi.setThinkingLevel(resolveThinkingLevel(result.reasoning));
				if (result.memoryDeltas !== undefined) {
					if (!controlMemoryNamespace) {
						throw new Error("control/v1 returned memoryDeltas without a persisted memory-write grant");
					}
					await applyControlMemoryDeltas(controlMemoryNamespace, result.memoryDeltas);
				}
				return result.stop === undefined ? undefined : { stop: result.stop };
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Evo-Pi control component failed; stopping the current run: ${detail}`, "error");
				controlProcess = undefined;
				await process.shutdown();
				return { stop: true };
			}
		});

		pi.on("message_end", async (event, ctx) => {
			const component = generationComponent;
			if (!component || !pinned || event.message.role !== "assistant") return undefined;
			if (event.message.content.some((content) => content.type === "toolCall")) return undefined;
			try {
				const result = await invokeTurnComponent(component, {
					message: JSON.parse(canonicalJson(event.message)) as Record<string, unknown>,
				});
				if (!result.message && result.stopReason === undefined && !result.redo) return undefined;
				let content = event.message.content;
				if (result.message) {
					if (result.message.role !== "assistant" || !Array.isArray(result.message.content)) {
						throw new Error("generation/v1 replacement must be an assistant message with content");
					}
					if (result.message.content.some((block) => !isRecord(block) || block.type === "toolCall")) {
						throw new Error("generation/v1 cannot inject or replace tool calls");
					}
					content = result.message.content as typeof content;
				}
				let stopReason = event.message.stopReason;
				if (result.stopReason !== undefined) {
					switch (result.stopReason) {
						case "stop":
						case "length":
						case "toolUse":
						case "error":
						case "aborted":
							stopReason = result.stopReason;
							break;
						default:
							throw new Error("generation/v1 returned an invalid stopReason");
					}
				}
				return {
					message: { ...event.message, content, stopReason },
					...(result.redo ? { redo: true } : {}),
				};
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Evo-Pi generation component failed; using the original message: ${detail}`, "warning");
				generationComponent = undefined;
				return undefined;
			}
		});

		pi.on("resources_discover", () => {
			return pinned?.skillDirectory ? { skillPaths: [pinned.skillDirectory] } : undefined;
		});

		pi.on("agent_settled", async (_event, ctx) => {
			const activeMemoryProcess = memoryProcess;
			const activeMemoryNamespace = memoryNamespace;
			if (!activeMemoryProcess || !activeMemoryNamespace || !pinned) return;
			try {
				const state = await activeMemoryNamespace.read();
				const result = await invokeMemory({
					mode: "consolidate",
					candidates: state.fragments.map(
						(fragment) => JSON.parse(canonicalJson(fragment)) as Record<string, unknown>,
					),
				});
				if (!result || result.mode !== "consolidate") {
					throw new Error("memory/v1 consolidate invocation returned a non-consolidate result");
				}
				await applyMemoryComponentOutput(activeMemoryNamespace, result);
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(
					`Evo-Pi memory consolidation failed; disabling memory for this session: ${detail}`,
					"warning",
				);
				memoryProcess = undefined;
				memoryNamespace = undefined;
				await activeMemoryProcess.shutdown();
			}
		});

		pi.on("before_agent_start", async (event, ctx) => {
			if (!pinned) return undefined;
			let systemPrompt: string;
			if (!pinned.bundle.policy.managedSources?.length) {
				systemPrompt = replaceRuntimeBundlePrompt(event.systemPrompt, pinned.systemPromptAppend);
			} else {
				const managed = replaceManagedHostResources({
					event,
					bundle: pinned.bundle,
					resources: pinned.managedResources,
				});
				systemPrompt = replaceRuntimeBundlePrompt(
					managed.systemPrompt,
					renderRuntimeBundlePrompt(pinned, managed.excludedTargets),
				);
			}
			const activeMemoryProcess = memoryProcess;
			if (activeMemoryProcess && memoryNamespace) {
				try {
					const result = await invokeMemory({ mode: "recall", query: event.prompt });
					if (!result || result.mode !== "recall") {
						throw new Error("memory/v1 recall invocation returned a non-recall result");
					}
					if (result.fragments.length > 0) {
						systemPrompt += `\n\n## Recalled episodic memory\n\n${canonicalJson(result.fragments)}`;
					}
				} catch (error) {
					const detail = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Evo-Pi memory recall failed; disabling memory for this session: ${detail}`, "warning");
					memoryProcess = undefined;
					memoryNamespace = undefined;
					await activeMemoryProcess.shutdown();
				}
			}
			const component = instructionsComponent;
			if (!component) return { systemPrompt };
			try {
				const result = await invokeTurnComponent(component, {
					systemPrompt,
					options: event.systemPromptOptions as unknown as Record<string, unknown>,
				});
				return {
					systemPrompt:
						"systemPrompt" in result
							? result.systemPrompt
							: result.sections.map((section) => section.content).join("\n\n"),
				};
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Evo-Pi instructions component failed; using the bundle prompt: ${detail}`, "warning");
				instructionsComponent = undefined;
				return { systemPrompt };
			}
		});
	};
}
