import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionFactory, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { getEvoPaths } from "../paths.ts";
import { BundleRegistry } from "../registry/registry.ts";
import type { CompiledBundle } from "../types.ts";
import { loadCompiledBundle } from "./compile.ts";
import { isDigest } from "./schema.ts";

const BUNDLE_BEGIN = "<!-- evo-pi bundle begin -->";
const BUNDLE_END = "<!-- evo-pi bundle end -->";

export interface RuntimeBundle {
	bundle: CompiledBundle;
	systemPromptAppend: string;
	skillDirectory?: string;
	enabledTools?: string[];
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
	const stableSections: string[] = [];
	const regularSections: string[] = [];
	const dynamicSections: string[] = [];
	for (const path of orderedPaths) {
		const section = (await readFile(join(bundle.directory, path), "utf8")).trim();
		if (!section) continue;
		if (stablePaths.has(path)) stableSections.push(section);
		else if (dynamicPaths.has(path)) dynamicSections.push(section);
		else regularSections.push(section);
	}
	const memorySections: string[] = [];
	for (const file of await listMarkdown(join(bundle.directory, "memory"))) {
		const content = (await readFile(join(bundle.directory, "memory", file), "utf8")).trim();
		if (content) memorySections.push(`## Remembered user context\n\n${content}`);
	}
	return {
		bundle,
		systemPromptAppend: [
			BUNDLE_BEGIN,
			...stableSections,
			`Bundle: ${bundle.digest}`,
			...regularSections,
			...memorySections,
			...dynamicSections,
			BUNDLE_END,
		].join("\n\n"),
		skillDirectory: bundle.manifest.files.some((file) => file.path.startsWith("skills/"))
			? join(bundle.directory, "skills")
			: undefined,
		enabledTools: bundle.policy.enabledTools,
	};
}

export function replaceRuntimeBundlePrompt(systemPrompt: string, replacement: string): string {
	const start = systemPrompt.indexOf(BUNDLE_BEGIN);
	const end = systemPrompt.indexOf(BUNDLE_END);
	if (start === -1 || end === -1 || end < start) return `${systemPrompt}\n\n${replacement}`;
	return `${systemPrompt.slice(0, start)}${replacement}${systemPrompt.slice(end + BUNDLE_END.length)}`;
}

export function createPolicyRuntimeExtension(options: { root?: string } = {}): ExtensionFactory {
	const paths = getEvoPaths(options.root);
	const registry = new BundleRegistry(paths);
	return (pi) => {
		let pinned: RuntimeBundle | undefined;
		let activeToolsBeforeBundle: string[] | undefined;

		function restoreActiveTools(): void {
			if (activeToolsBeforeBundle === undefined) return;
			try {
				pi.setActiveTools(activeToolsBeforeBundle);
			} finally {
				activeToolsBeforeBundle = undefined;
			}
		}

		pi.on("session_start", async (event, ctx) => {
			pinned = undefined;
			restoreActiveTools();
			activeToolsBeforeBundle = [...pi.getActiveTools()];
			try {
				const sessionId = ctx.sessionManager.getSessionId();
				const recordedDigest = resolveSessionBundleDigest(ctx.sessionManager.getEntries(), sessionId, event.reason);
				const digest = recordedDigest ?? (await registry.readStableDigest());
				if (!digest) return;
				const runtimeBundle = await renderRuntimeBundle(await loadCompiledBundle(paths, digest));
				if (recordedDigest === undefined) pi.appendEntry("evo.bundle", { digest, sessionId });
				if (runtimeBundle.enabledTools) pi.setActiveTools(runtimeBundle.enabledTools);
				pinned = runtimeBundle;
			} catch (error) {
				ctx.ui.notify(`Evo-Pi bundle disabled: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		});

		pi.on("session_shutdown", () => {
			try {
				restoreActiveTools();
			} finally {
				pinned = undefined;
			}
		});

		pi.on("resources_discover", () => {
			return pinned?.skillDirectory ? { skillPaths: [pinned.skillDirectory] } : undefined;
		});

		pi.on("before_agent_start", (event) => {
			if (!pinned) return undefined;
			return { systemPrompt: replaceRuntimeBundlePrompt(event.systemPrompt, pinned.systemPromptAppend) };
		});
	};
}
