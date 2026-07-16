import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publishEvoComponentArtifact } from "../src/components/artifact.ts";
import type { EvoCapabilityRequestFrame } from "../src/components/capabilities/protocol.ts";
import { EvoComponentProcess } from "../src/components/process-runtime.ts";
import { WORKFLOW_V1_ABI, type WorkflowV1Input, type WorkflowV1Output } from "../src/components/registry.ts";
import { composeWorkflowEntrypoint } from "../src/components/workflow-sdk/index.ts";
import { getEvoPaths } from "../src/paths.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function assistantRun(text: string): Record<string, unknown> {
	return {
		schemaVersion: 1,
		status: "completed",
		model: { provider: "faux", id: "faux-1" },
		turns: 1,
		stopReason: "stop",
		messages: [{ role: "assistant", content: [{ type: "text", text }] }],
	};
}

async function workflowProcess(
	body: string,
	respond: (frame: EvoCapabilityRequestFrame) => Promise<unknown>,
): Promise<{
	process: EvoComponentProcess<WorkflowV1Input, WorkflowV1Output, Record<string, never>>;
	frames: EvoCapabilityRequestFrame[];
}> {
	const root = await mkdtemp(join(tmpdir(), "pi-evo-workflow-sdk-"));
	roots.push(root);
	const paths = getEvoPaths(join(root, "evo"));
	const artifact = await publishEvoComponentArtifact(paths, {
		id: "sdk-workflow-test",
		version: "1",
		abi: "workflow/v1",
		activationBoundary: "invocation",
		capabilities: ["spawn-agent"],
		entrypointContent: await composeWorkflowEntrypoint(body),
	});
	const frames: EvoCapabilityRequestFrame[] = [];
	const process = new EvoComponentProcess<WorkflowV1Input, WorkflowV1Output, Record<string, never>>(
		artifact,
		WORKFLOW_V1_ABI,
		{},
		{
			sandbox: false,
			requestTimeoutMs: 20_000,
			capabilityBroker: {
				request: async (_identity, frame) => {
					frames.push(frame);
					return respond(frame);
				},
			},
		},
	);
	return { process, frames };
}

const HOST = { model: "faux/faux-1", tools: ["read", "bash"], maxOutputTokensPerCall: 2_048 };

describe("workflow SDK", () => {
	it("serves the protocol and returns the handler result", async () => {
		const { process } = await workflowProcess(
			`runWorkflow(async ({ trigger, args }) => ({ echoed: args.text, trigger }));`,
			async () => assistantRun("unused"),
		);
		const output = await process.invoke({ trigger: "/echo", args: { text: "hi" }, host: HOST });
		expect(output.result).toEqual({ echoed: "hi", trigger: "/echo" });
		await process.shutdown();
	});

	it("agent() defaults model/tools/output budget from the host info", async () => {
		const { process, frames } = await workflowProcess(`runWorkflow(async () => agent("Say hello"));`, async () =>
			assistantRun("hello there"),
		);
		const output = await process.invoke({ trigger: "/hello", args: {}, host: HOST });
		expect(output.result).toBe("hello there");
		expect(frames).toHaveLength(1);
		expect(frames[0]?.capability).toBe("spawn-agent");
		expect(frames[0]?.payload).toMatchObject({
			model: "faux/faux-1",
			tools: ["read", "bash"],
			maxOutputTokens: 2_048,
			prompt: "Say hello",
		});
		await process.shutdown();
	});

	it("agent() with schema parses JSON and retries once on mismatch", async () => {
		let calls = 0;
		const { process } = await workflowProcess(
			`runWorkflow(async () => agent("List files", { schema: { type: "object", required: ["files"], properties: { files: { type: "array", items: { type: "string" } } } } }));`,
			async () => {
				calls += 1;
				return calls === 1
					? assistantRun("sorry, here you go: files are a.ts and b.ts")
					: assistantRun('```json\n{"files": ["a.ts", "b.ts"]}\n```');
			},
		);
		const output = await process.invoke({ trigger: "/list", args: {}, host: HOST });
		expect(output.result).toEqual({ files: ["a.ts", "b.ts"] });
		expect(calls).toBe(2);
		await process.shutdown();
	});

	it("parallel() multiplexes concurrent capability requests and maps failures to null", async () => {
		let inFlight = 0;
		let peak = 0;
		const { process } = await workflowProcess(
			`runWorkflow(async () => parallel([
				() => agent("one"),
				() => agent("fail"),
				() => agent("three"),
			]));`,
			async (frame) => {
				inFlight += 1;
				peak = Math.max(peak, inFlight);
				await new Promise((resolve) => setTimeout(resolve, 25));
				inFlight -= 1;
				const prompt = (frame.payload as { prompt: string }).prompt;
				if (prompt.startsWith("fail")) throw new Error("boom");
				return assistantRun(prompt);
			},
		);
		const output = await process.invoke({ trigger: "/fan", args: {}, host: HOST });
		expect(output.result).toEqual(["one", null, "three"]);
		expect(peak).toBeGreaterThan(1);
		await process.shutdown();
	});

	it("pipeline() streams items through stages with (prev, item, index)", async () => {
		const { process } = await workflowProcess(
			`runWorkflow(async () =>
				pipeline(
					["a", "b"],
					(item) => agent("review " + item),
					(prev, item, index) => agent("verify " + prev + " #" + item + index),
				),
			);`,
			async (frame) => assistantRun((frame.payload as { prompt: string }).prompt),
		);
		const output = await process.invoke({ trigger: "/pipe", args: {}, host: HOST });
		expect(output.result).toEqual(["verify review a #a0", "verify review b #b1"]);
		await process.shutdown();
	});

	it("rejects the invoke when the handler throws, after draining capabilities", async () => {
		const { process } = await workflowProcess(
			`runWorkflow(async () => {
				const pending = agent("slow");
				void pending.catch(() => {});
				throw new Error("workflow exploded");
			});`,
			async () => {
				await new Promise((resolve) => setTimeout(resolve, 50));
				return assistantRun("late");
			},
		);
		await expect(process.invoke({ trigger: "/boom", args: {}, host: HOST })).rejects.toThrow("workflow exploded");
		await process.shutdown();
	});
});
