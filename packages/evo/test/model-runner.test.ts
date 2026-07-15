import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createPiModelRunner } from "../src/reflect/model-runner.ts";

const registrations: Array<{ unregister(): void }> = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) registration.unregister();
});

function createFauxRunner() {
	const faux = registerFauxProvider();
	registrations.push(faux);
	const model = faux.getModel();
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(model.provider, "faux-key");
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	modelRegistry.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "faux-key",
		api: faux.api,
		models: faux.models.map((registeredModel) => ({
			id: registeredModel.id,
			name: registeredModel.name,
			api: registeredModel.api,
			reasoning: registeredModel.reasoning,
			input: registeredModel.input,
			cost: registeredModel.cost,
			contextWindow: registeredModel.contextWindow,
			maxTokens: registeredModel.maxTokens,
			baseUrl: registeredModel.baseUrl,
		})),
	});
	return {
		faux,
		model,
		runner: createPiModelRunner({ authStorage, modelRegistry }),
	};
}

describe("createPiModelRunner", () => {
	it("runs an isolated tool-free session with replay history and a stable identity", async () => {
		const { faux, model, runner } = createFauxRunner();
		const history: AgentMessage[] = [
			{ role: "user", content: "earlier question", timestamp: 1 },
			fauxAssistantMessage("earlier answer", { timestamp: 2 }),
		];
		faux.setResponses([
			(context, options) => {
				expect(context.systemPrompt).toMatch(
					/^fixed judge prompt\n(?:Current date: \d{4}-\d{2}-\d{2}\n)?Current working directory:/,
				);
				expect(context.systemPrompt).toContain(`Current working directory: ${process.cwd()}`);
				expect(context.tools).toEqual([]);
				expect(context.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
				expect(context.messages[0]).toMatchObject({
					role: "user",
					content: "earlier question",
				});
				expect(context.messages[2]).toMatchObject({
					role: "user",
					content: [{ type: "text", text: "review this" }],
				});
				expect(options?.sessionId).toBe("replay-session-1");
				return fauxAssistantMessage("grounded review");
			},
		]);

		const result = await runner.run({
			cwd: process.cwd(),
			systemPrompt: "fixed judge prompt",
			prompt: "review this",
			model: `${model.provider}/${model.id}`,
			thinkingLevel: "off",
			history,
			sessionIdentity: "replay-session-1",
		});

		expect(result.text).toBe("grounded review");
		expect(result.model).toEqual({ provider: model.provider, id: model.id });
		expect(result.stats.sessionId).toBe("replay-session-1");
		expect(result.stats.userMessages).toBe(1);
		expect(result.stats.assistantMessages).toBe(1);
		expect(result.stats.tokens.input).toBeGreaterThan(0);
		expect(result.stats.tokens.output).toBeGreaterThan(0);
	});

	it("exposes the live headless-agent stream", async () => {
		const { faux, model, runner } = createFauxRunner();
		faux.setResponses([fauxAssistantMessage("streamed result")]);
		const events: Array<{ type: string; delta?: string; stopReason?: string }> = [];
		await runner.run({
			cwd: process.cwd(),
			systemPrompt: "judge",
			prompt: "review",
			model: `${model.provider}/${model.id}`,
			onStreamEvent: (event) => events.push(event),
		});
		expect(
			events
				.filter((event) => event.type === "text")
				.map((event) => event.delta)
				.join(""),
		).toBe("streamed result");
		expect(events.at(-1)).toMatchObject({ type: "complete", stopReason: "stop" });
	});

	it("does not reuse messages between runs", async () => {
		const { faux, model, runner } = createFauxRunner();
		faux.setResponses([
			fauxAssistantMessage("first result"),
			(context) => {
				expect(context.messages).toHaveLength(1);
				expect(context.messages[0]).toMatchObject({
					role: "user",
					content: [{ type: "text", text: "second prompt" }],
				});
				return fauxAssistantMessage("second result");
			},
		]);
		const request = {
			cwd: process.cwd(),
			systemPrompt: "judge",
			model: `${model.provider}/${model.id}`,
		};

		await runner.run({ ...request, prompt: "first prompt" });
		const result = await runner.run({ ...request, prompt: "second prompt" });

		expect(result.text).toBe("second result");
		expect(faux.state.callCount).toBe(2);
	});

	it("rejects non-successful assistant stop reasons", async () => {
		const { faux, model, runner } = createFauxRunner();
		faux.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "provider failed",
			}),
		]);

		await expect(
			runner.run({
				cwd: process.cwd(),
				systemPrompt: "judge",
				prompt: "review",
				model: `${model.provider}/${model.id}`,
			}),
		).rejects.toThrow('Model run ended with stop reason "error": provider failed');
	});

	it("recovers from a length stop with a follow-up prompt in the same session", async () => {
		const { faux, model, runner } = createFauxRunner();
		faux.setResponses([
			fauxAssistantMessage("{ truncated partial", { stopReason: "length" }),
			(context) => {
				const lastMessage = context.messages.at(-1);
				expect(lastMessage).toMatchObject({ role: "user" });
				expect(JSON.stringify(lastMessage?.content)).toContain("cut off");
				return fauxAssistantMessage('{"final": true}');
			},
		]);
		const events: Array<{ type: string; attempt?: number; stopReason?: string }> = [];

		const result = await runner.run({
			cwd: process.cwd(),
			systemPrompt: "judge",
			prompt: "review",
			model: `${model.provider}/${model.id}`,
			onStreamEvent: (event) => events.push(event),
		});

		expect(result.text).toBe('{"final": true}');
		expect(events.some((event) => event.type === "length-recovery" && event.attempt === 1)).toBe(true);
		expect(events.at(-1)).toMatchObject({ type: "complete", stopReason: "stop" });
		expect(faux.state.callCount).toBe(2);
	});

	it("uses the custom recovery prompt when provided", async () => {
		const { faux, model, runner } = createFauxRunner();
		faux.setResponses([
			fauxAssistantMessage("partial", { stopReason: "length" }),
			(context) => {
				expect(JSON.stringify(context.messages.at(-1)?.content)).toContain("emit the frozen JSON");
				return fauxAssistantMessage("done");
			},
		]);

		const result = await runner.run({
			cwd: process.cwd(),
			systemPrompt: "judge",
			prompt: "review",
			model: `${model.provider}/${model.id}`,
			recoveryPrompt: "Budget exhausted: emit the frozen JSON now without tools.",
		});

		expect(result.text).toBe("done");
	});

	it("gives up after the configured number of length recoveries", async () => {
		const { faux, model, runner } = createFauxRunner();
		faux.setResponses([
			fauxAssistantMessage("partial one", { stopReason: "length" }),
			fauxAssistantMessage("partial two", { stopReason: "length" }),
			fauxAssistantMessage("partial three", { stopReason: "length" }),
		]);

		await expect(
			runner.run({
				cwd: process.cwd(),
				systemPrompt: "judge",
				prompt: "review",
				model: `${model.provider}/${model.id}`,
			}),
		).rejects.toThrow('Model run ended with stop reason "length" after 2 length recoveries');
		expect(faux.state.callCount).toBe(3);
	});

	const VERDICT_SUBMISSION = {
		toolName: "submit_verdict",
		description: "Deliver the final verdict.",
		parameters: Type.Object({
			verdict: StringEnum(["verified", "needs-evidence", "unsupported", "invalid"] as const),
			summary: Type.String({ minLength: 1 }),
		}),
	};

	it("returns the object delivered through the submission tool", async () => {
		const { faux, model, runner } = createFauxRunner();
		faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("submit_verdict", { verdict: "needs-evidence", summary: "trial missing" }),
			]),
			fauxAssistantMessage("submitted"),
		]);

		const result = await runner.run({
			cwd: process.cwd(),
			systemPrompt: "judge",
			prompt: "evaluate",
			model: `${model.provider}/${model.id}`,
			submission: VERDICT_SUBMISSION,
		});

		expect(result.submission).toEqual({ verdict: "needs-evidence", summary: "trial missing" });
	});

	it("reprompts when the model forgets to submit, then succeeds", async () => {
		const { faux, model, runner } = createFauxRunner();
		faux.setResponses([
			fauxAssistantMessage("I think the verdict is verified."),
			(context) => {
				expect(JSON.stringify(context.messages.at(-1)?.content)).toContain("submit_verdict");
				return fauxAssistantMessage([fauxToolCall("submit_verdict", { verdict: "verified", summary: "ok" })]);
			},
			fauxAssistantMessage("done"),
		]);
		const events: Array<{ type: string }> = [];

		const result = await runner.run({
			cwd: process.cwd(),
			systemPrompt: "judge",
			prompt: "evaluate",
			model: `${model.provider}/${model.id}`,
			submission: VERDICT_SUBMISSION,
			onStreamEvent: (event) => events.push(event),
		});

		expect(result.submission).toEqual({ verdict: "verified", summary: "ok" });
		expect(events.some((event) => event.type === "submission-retry")).toBe(true);
	});

	it("feeds validate rejections back as tool errors and accepts the retry", async () => {
		const { faux, model, runner } = createFauxRunner();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("submit_verdict", { verdict: "verified", summary: "weak" })]),
			(context) => {
				expect(JSON.stringify(context.messages.at(-1)?.content)).toContain("summary is too weak");
				return fauxAssistantMessage([
					fauxToolCall("submit_verdict", { verdict: "verified", summary: "strong justification" }),
				]);
			},
			fauxAssistantMessage("done"),
		]);

		const result = await runner.run({
			cwd: process.cwd(),
			systemPrompt: "judge",
			prompt: "evaluate",
			model: `${model.provider}/${model.id}`,
			submission: {
				...VERDICT_SUBMISSION,
				validate: (params) => {
					if ((params.summary as string).length < 10) throw new Error("summary is too weak");
				},
			},
		});

		expect(result.submission).toEqual({ verdict: "verified", summary: "strong justification" });
	});

	it("fails after bounded submission reprompts", async () => {
		const { faux, model, runner } = createFauxRunner();
		faux.setResponses([
			fauxAssistantMessage("no submission"),
			fauxAssistantMessage("still no submission"),
			fauxAssistantMessage("nothing"),
		]);

		await expect(
			runner.run({
				cwd: process.cwd(),
				systemPrompt: "judge",
				prompt: "evaluate",
				model: `${model.provider}/${model.id}`,
				submission: VERDICT_SUBMISSION,
			}),
		).rejects.toThrow("Model run ended without a submit_verdict submission");
	});

	it("disables length recovery when maxLengthRecoveries is zero", async () => {
		const { faux, model, runner } = createFauxRunner();
		faux.setResponses([fauxAssistantMessage("partial", { stopReason: "length" })]);

		await expect(
			runner.run({
				cwd: process.cwd(),
				systemPrompt: "judge",
				prompt: "review",
				model: `${model.provider}/${model.id}`,
				maxLengthRecoveries: 0,
			}),
		).rejects.toThrow('Model run ended with stop reason "length"');
		expect(faux.state.callCount).toBe(1);
	});
});
