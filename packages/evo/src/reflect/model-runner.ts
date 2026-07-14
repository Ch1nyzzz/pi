import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	type AuthStorage,
	createAgentSessionFromServices,
	createAgentSessionServices,
	type ModelRegistry,
	resolveCliModel,
	SessionManager,
	type SessionStats,
} from "@earendil-works/pi-coding-agent";

export interface ModelRunRequest {
	cwd: string;
	agentDir?: string;
	systemPrompt: string;
	prompt: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	history?: readonly AgentMessage[];
	/** Stable provider session identity used to reuse replay prompt caches. */
	sessionIdentity?: string;
}

export interface ModelRunResult {
	text: string;
	stats: SessionStats;
	model: {
		provider: string;
		id: string;
	};
}

export interface ModelRunner {
	run(request: ModelRunRequest): Promise<ModelRunResult>;
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

			const sessionManager = SessionManager.inMemory(request.cwd, { id: request.sessionIdentity });
			const { session, modelFallbackMessage } = await createAgentSessionFromServices({
				services,
				sessionManager,
				model: resolvedModel?.model,
				thinkingLevel: request.thinkingLevel ?? resolvedModel?.thinkingLevel,
				noTools: "all",
			});

			try {
				const activeModel = session.model;
				if (!activeModel) {
					throw new Error(modelFallbackMessage ?? "No model is available for the model runner");
				}

				// The SDK appends deterministic date/cwd metadata to this fixed role prompt.
				session.agent.state.messages = request.history ? [...request.history] : [];

				await session.prompt(request.prompt, { expandPromptTemplates: false });

				const finalMessage = session.messages.at(-1);
				if (!finalMessage || finalMessage.role !== "assistant") {
					throw new Error("Model run completed without a final assistant message");
				}
				if (finalMessage.stopReason !== "stop") {
					const detail = finalMessage.errorMessage ? `: ${finalMessage.errorMessage}` : "";
					throw new Error(`Model run ended with stop reason "${finalMessage.stopReason}"${detail}`);
				}

				const text = finalMessage.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("")
					.trim();
				if (!text) {
					throw new Error("Model run completed without text output");
				}

				return {
					text,
					stats: session.getSessionStats(),
					model: { provider: activeModel.provider, id: activeModel.id },
				};
			} finally {
				session.dispose();
			}
		},
	};
}
