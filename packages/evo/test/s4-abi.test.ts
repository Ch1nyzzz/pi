import { describe, expect, it } from "vitest";
import {
	CONTEXT_V1_ABI,
	CONTROL_V1_ABI,
	createDefaultEvoAbiRegistry,
	GENERATION_V1_ABI,
	INSTRUCTIONS_V1_ABI,
	MEMORY_V1_ABI,
	TOOL_V1_ABI,
	WORKFLOW_V1_ABI,
} from "../src/components/registry.ts";

describe("S4 thinking-component ABIs", () => {
	it("registers the frozen ABIs with their activation boundaries and capability ceilings", () => {
		const registry = createDefaultEvoAbiRegistry();
		expect(
			["tool/v1", "memory/v1", "workflow/v1"].map((id) => {
				const abi = registry.require(id);
				return [abi.id, abi.surface, abi.activationBoundary, abi.capabilityCeiling];
			}),
		).toEqual([
			["tool/v1", "tool", "session", ["exec", "http-fetch", "infer", "list-dir", "read-file", "write-file"]],
			["memory/v1", "memory", "session", ["infer", "memory-read", "memory-write", "retrieve"]],
			["workflow/v1", "workflow", "invocation", ["memory-read", "memory-write", "spawn-agent"]],
		]);
		expect(INSTRUCTIONS_V1_ABI.capabilityCeiling).toEqual(["read-file"]);
		expect(CONTEXT_V1_ABI.capabilityCeiling).toEqual(["infer", "retrieve"]);
		expect(GENERATION_V1_ABI.capabilityCeiling).toEqual(["infer"]);
		expect(CONTROL_V1_ABI.capabilityCeiling).toEqual(["memory-write"]);
	});

	it("validates tool params and the JSON-safe AgentToolResult envelope", () => {
		expect(TOOL_V1_ABI.validateInput({ params: { path: "README.md", limit: 10 } })).toEqual({
			params: { path: "README.md", limit: 10 },
		});
		expect(
			TOOL_V1_ABI.validateOutput({
				content: [
					{ type: "text", text: "ok", textSignature: "signature" },
					{ type: "image", data: "YWJj", mimeType: "image/png" },
				],
				details: { path: "README.md" },
				addedToolNames: ["follow-up"],
				terminate: true,
			}),
		).toMatchObject({ terminate: true, details: { path: "README.md" } });
		expect(() => TOOL_V1_ABI.validateInput({ params: {}, signal: "live-object" })).toThrow(/unknown key/);
		expect(() => TOOL_V1_ABI.validateOutput({ content: [], details: null, isError: false })).toThrow(/unknown key/);
		expect(() =>
			TOOL_V1_ABI.validateOutput({ content: [{ type: "thinking", thinking: "x" }], details: null }),
		).toThrow(/type must be/);
		expect(() => TOOL_V1_ABI.validateOutput({ content: [] })).toThrow(/details is required/);
	});

	it("validates all memory lifecycle modes and rejects cross-mode fields", () => {
		expect(MEMORY_V1_ABI.validateInput({ mode: "recall", query: "preferred editor" })).toEqual({
			mode: "recall",
			query: "preferred editor",
		});
		expect(
			MEMORY_V1_ABI.validateOutput({
				mode: "recall",
				fragments: [{ id: "memory-1", text: "Use tabs" }],
			}),
		).toMatchObject({ mode: "recall" });
		expect(
			MEMORY_V1_ABI.validateInput({
				mode: "encode",
				turnDigest: { user: "change formatter", outcome: "done" },
			}),
		).toMatchObject({ mode: "encode" });
		expect(
			MEMORY_V1_ABI.validateOutput({
				mode: "encode",
				writes: [{ id: "memory-2", text: "Use biome" }],
				updates: [{ id: "memory-1", text: "Use tabs in source" }],
				forgets: ["obsolete-memory"],
			}),
		).toMatchObject({ mode: "encode" });
		expect(
			MEMORY_V1_ABI.validateInput({
				mode: "consolidate",
				candidates: [{ id: "memory-1" }, { id: "memory-2" }],
			}),
		).toMatchObject({ mode: "consolidate" });
		expect(
			MEMORY_V1_ABI.validateOutput({
				mode: "consolidate",
				merged: [{ id: "memory-3", sources: ["memory-1", "memory-2"] }],
				insights: [{ text: "Formatting preference" }],
				forget: ["memory-1", "memory-2"],
			}),
		).toMatchObject({ mode: "consolidate" });
		expect(() => MEMORY_V1_ABI.validateInput({ mode: "recall", query: "x", candidates: [] })).toThrow(/unknown key/);
		expect(() => MEMORY_V1_ABI.validateOutput({ mode: "encode", writes: [], updates: [], forgets: [""] })).toThrow(
			/non-empty string/,
		);
		expect(() =>
			MEMORY_V1_ABI.validateOutput({ mode: "consolidate", merged: [], insights: ["not-a-record"], forget: [] }),
		).toThrow(/must be an object/);
	});

	it("validates control memory deltas without admitting message rewrites", () => {
		expect(
			CONTROL_V1_ABI.validateOutput({
				memoryDeltas: [{ operation: "write", namespace: "semantic", value: { fact: "Use tabs" } }],
			}),
		).toMatchObject({ memoryDeltas: [{ operation: "write" }] });
		expect(() => CONTROL_V1_ABI.validateOutput({ memoryDeltas: ["not-a-record"] })).toThrow(/must be an object/);
		expect(() => CONTROL_V1_ABI.validateOutput({ memoryDeltas: [], messages: [] })).toThrow(/unknown key/);
	});

	it("validates workflow invocation input and a single JSON result envelope", () => {
		expect(WORKFLOW_V1_ABI.validateInput({ trigger: "deep-review", args: { paths: ["src"] } })).toEqual({
			trigger: "deep-review",
			args: { paths: ["src"] },
		});
		expect(WORKFLOW_V1_ABI.validateOutput({ result: { status: "complete", agents: 3 } })).toEqual({
			result: { agents: 3, status: "complete" },
		});
		expect(() => WORKFLOW_V1_ABI.validateInput({ trigger: "deep-review", args: [], context: {} })).toThrow(
			/unknown key/,
		);
		expect(() => WORKFLOW_V1_ABI.validateOutput({})).toThrow(/result is required/);
		expect(() => WORKFLOW_V1_ABI.validateOutput({ result: { value: 1 }, agents: [] })).toThrow(/unknown key/);
	});

	it("keeps all S4 ABI configs fail-closed", () => {
		for (const abi of [TOOL_V1_ABI, MEMORY_V1_ABI, WORKFLOW_V1_ABI]) {
			expect(() => abi.validateConfig({ unexpected: true })).toThrow(/unknown key/);
		}
	});
});
