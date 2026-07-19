import type { AgentMessage, ThinkingLevel } from "@ch1nyzzz/pi-agent-core";
import {
	type AuthStorage,
	createAgentSessionFromServices,
	createAgentSessionServices,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	type ModelRegistry,
	resolveCliModel,
	SessionManager,
	type SessionStats,
	type ToolDefinition,
} from "@ch1nyzzz/pi-coding-agent";

export type ModelRunStreamEvent =
	| { type: "text" | "thinking" | "tool-arguments"; delta: string }
	| { type: "tool-call"; name: string; arguments: Record<string, unknown> }
	| { type: "tool-result"; name: string; text: string; isError: boolean }
	| { type: "length-recovery"; attempt: number; maxAttempts: number }
	| { type: "submission-retry"; attempt: number; maxAttempts: number }
	| {
			type: "usage";
			stopReason: string;
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
	  }
	| { type: "complete"; stopReason: string };

/**
 * Typed result channel: the model delivers its result by calling a schema-validated
 * tool instead of emitting text for the orchestrator to parse. Schema violations and
 * `validate` rejections flow back to the model as tool errors, so retries happen
 * inside the session — free text is never a control signal.
 */
export interface ModelRunSubmission {
	toolName: string;
	description: string;
	parameters: ToolDefinition["parameters"];
	/**
	 * Optional semantic validation beyond the schema. Throw to reject the submission
	 * (the model sees the message and can retry). A non-undefined return value
	 * replaces the stored submission.
	 */
	validate?: (params: Record<string, unknown>) => unknown | Promise<unknown>;
	/** Reprompts when a run ends without a submission. Default 2; 0 disables reprompting. */
	maxAttempts?: number;
}

export interface ModelRunRequest {
	cwd: string;
	agentDir?: string;
	systemPrompt: string;
	prompt: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	history?: readonly AgentMessage[];
	/** Explicit built-in/custom tool allowlist. Omit to run with no tools. */
	tools?: string[];
	/**
	 * Execution budget per built-in read-family tool call (read/grep/find/ls). Headless
	 * phases have no human to interrupt a runaway filesystem scan, so an over-budget call
	 * is aborted and returned to the model as a tool error. Defaults to 120s.
	 */
	toolTimeoutMs?: number;
	customTools?: ToolDefinition[];
	/** Structured result channel; when set, the run's result is the submitted object. */
	submission?: ModelRunSubmission;
	/** Stable provider session identity used to reuse replay prompt caches. */
	sessionIdentity?: string;
	/**
	 * Prompt sent to the same session when a run stops with "length" (output space or
	 * context window exhausted). The session compacts before this prompt is submitted,
	 * so the retry runs against a freed window. Defaults to a generic finish-now prompt.
	 */
	recoveryPrompt?: string;
	/** Maximum recovery prompts after "length" stops. Defaults to 2; 0 disables recovery. */
	maxLengthRecoveries?: number;
	signal?: AbortSignal;
	/** Receives the live headless-agent stream without retaining it in the model context. */
	onStreamEvent?: (event: ModelRunStreamEvent) => void;
	/**
	 * Receives the session stats (and active model, when known) exactly once, even when
	 * the run fails — callers can persist usage for failed runs.
	 */
	onSessionStats?: (stats: SessionStats, model: { provider: string; id: string } | undefined) => void;
}

export interface ModelRunResult {
	text: string;
	/** Validated object delivered through the submission tool, when one was requested. */
	submission?: unknown;
	stats: SessionStats;
	model: {
		provider: string;
		id: string;
	};
}

export interface ModelRunner {
	run(request: ModelRunRequest): Promise<ModelRunResult>;
}

const DEFAULT_RECOVERY_PROMPT =
	"Your previous response was cut off because it exhausted the available output space. " +
	"Produce your complete final answer now. Do not call tools. " +
	"Keep deliberation brief and output the final deliverable directly.";

const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

/** Uniform execution surface: the concrete parameter schemas stay with the factories. */
type AnyToolDefinition = ToolDefinition<any, any, any>;

/**
 * Read-family tools traverse arbitrary directory trees, and a headless run has no human
 * to interrupt a scan that wanders onto huge or slow filesystems. The runner shadows the
 * built-ins with copies that enforce a hard execution budget: exceeding it aborts the
 * call (signal-aware tools kill their child process) and the model receives a tool error.
 */
const READ_FAMILY_TOOL_FACTORIES: Record<string, (cwd: string) => AnyToolDefinition> = {
	read: createReadToolDefinition,
	grep: createGrepToolDefinition,
	find: createFindToolDefinition,
	ls: createLsToolDefinition,
};

