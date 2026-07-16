import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type EvoBudgetedCapabilityGrant, EvoCapabilityBroker } from "../src/components/capabilities/broker.ts";
import { parseEvoCapabilityRequestFrame } from "../src/components/capabilities/protocol.ts";
import type { EvoCapabilityComponentIdentity } from "../src/components/capabilities/service.ts";
import {
	createSpawnAgentCapabilityService,
	type EvoRawSpawnAgentHost,
} from "../src/components/capabilities/spawn-agent.ts";
import { getEvoPaths } from "../src/paths.ts";

interface TestModel {
	route: string;
}

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const identity: EvoCapabilityComponentIdentity = {
	id: "workflow-component",
	abi: "workflow/v1",
	artifactDigest: "c".repeat(64),
	declaredCapabilities: ["spawn-agent"],
	abiCapabilityCeiling: ["spawn-agent"],
};

const context = (signal = new AbortController().signal) => ({
	component: identity,
	capability: "spawn-agent" as const,
	signal,
});

const reservation = {
	inputTokens: 1_000,
	outputTokens: 500,
	totalTokens: 1_500,
	costUsd: 0.5,
};

const actualUsage = {
	inputTokens: 120,
	outputTokens: 80,
	totalTokens: 200,
	costUsd: 0.05,
};

function createHost(
	runAgent: EvoRawSpawnAgentHost<TestModel>["runAgent"] = async () => ({
		result: { final: "done", trace: [{ role: "assistant", content: "done" }] },
		usage: actualUsage,
	}),
): EvoRawSpawnAgentHost<TestModel> {
	return {
		resolveModel(route) {
			return route === "faux/test" ? { route } : undefined;
		},
		estimateReservation() {
			return reservation;
		},
		runAgent,
	};
}

const request = {
	model: "faux/test",
	prompt: "Review these files and return the complete findings.",
	reasoning: "high" as const,
	maxOutputTokens: 400,
	tools: ["read", "grep"],
};

describe("spawn-agent capability service", () => {
	it("strictly validates the workflow request and returns broker authorization hints", () => {
		const service = createSpawnAgentCapabilityService(createHost());
		expect(service.prepare({ ...request, tools: ["read", "grep"] }, context())).toEqual({
			request: { ...request, tools: ["grep", "read"] },
			reservation,
			authorization: {
				model: "faux/test",
				maxOutputTokens: 400,
				tools: ["grep", "read"],
			},
		});
		expect(() => service.prepare({ ...request, tools: undefined }, context())).toThrow("tools must be an array");
		expect(() => service.prepare({ ...request, reasoning: "unbounded" }, context())).toThrow("reasoning is invalid");
		expect(() => service.prepare({ ...request, tools: ["read", "read"] }, context())).toThrow("duplicates");
		expect(() => service.prepare({ ...request, apiKey: "must-not-cross-the-boundary" }, context())).toThrow(
			"unknown key: apiKey",
		);
		expect(() => service.prepare({ ...request, model: "unavailable/model" }, context())).toThrow(
			"model is unavailable",
		);
	});

	it("passes only the normalized request and abort signal to the trusted host and returns its full JSON result", async () => {
		const calls: unknown[] = [];
		const controller = new AbortController();
		const result = {
			model: "faux/test",
			final: { role: "assistant", content: [{ type: "text", text: "complete report" }] },
			trace: [
				{ role: "user", content: request.prompt },
				{ role: "assistant", content: [{ type: "toolCall", name: "read" }] },
				{ role: "toolResult", content: "source" },
			],
		};
		const service = createSpawnAgentCapabilityService(
			createHost(async (model, receivedRequest, options) => {
				calls.push({ model, receivedRequest, signal: options.signal });
				return { result, usage: actualUsage };
			}),
		);
		const prepared = service.prepare(request, context(controller.signal));

		await expect(service.execute(prepared.request, context(controller.signal))).resolves.toEqual({
			result,
			usage: actualUsage,
		});
		expect(calls).toEqual([
			{
				model: { route: "faux/test" },
				receivedRequest: { ...request, tools: ["grep", "read"] },
				signal: controller.signal,
			},
		]);
	});

	it("propagates aborts and rejects host usage above the conservative reservation", async () => {
		let releaseStarted: (() => void) | undefined;
		const started = new Promise<void>((resolvePromise) => {
			releaseStarted = resolvePromise;
		});
		const controller = new AbortController();
		const abortReason = new Error("cancel workflow");
		const abortingService = createSpawnAgentCapabilityService(
			createHost(
				async (_model, _receivedRequest, options) =>
					new Promise((_resolvePromise, reject) => {
						releaseStarted?.();
						options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
					}),
			),
		);
		const running = abortingService.execute(request, context(controller.signal));
		await started;
		controller.abort(abortReason);
		await expect(running).rejects.toBe(abortReason);

		const overBudgetService = createSpawnAgentCapabilityService(
			createHost(async () => ({
				result: { final: "too expensive" },
				usage: { ...actualUsage, outputTokens: 501, totalTokens: 621 },
			})),
		);
		await expect(overBudgetService.execute(request, context())).rejects.toThrow("exceeded reserved outputTokens");
	});

	it("lets the broker enforce model/tool grants and audit the complete run result", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-evo-spawn-agent-"));
		roots.push(root);
		const paths = getEvoPaths(join(root, "evo"));
		let runs = 0;
		const result = {
			final: "complete report",
			trace: [
				{ role: "user", content: request.prompt },
				{ role: "assistant", content: "complete report" },
			],
		};
		const broker = new EvoCapabilityBroker({
			paths,
			services: {
				"spawn-agent": createSpawnAgentCapabilityService(
					createHost(async () => {
						runs += 1;
						return { result, usage: actualUsage };
					}),
				),
			},
		});
		const grant: EvoBudgetedCapabilityGrant = {
			capability: "spawn-agent",
			maxCalls: 2,
			models: ["faux/test"],
			maxInputTokens: 2_000,
			maxOutputTokens: 1_000,
			maxTotalTokens: 3_000,
			maxCostUsd: 1,
			maxOutputTokensPerCall: 500,
			tools: ["read"],
		};
		const restrictedAuthority = await broker.replaceComponentGrants(identity, [grant]);
		const frame = parseEvoCapabilityRequestFrame({
			type: "capability-request",
			invokeId: 1,
			id: "spawn-1",
			capability: "spawn-agent",
			payload: request,
		});
		await expect(
			broker.request(restrictedAuthority, identity, frame, new AbortController().signal),
		).rejects.toMatchObject({
			code: "tool_restricted",
		});
		expect(runs).toBe(0);

		const fullAuthority = await broker.replaceComponentGrants(identity, [{ ...grant, tools: ["grep", "read"] }]);
		await expect(broker.request(fullAuthority, identity, frame, new AbortController().signal)).resolves.toEqual(
			result,
		);
		expect(runs).toBe(1);
		const audit = (await readFile(join(paths.log, "capability-audit.jsonl"), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(audit.at(-1)).toMatchObject({
			type: "capability-result",
			ok: true,
			result,
			usage: actualUsage,
		});
	});
});
