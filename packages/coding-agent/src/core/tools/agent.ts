import type { AgentTool, ThinkingLevel } from "@ch1nyzzz/pi-agent-core";
import { type Static, Type } from "typebox";
import type { AuthStorage } from "../auth-storage.ts";
import { defineTool, type ToolDefinition } from "../extensions/types.ts";
import type { ModelRegistry } from "../model-registry.ts";
import { resolveCliModel } from "../model-resolver.ts";
import { SessionManager } from "../session-manager.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, truncateHead } from "./truncate.ts";

const agentSchema = Type.Object({
	task: Type.String({
		minLength: 1,
		description:
			"Complete, self-contained task for the subagent. It starts with a fresh context and cannot see this conversation: include every needed fact, absolute paths, and the exact shape of the final report you expect.",
	}),
});

export type AgentToolInput = Static<typeof agentSchema>;

export interface AgentToolDetails {
	model?: { provider: string; id: string };
	tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	stopReason?: string;
	truncated?: boolean;
}

/** Child sessions default to read-only investigation tools. */
export const DEFAULT_AGENT_CHILD_TOOLS = ["read", "grep", "find", "ls"] as const;

const LENGTH_RECOVERY_PROMPT =
	"Your previous response was cut off because it exhausted the available output space. " +
	"Produce your complete final report now. Do not call tools. " +
	"Keep deliberation brief and output the final report directly.";

export interface AgentToolOptions {
	/** Agent directory for child sessions (auth, models, settings). Default: the standard agent dir. */
	agentDir?: string;
	/** Tool names granted to child sessions. Default: read, grep, find, ls. */
	tools?: string[];
	/** Model for child sessions as "provider/id". Default: the configured default model. */
	model?: string;
	thinkingLevel?: ThinkingLevel;
	/** System prompt for child sessions. Default: the standard prompt for the granted tools. */
	systemPrompt?: string;
	/**
	 * Levels of spawning this tool still permits. At the default of 1 this session can
	 * spawn children, and a child never receives an agent tool — deeper nesting is
	 * unrepresentable in its toolset rather than rejected at runtime. Values above 1
	 * hand children an agent tool constructed with one level less.
	 */
	maxDepth?: number;
	/** Shared auth backend, primarily for embedded runtimes and tests. */
	authStorage?: AuthStorage;
	/** Shared model registry, primarily for embedded runtimes and tests. */
	modelRegistry?: ModelRegistry;
}

export function createAgentToolDefinition(
	cwd: string,
	options: AgentToolOptions = {},
): ToolDefinition<typeof agentSchema, AgentToolDetails> {
	const remainingDepth = Math.max(1, Math.trunc(options.maxDepth ?? 1));
	return {
		name: "agent",
		label: "agent",
		description:
			"Run a subagent in a fresh session and return its final report as this tool's result. " +
			"The subagent cannot see this conversation, so the task must be self-contained. " +
			"Use it to fan out independent investigations or to keep noisy exploration out of this context. " +
			"Independent tasks can run as parallel agent calls in one message.",
		promptSnippet: "agent: delegate a self-contained task to a fresh subagent session and get its final report",
		parameters: agentSchema,
		executionMode: "parallel",
		async execute(_toolCallId, params, signal) {
			// Lazy import breaks the module cycle tools → session services → sdk → tools.
			const { createAgentSessionFromServices, createAgentSessionServices } = await import(
				"../agent-session-services.ts"
			);
			const services = await createAgentSessionServices({
				cwd,
				agentDir: options.agentDir,
				authStorage: options.authStorage,
				modelRegistry: options.modelRegistry,
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
					...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
				},
			});
			const diagnosticErrors = services.diagnostics.filter((diagnostic) => diagnostic.type === "error");
			if (diagnosticErrors.length > 0) {
				throw new Error(
					`Could not create subagent services: ${diagnosticErrors.map((diagnostic) => diagnostic.message).join("; ")}`,
				);
			}
			const resolvedModel = options.model
				? resolveCliModel({
						cliModel: options.model,
						cliThinking: options.thinkingLevel,
						modelRegistry: services.modelRegistry,
					})
				: undefined;
			if (resolvedModel?.error) {
				throw new Error(resolvedModel.error);
			}

			const grantedTools = (options.tools ?? [...DEFAULT_AGENT_CHILD_TOOLS]).filter((name) => name !== "agent");
			const childAgentTool =
				remainingDepth > 1
					? defineTool(createAgentToolDefinition(cwd, { ...options, maxDepth: remainingDepth - 1 }))
					: undefined;
			const toolNames = [...grantedTools, ...(childAgentTool ? [childAgentTool.name] : [])];

			const { session, modelFallbackMessage } = await createAgentSessionFromServices({
				services,
				sessionManager: SessionManager.inMemory(cwd),
				model: resolvedModel?.model,
				thinkingLevel: options.thinkingLevel ?? resolvedModel?.thinkingLevel,
				...(toolNames.length > 0 ? { tools: toolNames } : { noTools: "all" as const }),
				...(childAgentTool ? { customTools: [childAgentTool] } : {}),
			});
			const abortSession = () => {
				void session.abort();
			};
			signal?.addEventListener("abort", abortSession, { once: true });
			try {
				if (signal?.aborted) {
					throw new Error("Subagent run aborted");
				}
				const activeModel = session.model;
				if (!activeModel) {
					throw new Error(modelFallbackMessage ?? "No model is available for the subagent");
				}

				await session.prompt(params.task, { expandPromptTemplates: false });
				let finalMessage = session.messages.at(-1);
				if (!finalMessage || finalMessage.role !== "assistant") {
					throw new Error("Subagent run completed without a final assistant message");
				}
				// A "length" stop survives in-session: compaction frees the window before the
				// recovery prompt and the fresh turn gets a fresh output budget.
				let recoveryAttempt = 0;
				while (finalMessage.stopReason === "length" && recoveryAttempt < 2 && !signal?.aborted) {
					recoveryAttempt += 1;
					await session.prompt(LENGTH_RECOVERY_PROMPT, { expandPromptTemplates: false });
					const recovered = session.messages.at(-1);
					if (!recovered || recovered.role !== "assistant") {
						throw new Error("Subagent recovery completed without a final assistant message");
					}
					finalMessage = recovered;
				}
				if (finalMessage.stopReason !== "stop") {
					const detail = finalMessage.errorMessage ? `: ${finalMessage.errorMessage}` : "";
					throw new Error(`Subagent run ended with stop reason "${finalMessage.stopReason}"${detail}`);
				}

				const text = finalMessage.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("")
					.trim();
				if (!text) {
					throw new Error("Subagent run completed without a final report");
				}
				const truncation = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES });
				const stats = session.getSessionStats();
				return {
					content: [
						{
							type: "text",
							text: truncation.truncated
								? `${truncation.content}\n\n[Subagent report truncated at ${DEFAULT_MAX_BYTES} bytes]`
								: truncation.content,
						},
					],
					details: {
						model: { provider: activeModel.provider, id: activeModel.id },
						tokens: stats.tokens,
						stopReason: finalMessage.stopReason,
						truncated: truncation.truncated,
					},
				};
			} finally {
				signal?.removeEventListener("abort", abortSession);
				session.dispose();
			}
		},
	};
}

export function createAgentTool(cwd: string, options?: AgentToolOptions): AgentTool<typeof agentSchema> {
	return wrapToolDefinition(createAgentToolDefinition(cwd, options));
}
