import { describe, expect, it } from "vitest";
import {
	CONTEXT_V1_ABI,
	CONTROL_V1_ABI,
	createDefaultEvoAbiRegistry,
	GENERATION_V1_ABI,
	GUARD_V1_ABI,
	INSTRUCTIONS_V1_ABI,
} from "../src/components/registry.ts";

describe("S2 host ABIs with S4 capability ceilings", () => {
	it("registers guard, instructions, generation, and control with their activation boundaries", () => {
		const registry = createDefaultEvoAbiRegistry();
		expect(
			["guard/v1", "instructions/v1", "generation/v1", "control/v1"].map((id) => {
				const abi = registry.require(id);
				return [abi.id, abi.surface, abi.activationBoundary, abi.capabilityCeiling];
			}),
		).toEqual([
			["guard/v1", "guard", "session", []],
			["instructions/v1", "instructions", "turn", ["read-file"]],
			["generation/v1", "generation", "turn", ["infer"]],
			["control/v1", "control", "session", ["memory-write"]],
		]);
	});

	it("validates guard before and after calls by mode", () => {
		expect(
			GUARD_V1_ABI.validateInput({
				mode: "before",
				toolCallId: "call-1",
				toolName: "read",
				args: { path: "README.md" },
			}),
		).toMatchObject({ mode: "before", toolName: "read" });
		expect(GUARD_V1_ABI.validateOutput({ mode: "before", args: { path: "CHANGELOG.md" } })).toMatchObject({
			mode: "before",
		});
		expect(
			GUARD_V1_ABI.validateInput({
				mode: "after",
				toolCallId: "call-1",
				toolName: "read",
				args: { path: "README.md" },
				content: [{ type: "text", text: "ok" }],
				isError: false,
			}),
		).toMatchObject({ mode: "after", isError: false });
		expect(GUARD_V1_ABI.validateOutput({ mode: "after", terminate: true })).toEqual({
			mode: "after",
			terminate: true,
		});
		expect(() =>
			GUARD_V1_ABI.validateInput({
				mode: "before",
				toolCallId: "call-1",
				toolName: "read",
				args: {},
				isError: false,
			}),
		).toThrow(/unknown key/);
		expect(() => GUARD_V1_ABI.validateOutput({ mode: "before", terminate: true })).toThrow(/unknown key/);
		expect(() =>
			GUARD_V1_ABI.validateOutput({
				mode: "after",
				content: [{ type: "thinking", thinking: "not valid tool output" }],
			}),
		).toThrow(/text or image/);
	});

	it("rejects incomplete or malformed context messages from sandbox output", () => {
		expect(
			CONTEXT_V1_ABI.validateOutput({
				messages: [{ role: "user", content: "valid", timestamp: 1 }],
			}),
		).toMatchObject({ messages: [{ role: "user" }] });
		expect(
			CONTEXT_V1_ABI.validateOutput({
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", text: "valid" }],
						api: "test-api",
						provider: "test",
						model: "test-model",
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: 1,
					},
				],
			}),
		).toMatchObject({ messages: [{ role: "assistant" }] });
		expect(() =>
			CONTEXT_V1_ABI.validateOutput({
				messages: [{ role: "assistant", content: [{ type: "text", text: "missing metadata" }] }],
			}),
		).toThrow(/\.api/);
		expect(() =>
			CONTEXT_V1_ABI.validateOutput({
				messages: [
					{
						role: "toolResult",
						toolCallId: "call-1",
						toolName: "read",
						content: [{ type: "thinking", thinking: "invalid" }],
						isError: false,
						timestamp: 1,
					},
				],
			}),
		).toThrow(/text or image/);
	});

	it("validates instructions as either a full prompt or named sections", () => {
		expect(INSTRUCTIONS_V1_ABI.validateInput({ systemPrompt: "base", options: { cwd: "/tmp" } })).toEqual({
			systemPrompt: "base",
			options: { cwd: "/tmp" },
		});
		expect(INSTRUCTIONS_V1_ABI.validateOutput({ systemPrompt: "replacement" })).toEqual({
			systemPrompt: "replacement",
		});
		expect(
			INSTRUCTIONS_V1_ABI.validateOutput({
				sections: [{ name: "base", content: "first" }, { content: "second" }],
			}),
		).toMatchObject({ sections: [{ name: "base" }, { content: "second" }] });
		expect(() => INSTRUCTIONS_V1_ABI.validateOutput({ systemPrompt: "x", sections: [{ content: "y" }] })).toThrow(
			/exactly one/,
		);
	});

	it("validates generation replacements and rejects empty output", () => {
		expect(GENERATION_V1_ABI.validateInput({ message: { role: "assistant", content: [] } })).toMatchObject({
			message: { role: "assistant" },
		});
		expect(
			GENERATION_V1_ABI.validateOutput({
				message: { role: "assistant", content: [{ type: "text", text: "revised" }] },
				stopReason: "stop",
			}),
		).toMatchObject({ stopReason: "stop" });
		expect(() => GENERATION_V1_ABI.validateOutput({})).toThrow(/must contain/);
		expect(() => GENERATION_V1_ABI.validateOutput({ stopReason: "unknown" })).toThrow(/stopReason is invalid/);
		expect(() =>
			GENERATION_V1_ABI.validateOutput({
				message: { role: "assistant", content: [{ type: "image", data: "x", mimeType: "image/png" }] },
			}),
		).toThrow(/text or thinking/);
		expect(() =>
			GENERATION_V1_ABI.validateOutput({
				message: { role: "assistant", content: [{ type: "unknown", text: "invalid" }] },
			}),
		).toThrow(/text or thinking/);
	});

	it("validates control routing and explicitly rejects message rewrites", () => {
		expect(
			CONTROL_V1_ABI.validateInput({
				turnIndex: 0,
				message: { role: "assistant", content: [] },
				toolResults: [],
				usage: { tokens: null, contextWindow: 200_000, percent: null },
				model: "provider/model",
				reasoning: "high",
			}),
		).toMatchObject({ turnIndex: 0 });
		expect(CONTROL_V1_ABI.validateOutput({ stop: true, model: "provider/other", reasoning: "low" })).toEqual({
			stop: true,
			model: "provider/other",
			reasoning: "low",
		});
		expect(() => CONTROL_V1_ABI.validateOutput({ messages: [] })).toThrow(/unknown key/);
		expect(() => CONTROL_V1_ABI.validateOutput({})).toThrow(/must contain/);
	});

	it("rejects non-empty config for every S2 ABI", () => {
		for (const abi of [GUARD_V1_ABI, INSTRUCTIONS_V1_ABI, GENERATION_V1_ABI, CONTROL_V1_ABI]) {
			expect(() => abi.validateConfig({ unexpected: true })).toThrow(/unknown key/);
		}
	});
});
