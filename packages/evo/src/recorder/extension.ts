import { access } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { resolveSessionBundleDigest } from "../bundle/runtime.ts";
import { initializeInboxLifecycle } from "../inbox.ts";
import { type EvoPaths, getEvoPaths } from "../paths.ts";
import { BundleRegistry } from "../registry/registry.ts";
import type { UsageSummary } from "../types.ts";
import { buildSessionDigest } from "./digest.ts";
import type { RecorderSessionReference, VerificationKind, VerificationRecord } from "./schema.ts";
import { createRecorderStore, type RecorderStore, readSessionLog, resolveStoredPayload } from "./store.ts";

const DURABLE_PREFERENCE_PATTERN =
	/以后|今后|从现在开始|每次|始终|一律|默认|记住|不要再|别再|优先|注意不要|第一性原理|不要.{0,12}过度|from\s+now\s+on|going\s+forward|every\s+time|by\s+default|\balways\b|\bnever\b|\bremember\b|\bprefer\b/i;

export function isDurablePreferenceInstruction(text: string): boolean {
	return DURABLE_PREFERENCE_PATTERN.test(text);
}

async function isPrivacyExcluded(cwd: string): Promise<boolean> {
	try {
		await access(join(cwd, ".pi", "evo-private"));
		return true;
	} catch {
		return false;
	}
}

interface PendingTool {
	input: unknown;
	result?: unknown;
	isError?: boolean;
	startedAtMs: number;
}

export interface RecorderExtensionOptions {
	root?: string;
	paths?: EvoPaths;
	bundleDigest?: string;
	artifactThresholdBytes?: number;
	previewCharacters?: number;
	gitDiffTimeoutMs?: number;
	now?: () => Date;
	onError?: (error: unknown) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function getString(value: unknown, key: string): string | undefined {
	if (!isRecord(value)) return undefined;
	return typeof value[key] === "string" ? value[key] : undefined;
}

function getNumber(value: unknown, key: string): number {
	if (!isRecord(value)) return 0;
	const candidate = value[key];
	return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : 0;
}

function classifyVerificationCommand(command: string): VerificationKind | undefined {
	const normalized = command.toLowerCase();
	if (
		/\b(?:typecheck|type-check|tsc)(?:\s|$)/.test(normalized) ||
		/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:check:types|check-types)(?:\s|$)/.test(normalized)
	) {
		return "typecheck";
	}
	if (
		/\b(?:eslint|biome\s+check|ruff\s+check|golangci-lint)(?:\s|$)/.test(normalized) ||
		/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?lint(?:\s|$)/.test(normalized)
	) {
		return "lint";
	}
	if (
		/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build(?:\s|$)/.test(normalized) ||
		/\b(?:cargo\s+build|go\s+build|cmake\s+--build|gradle\w*\s+build|mvn\w*\s+package)(?:\s|$)/.test(normalized)
	) {
		return "build";
	}
	if (
		/\b(?:vitest|pytest|jest|mocha)(?:\s|$)/.test(normalized) ||
		/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?:\s|$)/.test(normalized) ||
		/\b(?:cargo|go|dotnet)\s+test(?:\s|$)/.test(normalized)
	) {
		return "test";
	}
	if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?check(?:\s|$)/.test(normalized)) return "check";
	return undefined;
}

function collectText(value: unknown, visited: WeakSet<object> = new WeakSet<object>()): string {
	if (typeof value === "string") return value;
	if (value instanceof Error) return value.message;
	if (!isRecord(value) && !Array.isArray(value)) return "";
	if (visited.has(value)) return "";
	visited.add(value);
	try {
		if (Array.isArray(value))
			return value
				.map((item) => collectText(item, visited))
				.filter(Boolean)
				.join("\n");
		const directText = typeof value.text === "string" ? value.text : "";
		const contentText = "content" in value ? collectText(value.content, visited) : "";
		return [directText, contentText].filter(Boolean).join("\n");
	} finally {
		visited.delete(value);
	}
}

function messageFingerprint(message: unknown): string | undefined {
	if (!isRecord(message)) return undefined;
	const role = getString(message, "role");
	if (!role) return undefined;
	const timestamp = typeof message.timestamp === "number" ? String(message.timestamp) : "";
	return `${role}\0${timestamp}\0${collectText(message.content)}`;
}

