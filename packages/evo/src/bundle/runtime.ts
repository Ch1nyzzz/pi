import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	convertToLlm,
	type ExtensionContext,
	type ExtensionFactory,
	type SessionStartEvent,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import { validateEvoComponentSelection } from "../components/artifact.ts";
import { canUseEvoComponentSandbox, EvoComponentProcess } from "../components/process-runtime.ts";
import {
	COMPACTION_V1_ABI,
	type CompactionV1Config,
	type CompactionV1Input,
	type CompactionV1Output,
	createDefaultEvoAbiRegistry,
} from "../components/registry.ts";
import { renderBundlePreferenceInstructions } from "../memory/preferences.ts";
import { getEvoPaths } from "../paths.ts";
import { BundleRegistry } from "../registry/registry.ts";
import type { CompiledBundle } from "../types.ts";
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

export function createPolicyRuntimeExtension(options: { root?: string } = {}): ExtensionFactory {
	const paths = getEvoPaths(options.root);
	const registry = new BundleRegistry(paths);
	return (pi) => {
		let pinned: RuntimeBundle | undefined;
		let activeToolsBeforeBundle: string[] | undefined;
		let activeModelBeforeBundle: ExtensionContext["model"];
		let clearFeatureSession: (() => void) | undefined;
		let compactionProcess: EvoComponentProcess<CompactionV1Input, CompactionV1Output, CompactionV1Config> | undefined;

		async function stopComponentProcesses(): Promise<void> {
			const process = compactionProcess;
			compactionProcess = undefined;
			await process?.shutdown();
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
				const compactionSelection = compiledBundle.policy.components?.compaction;
				if (compactionSelection) {
					const abiRegistry = createDefaultEvoAbiRegistry();
					const artifact = await validateEvoComponentSelection(
						paths,
						"compaction",
						compactionSelection,
						abiRegistry,
					);
					const config = COMPACTION_V1_ABI.validateConfig(compactionSelection.config ?? {});
					const sandboxAvailable = await canUseEvoComponentSandbox();
					if (!sandboxAvailable && !ctx.hasUI) {
						throw new Error(
							"Component sandbox is unavailable and direct execution requires one-time user permission",
						);
					}
					const allowDirect =
						!sandboxAvailable &&
						(await ctx.ui.confirm(
							"One-time component permission",
							`The OS sandbox is unavailable. Allow ${compactionSelection.id} (${compactionSelection.artifactDigest.slice(0, 12)}) to run directly with your user permissions for this session only?`,
						));
					if (!sandboxAvailable && !allowDirect) {
						throw new Error("User declined one-time direct component execution");
					}
					compactionProcess = new EvoComponentProcess(artifact, COMPACTION_V1_ABI, config, {
						...(allowDirect ? { sandbox: false } : {}),
					});
					await compactionProcess.start();
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
						runtimeBundle.enabledTools ?? activeToolsBeforeBundle,
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
					pi.setActiveTools([]);
				} catch (disableError) {
					recoveryError = disableError;
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
				await stopComponentProcesses();
				return undefined;
			}
		});

		pi.on("resources_discover", () => {
			return pinned?.skillDirectory ? { skillPaths: [pinned.skillDirectory] } : undefined;
		});

		pi.on("before_agent_start", (event) => {
			if (!pinned) return undefined;
			if (!pinned.bundle.policy.managedSources?.length) {
				return { systemPrompt: replaceRuntimeBundlePrompt(event.systemPrompt, pinned.systemPromptAppend) };
			}
			const managed = replaceManagedHostResources({
				event,
				bundle: pinned.bundle,
				resources: pinned.managedResources,
			});
			return {
				systemPrompt: replaceRuntimeBundlePrompt(
					managed.systemPrompt,
					renderRuntimeBundlePrompt(pinned, managed.excludedTargets),
				),
			};
		});
	};
}
