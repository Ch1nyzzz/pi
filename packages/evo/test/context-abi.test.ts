import { describe, expect, it } from "vitest";
import { CONTEXT_V1_ABI, createDefaultEvoAbiRegistry } from "../src/components/registry.ts";

describe("context/v1 ABI", () => {
	it("is registered alongside compaction/v1 (backward compatible)", () => {
		const registry = createDefaultEvoAbiRegistry();
		expect(registry.require("compaction/v1").surface).toBe("compaction");
		expect(registry.require("context/v1").surface).toBe("context");
		expect(registry.require("context/v1").activationBoundary).toBe("session");
		expect(registry.require("context/v1").capabilityCeiling).toEqual(["infer", "retrieve"]);
	});

	describe("transform mode", () => {
		it("accepts a valid message-array transform input and output", () => {
			const input = CONTEXT_V1_ABI.validateInput({
				mode: "transform",
				messages: [{ role: "user", content: "hello", timestamp: 1 }],
				reason: "turn",
				tokenEstimate: 10,
				contextWindow: 1000,
			});
			expect(input.mode).toBe("transform");
			const output = CONTEXT_V1_ABI.validateOutput({
				messages: [{ role: "user", content: "hello", timestamp: 1 }],
			});
			expect(Array.isArray((output as { messages: unknown[] }).messages)).toBe(true);
		});

		it("rejects a non-array messages input", () => {
			expect(() => CONTEXT_V1_ABI.validateInput({ mode: "transform", messages: "nope", reason: "turn" })).toThrow(
				/messages/,
			);
		});

		it("rejects a wrong reason for transform", () => {
			expect(() => CONTEXT_V1_ABI.validateInput({ mode: "transform", messages: [], reason: "threshold" })).toThrow(
				/reason/,
			);
		});
	});

	describe("checkpoint mode (compaction-compatible)", () => {
		it("accepts a valid checkpoint input and output", () => {
			const input = CONTEXT_V1_ABI.validateInput({
				mode: "checkpoint",
				conversation: "u: hi\na: hello",
				firstKeptEntryId: "e5",
				tokensBefore: 1200,
				reason: "threshold",
			});
			expect(input.mode).toBe("checkpoint");
			const output = CONTEXT_V1_ABI.validateOutput({
				summary: "User greeted; assistant replied.",
				firstKeptEntryId: "e5",
				metrics: { inputTokens: 100 },
			});
			expect((output as { summary: string }).summary).toContain("greeted");
		});

		it("rejects a checkpoint input missing firstKeptEntryId", () => {
			expect(() =>
				CONTEXT_V1_ABI.validateInput({
					mode: "checkpoint",
					conversation: "x",
					firstKeptEntryId: "",
					tokensBefore: 1,
					reason: "manual",
				}),
			).toThrow(/checkpoint input/);
		});

		it("rejects a checkpoint output with an empty summary", () => {
			expect(() => CONTEXT_V1_ABI.validateOutput({ summary: "   ", firstKeptEntryId: "e1" })).toThrow(/summary/);
		});
	});

	it("rejects an unknown mode", () => {
		expect(() => CONTEXT_V1_ABI.validateInput({ mode: "delete-everything", messages: [] })).toThrow(/mode/);
	});

	it("rejects output that is neither transform nor checkpoint shaped", () => {
		expect(() => CONTEXT_V1_ABI.validateOutput({ nonsense: true })).toThrow(/transform.*checkpoint|checkpoint/);
	});

	it("validates config keys", () => {
		expect(CONTEXT_V1_ABI.validateConfig({ maxSummaryTokens: 500, style: "structured" })).toEqual({
			maxSummaryTokens: 500,
			style: "structured",
		});
		expect(() => CONTEXT_V1_ABI.validateConfig({ bogus: 1 })).toThrow(/unknown key/);
	});
});