function withExecutionTimeout(definition: AnyToolDefinition, timeoutMs: number): AnyToolDefinition {
	return {
		...definition,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const controller = new AbortController();
			const forwardAbort = () => controller.abort();
			if (signal?.aborted) controller.abort();
			else signal?.addEventListener("abort", forwardAbort, { once: true });
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				return await Promise.race([
					definition.execute(toolCallId, params, controller.signal, onUpdate, ctx),
					new Promise<never>((_, reject) => {
						controller.signal.addEventListener(
							"abort",
							() => reject(new Error(`${definition.name} execution aborted`)),
							{ once: true },
						);
						timer = setTimeout(() => {
							reject(
								new Error(`${definition.name} execution exceeded the ${Math.round(timeoutMs / 1000)}s limit`),
							);
							controller.abort();
						}, timeoutMs);
					}),
				]);
			} finally {
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", forwardAbort);
			}
		},
	};
}

export interface PiModelRunnerOptions {
	/** Optional shared auth backend, primarily for embedded runtimes and tests. */
	authStorage?: AuthStorage;
	/** Optional shared model registry, primarily for embedded runtimes and tests. */
	modelRegistry?: ModelRegistry;
}

export function createPiModelRunner(options: PiModelRunnerOptions = {}): ModelRunner {
	return {
		async run(request: ModelRunRequest): Promise<ModelRunResult> {
			const services = await createAgentSessionServices({
				cwd: request.cwd,
				agentDir: request.agentDir,
				authStorage: options.authStorage,
				modelRegistry: options.modelRegistry,
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
					systemPrompt: request.systemPrompt,
				},
			});

			const diagnosticErrors = services.diagnostics.filter((diagnostic) => diagnostic.type === "error");
			if (diagnosticErrors.length > 0) {
				throw new Error(
					`Could not create model runner services: ${diagnosticErrors.map((diagnostic) => diagnostic.message).join("; ")}`,
				);
			}

			const resolvedModel = request.model
				? resolveCliModel({
						cliModel: request.model,
						cliThinking: request.thinkingLevel,
						modelRegistry: services.modelRegistry,
					})
				: undefined;
			if (resolvedModel?.error) {
				throw new Error(resolvedModel.error);
			}

			let submitted: { value: unknown } | undefined;
			const submissionTool: ToolDefinition | undefined = request.submission
				? {
						name: request.submission.toolName,
						label: request.submission.toolName,
						description: request.submission.description,
						parameters: request.submission.parameters,
						async execute(_toolCallId, params) {
							const validated = await request.submission?.validate?.(params as Record<string, unknown>);
							submitted = { value: validated === undefined ? params : validated };
							return { content: [{ type: "text", text: "Submission accepted." }], details: {} };
						},
					}
				: undefined;
			const toolNames = [...(request.tools ?? []), ...(submissionTool ? [submissionTool.name] : [])];
			const toolTimeoutMs = request.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
			const timedReadTools = (request.tools ?? [])
				.map((name) => READ_FAMILY_TOOL_FACTORIES[name]?.(request.cwd))
				.filter((definition) => definition !== undefined)
				.map((definition) => withExecutionTimeout(definition, toolTimeoutMs));
			const customTools = [
				...timedReadTools,
				...(request.customTools ?? []),
				...(submissionTool ? [submissionTool] : []),
			];

			const sessionManager = SessionManager.inMemory(request.cwd, { id: request.sessionIdentity });
			const { session, modelFallbackMessage } = await createAgentSessionFromServices({
				services,
				sessionManager,
				model: resolvedModel?.model,
				thinkingLevel: request.thinkingLevel ?? resolvedModel?.thinkingLevel,
				...(toolNames.length > 0 ? { tools: toolNames } : { noTools: "all" as const }),
				...(customTools.length > 0 ? { customTools } : {}),
			});
			const unsubscribe = request.onStreamEvent
				? session.subscribe((event) => {
						if (event.type === "message_end") {
							const message = event.message;
							if (message.role === "assistant" && message.usage) {
								request.onStreamEvent?.({
									type: "usage",
									stopReason: message.stopReason,
									input: message.usage.input,
									output: message.usage.output,
									cacheRead: message.usage.cacheRead,
									cacheWrite: message.usage.cacheWrite,
								});
							}
							return;
						}
						if (event.type === "tool_execution_end") {
							const text = Array.isArray(event.result?.content)
								? event.result.content
										.filter((item: { type?: string }) => item.type === "text")
										.map((item: { text?: string }) => item.text ?? "")
										.join("\n")
								: String(event.result ?? "");
							request.onStreamEvent?.({
								type: "tool-result",
								name: event.toolName,
								text: text.slice(0, 8_000),
								isError: event.isError,
							});
							return;
						}
						if (event.type !== "message_update") return;
						const update = event.assistantMessageEvent;
						if (update.type === "text_delta") request.onStreamEvent?.({ type: "text", delta: update.delta });
						else if (update.type === "thinking_delta") {
							request.onStreamEvent?.({ type: "thinking", delta: update.delta });
						} else if (update.type === "toolcall_delta") {
							request.onStreamEvent?.({ type: "tool-arguments", delta: update.delta });
						} else if (update.type === "toolcall_end") {
							request.onStreamEvent?.({
								type: "tool-call",
								name: update.toolCall.name,
								arguments: update.toolCall.arguments,
							});
						}
					})
				: undefined;
			const abortSession = () => {
				void session.abort();
			};
			request.signal?.addEventListener("abort", abortSession, { once: true });

			try {
				if (request.signal?.aborted) {
					throw request.signal.reason instanceof Error ? request.signal.reason : new Error("Model run aborted");
				}
				const activeModel = session.model;
				if (!activeModel) {
					throw new Error(modelFallbackMessage ?? "No model is available for the model runner");
				}

				// The SDK appends deterministic date/cwd metadata to this fixed role prompt.
				session.agent.state.messages = request.history ? [...request.history] : [];

				await session.prompt(request.prompt, { expandPromptTemplates: false });

				let finalMessage = session.messages.at(-1);
				if (!finalMessage || finalMessage.role !== "assistant") {
					throw new Error("Model run completed without a final assistant message");
				}

				// A provider-level failure ends the turn for good. Surface its message
				// immediately: recovery and submission reprompts cannot succeed on a session
				// whose requests keep failing, and they masked the real error.
				const throwIfTerminated = (message: { stopReason: string; errorMessage?: string }) => {
					if (message.stopReason === "error" || message.stopReason === "aborted") {
						const detail = message.errorMessage ? `: ${message.errorMessage}` : "";
						throw new Error(`Model run ended with stop reason "${message.stopReason}"${detail}`);
					}
				};
				throwIfTerminated(finalMessage);

				// A "length" stop means the output space or context window ran out. The session
				// survives, so recover in place: the pre-prompt compaction check frees the window
				// (overflow-shaped usage triggers it) and a fresh turn gets a fresh output budget.
				const maxRecoveries = request.maxLengthRecoveries ?? 2;
				let recoveryAttempt = 0;
				while (
					finalMessage.stopReason === "length" &&
					recoveryAttempt < maxRecoveries &&
					!request.signal?.aborted
				) {
					recoveryAttempt += 1;
					request.onStreamEvent?.({
						type: "length-recovery",
						attempt: recoveryAttempt,
						maxAttempts: maxRecoveries,
					});
					await session.prompt(request.recoveryPrompt ?? DEFAULT_RECOVERY_PROMPT, {
						expandPromptTemplates: false,
					});
					const recovered = session.messages.at(-1);
					if (!recovered || recovered.role !== "assistant") {
						throw new Error("Model run recovery completed without a final assistant message");
					}
					finalMessage = recovered;
					throwIfTerminated(recovered);
				}

				// The submission is the result; a run that ends without one gets bounded,
				// explicit reprompts inside the same session.
				if (request.submission) {
					const maxAttempts = request.submission.maxAttempts ?? 2;
					let submissionAttempt = 0;
					while (!submitted && submissionAttempt < maxAttempts && !request.signal?.aborted) {
						submissionAttempt += 1;
						request.onStreamEvent?.({ type: "submission-retry", attempt: submissionAttempt, maxAttempts });
						await session.prompt(
							`You have not delivered your result yet. Call the ${request.submission.toolName} tool now with your complete final result. Do not output anything else.`,
							{ expandPromptTemplates: false },
						);
						const reprompted = session.messages.at(-1);
						if (!reprompted || reprompted.role !== "assistant") {
							throw new Error("Submission reprompt completed without a final assistant message");
						}
						finalMessage = reprompted;
						throwIfTerminated(reprompted);
					}
					if (!submitted) {
						throw new Error(`Model run ended without a ${request.submission.toolName} submission`);
					}
				}

				request.onStreamEvent?.({ type: "complete", stopReason: finalMessage.stopReason });
				if (finalMessage.stopReason !== "stop") {
					const detail = finalMessage.errorMessage ? `: ${finalMessage.errorMessage}` : "";
					const recoveryNote =
						recoveryAttempt > 0
							? ` after ${recoveryAttempt} length ${recoveryAttempt === 1 ? "recovery" : "recoveries"}`
							: "";
					throw new Error(`Model run ended with stop reason "${finalMessage.stopReason}"${recoveryNote}${detail}`);
				}

				const text = finalMessage.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("")
					.trim();
				if (!text && !submitted) {
					throw new Error("Model run completed without text output");
				}

				return {
					text,
					...(submitted ? { submission: submitted.value } : {}),
					stats: session.getSessionStats(),
					model: { provider: activeModel.provider, id: activeModel.id },
				};
			} finally {
				request.signal?.removeEventListener("abort", abortSession);
				try {
					const activeModel = session.model;
					request.onSessionStats?.(
						session.getSessionStats(),
						activeModel ? { provider: activeModel.provider, id: activeModel.id } : undefined,
					);
				} catch {
					// Stats reporting must never mask the primary result or error.
				}
				unsubscribe?.();
				session.dispose();
			}
		},
	};
}