function inferBashExitCode(result: unknown, isError: boolean): number | null {
	if (!isError) return 0;
	const match = /Command exited with code\s+(-?\d+)/.exec(collectText(result));
	if (!match?.[1]) return null;
	const exitCode = Number(match[1]);
	return Number.isSafeInteger(exitCode) ? exitCode : null;
}

function getUsage(message: unknown): UsageSummary | undefined {
	if (getString(message, "role") !== "assistant" || !isRecord(message) || !isRecord(message.usage)) {
		return undefined;
	}
	return {
		input: getNumber(message.usage, "input"),
		output: getNumber(message.usage, "output"),
		cacheRead: getNumber(message.usage, "cacheRead"),
		cacheWrite: getNumber(message.usage, "cacheWrite"),
		totalTokens: getNumber(message.usage, "totalTokens"),
	};
}

function getVerification(
	toolName: string,
	input: unknown,
	result: unknown,
	isError: boolean,
): VerificationRecord | undefined {
	if (toolName !== "bash") return undefined;
	const command = getString(input, "command");
	if (!command) return undefined;
	const kind = classifyVerificationCommand(command);
	if (!kind) return undefined;
	return {
		kind,
		command,
		exitCode: inferBashExitCode(result, isError),
	};
}

export function createRecorderExtension(options: RecorderExtensionOptions = {}): ExtensionFactory {
	const paths = options.paths ?? getEvoPaths(options.root);
	const now = options.now ?? (() => new Date());
	const pendingTools = new Map<string, PendingTool>();
	const registry = new BundleRegistry(paths);
	let store: RecorderStore | undefined;
	let excludedSessionId: string | undefined;
	let compactionStartedAtMs: number | undefined;
	let queue = Promise.resolve();

	function reportError(error: unknown): void {
		try {
			options.onError?.(error);
		} catch {
			// Recorder diagnostics must never alter agent execution.
		}
	}

	function enqueue(operation: () => Promise<void>): Promise<void> {
		const next = queue.then(operation);
		queue = next.catch(reportError);
		return queue;
	}

	return (pi) => {
		async function backfillMissingUserMessages(activeStore: RecorderStore, ctx: ExtensionContext): Promise<void> {
			const recorded = await readSessionLog(paths, activeStore.sessionId);
			const sourceIds = new Set(
				recorded.flatMap((event) => (event.type === "message" && event.sourceEntryId ? [event.sourceEntryId] : [])),
			);
			const fingerprints = new Set<string>();
			for (const event of recorded) {
				if (event.type !== "message") continue;
				const fingerprint = messageFingerprint(await resolveStoredPayload(paths, event.message));
				if (fingerprint) fingerprints.add(fingerprint);
			}
			for (const entry of ctx.sessionManager.getEntries()) {
				if (entry.type !== "message" || entry.message.role !== "user" || sourceIds.has(entry.id)) continue;
				const fingerprint = messageFingerprint(entry.message);
				if (fingerprint && fingerprints.has(fingerprint)) continue;
				await activeStore.append({
					type: "message",
					role: "user",
					message: await activeStore.storePayload(entry.message),
					sourceEntryId: entry.id,
				});
				if (fingerprint) fingerprints.add(fingerprint);
			}
		}

		async function getFallbackBundleDigest(): Promise<string | undefined> {
			let bundleDigest = options.bundleDigest;
			if (bundleDigest === undefined) {
				try {
					bundleDigest = await registry.readStableDigest();
				} catch (error) {
					reportError(error);
				}
			}
			return bundleDigest;
		}

		async function openStore(sessionId: string, bundleDigest: string | undefined): Promise<RecorderStore> {
			store = await createRecorderStore({
				paths,
				sessionId,
				bundleDigest,
				artifactThresholdBytes: options.artifactThresholdBytes,
				previewCharacters: options.previewCharacters,
				now,
			});
			pendingTools.clear();
			compactionStartedAtMs = undefined;
			return store;
		}

		async function getStore(sessionId: string): Promise<RecorderStore> {
			if (store?.sessionId === sessionId) return store;
			return openStore(sessionId, await getFallbackBundleDigest());
		}

		pi.on("session_start", (event, ctx) =>
			enqueue(async () => {
				const sessionId = ctx.sessionManager.getSessionId();
				if (await isPrivacyExcluded(ctx.cwd)) {
					excludedSessionId = sessionId;
					pendingTools.clear();
					store = undefined;
					return;
				}
				excludedSessionId = undefined;
				const recordedDigest = resolveSessionBundleDigest(ctx.sessionManager.getEntries(), sessionId, event.reason);
				const activeStore = await openStore(sessionId, recordedDigest ?? (await getFallbackBundleDigest()));
				await activeStore.append({
					type: "session_start",
					reason: event.reason,
					cwd: ctx.cwd,
					sessionFile: ctx.sessionManager.getSessionFile(),
					previousSessionFile: event.previousSessionFile,
				});
				if (event.reason === "resume" || event.reason === "reload") {
					await backfillMissingUserMessages(activeStore, ctx);
				}
				await buildSessionDigest(paths, activeStore.sessionId);

				const hasReference = ctx.sessionManager.getEntries().some((entry) => {
					if (entry.type !== "custom" || entry.customType !== "evo-recorder-ref" || !isRecord(entry.data)) {
						return false;
					}
					return entry.data.sessionId === sessionId;
				});
				if (!hasReference) {
					const reference: RecorderSessionReference = {
						schemaVersion: 1,
						sessionId,
						logPath: activeStore.logPath,
						bundleDigest: activeStore.bundleDigest,
					};
					try {
						pi.appendEntry("evo-recorder-ref", reference);
					} catch (error) {
						reportError(error);
					}
				}
			}),
		);

		pi.on("before_agent_start", (event, ctx) =>
			enqueue(async () => {
				if (excludedSessionId === ctx.sessionManager.getSessionId()) return;
				const activeStore = await getStore(ctx.sessionManager.getSessionId());
				const prompt = await activeStore.storePayload(event.prompt);
				const systemPrompt = await activeStore.storePayload(event.systemPrompt);
				const systemPromptOptions = await activeStore.storePayload(event.systemPromptOptions);
				const images = event.images ? await activeStore.storePayload(event.images) : undefined;
				await activeStore.append({
					type: "before_agent_start",
					prompt,
					systemPrompt,
					systemPromptOptions,
					images,
				});
			}),
		);

		pi.on("message_end", (event, ctx) =>
			enqueue(async () => {
				if (excludedSessionId === ctx.sessionManager.getSessionId()) return;
				const activeStore = await getStore(ctx.sessionManager.getSessionId());
				const sourceEntry = [...ctx.sessionManager.getEntries()]
					.reverse()
					.find((entry) => entry.type === "message" && entry.message === event.message);
				await activeStore.append({
					type: "message",
					role: getString(event.message, "role") ?? "unknown",
					message: await activeStore.storePayload(event.message),
					...(sourceEntry ? { sourceEntryId: sourceEntry.id } : {}),
				});

				const usage = getUsage(event.message);
				if (usage) {
					await activeStore.append({
						type: "usage",
						provider: getString(event.message, "provider") ?? "unknown",
						model: getString(event.message, "model") ?? "unknown",
						usage,
					});
				}
			}),
		);

		pi.on("tool_execution_start", (event, ctx) =>
			enqueue(async () => {
				if (excludedSessionId === ctx.sessionManager.getSessionId()) return;
				pendingTools.set(event.toolCallId, {
					input: event.args,
					startedAtMs: now().getTime(),
				});
			}),
		);

		pi.on("tool_call", (event, ctx) =>
			enqueue(async () => {
				if (excludedSessionId === ctx.sessionManager.getSessionId()) return;
				const pending = pendingTools.get(event.toolCallId);
				if (pending) pending.input = event.input;
			}),
		);

		pi.on("tool_result", (event, ctx) =>
			enqueue(async () => {
				if (excludedSessionId === ctx.sessionManager.getSessionId()) return;
				const pending = pendingTools.get(event.toolCallId);
				if (!pending) return;
				pending.input = event.input;
				pending.result = {
					content: event.content,
					details: event.details,
				};
				pending.isError = event.isError;
			}),
		);

		pi.on("tool_execution_end", (event, ctx) =>
			enqueue(async () => {
				if (excludedSessionId === ctx.sessionManager.getSessionId()) return;
				const endedAtMs = now().getTime();
				const pending = pendingTools.get(event.toolCallId);
				pendingTools.delete(event.toolCallId);
				const startedAtMs = pending?.startedAtMs ?? endedAtMs;
				const input = pending?.input ?? {};
				const result = pending?.result ?? event.result;
				const isError = pending?.isError ?? event.isError;
				const activeStore = await getStore(ctx.sessionManager.getSessionId());
				await activeStore.append({
					type: "tool",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					startedAt: new Date(startedAtMs).toISOString(),
					endedAt: new Date(endedAtMs).toISOString(),
					durationMs: Math.max(0, endedAtMs - startedAtMs),
					input: await activeStore.storePayload(input),
					result: await activeStore.storePayload(result),
					isError,
					verification: getVerification(event.toolName, input, result, isError),
				});
			}),
		);

		pi.on("session_before_compact", (_event, ctx) =>
			enqueue(async () => {
				if (excludedSessionId === ctx.sessionManager.getSessionId()) return;
				compactionStartedAtMs = now().getTime();
			}),
		);

		pi.on("session_compact", (event, ctx) =>
			enqueue(async () => {
				if (excludedSessionId === ctx.sessionManager.getSessionId()) return;
				const endedAtMs = now().getTime();
				const startedAtMs = compactionStartedAtMs;
				compactionStartedAtMs = undefined;
				const activeStore = await getStore(ctx.sessionManager.getSessionId());
				await activeStore.append({
					type: "compaction",
					reason: event.reason,
					willRetry: event.willRetry,
					fromExtension: event.fromExtension,
					firstKeptEntryId: event.compactionEntry.firstKeptEntryId,
					tokensBefore: event.compactionEntry.tokensBefore,
					durationMs: startedAtMs === undefined ? null : Math.max(0, endedAtMs - startedAtMs),
					summary: await activeStore.storePayload(event.compactionEntry.summary),
					...(event.compactionEntry.details === undefined
						? {}
						: { details: await activeStore.storePayload(event.compactionEntry.details) }),
				});
			}),
		);

		pi.on("input", (event, ctx) => {
			if (!isDurablePreferenceInstruction(event.text)) return;
			return enqueue(async () => {
				if (excludedSessionId === ctx.sessionManager.getSessionId()) return;
				const activeStore = await getStore(ctx.sessionManager.getSessionId());
				const inbox = await activeStore.writeInbox(event.text, event.source, "candidate");
				await initializeInboxLifecycle(paths, inbox.fileName);
				await activeStore.append({
					type: "explicit_feedback",
					source: event.source,
					text: await activeStore.storePayload(event.text),
					inboxFile: inbox.fileName,
				});
			});
		});

		pi.on("session_shutdown", (event, ctx) =>
			enqueue(async () => {
				if (excludedSessionId === ctx.sessionManager.getSessionId()) {
					excludedSessionId = undefined;
					pendingTools.clear();
					return;
				}
				const activeStore = await getStore(ctx.sessionManager.getSessionId());
				try {
					const execOptions = {
						cwd: ctx.cwd,
						timeout: options.gitDiffTimeoutMs ?? 10_000,
					};
					let diff = await pi.exec("git", ["diff", "--no-ext-diff", "--binary", "HEAD", "--"], execOptions);
					if (diff.code !== 0 && !diff.killed) {
						diff = await pi.exec("git", ["diff", "--no-ext-diff", "--binary"], execOptions);
					}
					if (diff.code === 0 && !diff.killed) {
						await activeStore.append({
							type: "git_diff",
							cwd: ctx.cwd,
							clean: diff.stdout.length === 0,
							diff: await activeStore.storePayload(diff.stdout),
						});
					}
				} catch (error) {
					reportError(error);
				}

				await activeStore.append({
					type: "session_end",
					reason: event.reason,
					targetSessionFile: event.targetSessionFile,
				});
				await buildSessionDigest(paths, activeStore.sessionId);
				pendingTools.clear();
				compactionStartedAtMs = undefined;
				store = undefined;
			}),
		);
	};
}
