import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@ch1nyzzz/pi-ai";
import type { ModelRegistry } from "@ch1nyzzz/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
	type EvoBudgetedCapabilityGrant,
	EvoCapabilityBroker,
	EvoCapabilityDeniedError,
} from "../src/components/capabilities/broker.ts";
import {
	createInferCapabilityService,
	createModelRegistryInferHost,
	type EvoRawInferHost,
} from "../src/components/capabilities/infer.ts";
import { parseEvoCapabilityRequestFrame } from "../src/components/capabilities/protocol.ts";
import type { EvoCapabilityComponentIdentity, EvoCapabilityService } from "../src/components/capabilities/service.ts";
import { getEvoPaths } from "../src/paths.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-evo-capability-"));
	roots.push(root);
	return { root, paths: getEvoPaths(join(root, "evo")) };
}

const identity: EvoCapabilityComponentIdentity = {
	id: "thinking-component",
	abi: "context/v1",
	artifactDigest: "a".repeat(64),
	declaredCapabilities: ["infer", "read-file"],
	abiCapabilityCeiling: ["infer", "read-file"],
};

const inferGrant: EvoBudgetedCapabilityGrant = {
	capability: "infer",
	maxCalls: 2,
	models: ["faux/test"],
	maxInputTokens: 1_000,
	maxOutputTokens: 1_000,
	maxTotalTokens: 2_000,
	maxCostUsd: 1,
	maxOutputTokensPerCall: 500,
};

function inferFrame(id = "infer-1") {
	return parseEvoCapabilityRequestFrame({
		type: "capability-request",
		invokeId: 7,
		id,
		capability: "infer",
		payload: { model: "faux/test", prompt: "full prompt", maxOutputTokens: 100 },
	});
}

function inferService(execute?: EvoCapabilityService["execute"]): EvoCapabilityService {
	return {
		prepare(payload) {
			return {
				request: payload,
				reservation: { inputTokens: 100, outputTokens: 100, totalTokens: 200, costUsd: 0.1 },
				authorization: { model: "faux/test", maxOutputTokens: 100 },
			};
		},
		execute:
			execute ??
			(async () => ({
				result: { text: "full response" },
				usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.01 },
			})),
	};
}

describe("capability protocol", () => {
	it("requires one strict capability-request frame shape", () => {
		expect(() =>
			parseEvoCapabilityRequestFrame({
				type: "capability-request",
				invokeId: 1,
				id: "nested-1",
				capability: "infer",
			}),
		).toThrow("payload is required");
		expect(() =>
			parseEvoCapabilityRequestFrame({
				type: "capability-request",
				invokeId: 1,
				id: "nested-1",
				capability: "infer",
				payload: {},
				extra: true,
			}),
		).toThrow("unknown key");
		expect(() =>
			parseEvoCapabilityRequestFrame({
				type: "capability-request",
				invokeId: 1,
				id: "nested-1",
				capability: "ambient-network",
				payload: {},
			}),
		).toThrow("unsupported");
	});
});

describe("Evo capability broker", () => {
	it("keeps infer off by default and audits the complete denied request", async () => {
		const { paths } = await fixture();
		const broker = new EvoCapabilityBroker({ paths, services: { infer: inferService() } });

		await expect(
			broker.request("0".repeat(64), identity, inferFrame(), new AbortController().signal),
		).rejects.toMatchObject({
			code: "not_granted",
		});

		const audit = (await readFile(join(paths.log, "capability-audit.jsonl"), "utf8")).trim().split("\n");
		expect(audit).toHaveLength(1);
		expect(JSON.parse(audit[0])).toMatchObject({
			type: "capability-request",
			decision: "denied",
			request: { payload: { prompt: "full prompt" } },
		});
	});

	it("persists explicit grants, actual usage, and full prompt/response audit records", async () => {
		const { paths } = await fixture();
		const broker = new EvoCapabilityBroker({
			paths,
			services: { infer: inferService() },
			now: () => "2026-07-16T00:00:00.000Z",
			randomId: () => "event-1",
		});
		const authorityId = await broker.replaceComponentGrants(identity, [inferGrant]);

		await expect(broker.request(authorityId, identity, inferFrame(), new AbortController().signal)).resolves.toEqual({
			text: "full response",
		});
		const state = await broker.getState();
		expect(state.components[0]).toMatchObject({
			authorityId,
			id: identity.id,
			grants: [{ capability: "infer", maxCalls: 2 }],
			usage: [
				{
					capability: "infer",
					calls: 1,
					inputTokens: 10,
					outputTokens: 5,
					totalTokens: 15,
					costUsd: 0.01,
				},
			],
		});
		expect(state.reservations).toEqual([]);

		const audit = (await readFile(join(paths.log, "capability-audit.jsonl"), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(audit).toHaveLength(3);
		expect(audit[1]).toMatchObject({
			type: "capability-request",
			decision: "allowed",
			component: { authorityId },
			request: { payload: { prompt: "full prompt" } },
		});
		expect(audit[2]).toMatchObject({
			type: "capability-result",
			ok: true,
			result: { text: "full response" },
			usage: { totalTokens: 15, costUsd: 0.01 },
		});
	});

	it("uses persisted reservations to reject concurrent budget oversubscription", async () => {
		const { paths } = await fixture();
		let release: (() => void) | undefined;
		const blocked = new Promise<void>((resolvePromise) => {
			release = resolvePromise;
		});
		const broker = new EvoCapabilityBroker({
			paths,
			services: {
				infer: inferService(async () => {
					await blocked;
					return {
						result: { text: "done" },
						usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20, costUsd: 0.01 },
					};
				}),
			},
		});
		const authorityId = await broker.replaceComponentGrants(identity, [
			{
				...inferGrant,
				maxInputTokens: 150,
				maxOutputTokens: 150,
				maxTotalTokens: 300,
				maxCostUsd: 0.15,
				maxOutputTokensPerCall: 100,
			},
		]);

		const first = broker.request(authorityId, identity, inferFrame("first"), new AbortController().signal);
		while ((await broker.getState()).reservations.length === 0) await Promise.resolve();
		await expect(
			broker.request(authorityId, identity, inferFrame("second"), new AbortController().signal),
		).rejects.toMatchObject({ code: "input_budget" });
		release?.();
		await expect(first).resolves.toEqual({ text: "done" });
	});

	it("isolates budgets across exact artifact-and-grant authorities without last-writer replacement", async () => {
		const { paths } = await fixture();
		const broker = new EvoCapabilityBroker({ paths, services: { infer: inferService() } });
		await expect(
			broker.replaceComponentGrants({ ...identity, declaredCapabilities: [] }, [inferGrant]),
		).rejects.toThrow("undeclared");
		await expect(
			broker.replaceComponentGrants({ ...identity, abiCapabilityCeiling: [] }, [inferGrant]),
		).rejects.toThrow("above ABI ceiling");
		const restrictedAuthority = await broker.replaceComponentGrants(identity, [
			{ ...inferGrant, maxCalls: 1, models: ["faux/other"] },
		]);
		await expect(
			broker.request(restrictedAuthority, identity, inferFrame(), new AbortController().signal),
		).rejects.toMatchObject({
			code: "model_restricted",
		});
		const oneCallAuthority = await broker.replaceComponentGrants(identity, [{ ...inferGrant, maxCalls: 1 }]);
		const twoCallAuthority = await broker.replaceComponentGrants(identity, [{ ...inferGrant, maxCalls: 2 }]);
		expect(oneCallAuthority).not.toBe(twoCallAuthority);
		await broker.request(oneCallAuthority, identity, inferFrame("one"), new AbortController().signal);
		await broker.request(twoCallAuthority, identity, inferFrame("two-a"), new AbortController().signal);
		await expect(
			broker.request(oneCallAuthority, identity, inferFrame("one-exhausted"), new AbortController().signal),
		).rejects.toBeInstanceOf(EvoCapabilityDeniedError);
		await expect(
			broker.request(twoCallAuthority, identity, inferFrame("two-b"), new AbortController().signal),
		).resolves.toEqual({ text: "full response" });
		expect(await broker.replaceComponentGrants(identity, [{ ...inferGrant, maxCalls: 1 }])).toBe(oneCallAuthority);
		const state = await broker.getState();
		expect(state.components).toHaveLength(3);
		expect(state.components.find((entry) => entry.authorityId === oneCallAuthority)?.usage[0]?.calls).toBe(1);
		expect(state.components.find((entry) => entry.authorityId === twoCallAuthority)?.usage[0]?.calls).toBe(2);
	});

	it("requires successful budgeted usage and charges the reservation for unaccounted failures", async () => {
		for (const mode of ["missing", "over", "throw"] as const) {
			const { paths } = await fixture();
			const broker = new EvoCapabilityBroker({
				paths,
				services: {
					infer: inferService(async () => {
						if (mode === "missing") return { result: { text: "missing usage" } };
						if (mode === "over") {
							return {
								result: { text: "over reservation" },
								usage: { inputTokens: 101, outputTokens: 1, totalTokens: 102, costUsd: 0.01 },
							};
						}
						throw new Error("provider failed after dispatch");
					}),
				},
			});
			const authorityId = await broker.replaceComponentGrants(identity, [
				{
					...inferGrant,
					maxCalls: 2,
					maxInputTokens: 100,
					maxOutputTokens: 100,
					maxTotalTokens: 200,
					maxCostUsd: 0.1,
					maxOutputTokensPerCall: 100,
				},
			]);
			await expect(
				broker.request(authorityId, identity, inferFrame(mode), new AbortController().signal),
			).rejects.toMatchObject({ code: "service_error" });
			const entry = (await broker.getState()).components.find((candidate) => candidate.authorityId === authorityId);
			expect(entry?.usage).toEqual([
				{
					capability: "infer",
					calls: 1,
					inputTokens: mode === "over" ? 101 : 100,
					outputTokens: mode === "over" ? 1 : 100,
					totalTokens: mode === "over" ? 102 : 200,
					costUsd: mode === "over" ? 0.01 : 0.1,
				},
			]);
			await expect(
				broker.request(authorityId, identity, inferFrame(`${mode}-again`), new AbortController().signal),
			).rejects.toMatchObject({ code: "input_budget" });
		}
	});

	it("recovers crash-orphaned reservations, charges them conservatively, and audits each request once", async () => {
		for (const faultPoint of ["after-state-write", "after-audit-append"] as const) {
			const { paths } = await fixture();
			const setup = new EvoCapabilityBroker({ paths, services: { infer: inferService() } });
			const authorityId = await setup.replaceComponentGrants(identity, [inferGrant]);
			let injected = false;
			const crashed = new EvoCapabilityBroker({
				paths,
				services: { infer: inferService() },
				sessionId: `crashed-${faultPoint}`,
				ownerPid: 2_147_483_647,
				randomId: () => `crash-${faultPoint}`,
				faultInjector(point) {
					if (!injected && point === faultPoint) {
						injected = true;
						throw new Error(`simulated crash at ${point}`);
					}
				},
			});
			await expect(
				crashed.request(authorityId, identity, inferFrame(`crash-${faultPoint}`), new AbortController().signal),
			).rejects.toThrow("simulated crash");

			const recovered = new EvoCapabilityBroker({
				paths,
				services: { infer: inferService() },
				sessionId: `recovered-${faultPoint}`,
			});
			const state = await recovered.getState();
			expect(state.reservations).toEqual([]);
			expect(state.operations).toEqual([]);
			expect(state.pendingAudit).toEqual([]);
			expect(state.components[0]?.usage).toEqual([
				{
					capability: "infer",
					calls: 1,
					inputTokens: 100,
					outputTokens: 100,
					totalTokens: 200,
					costUsd: 0.1,
				},
			]);
			const audit = (await readFile(join(paths.log, "capability-audit.jsonl"), "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			const eventId = `crash-${faultPoint}`;
			expect(audit.filter((entry) => entry.type === "capability-request" && entry.eventId === eventId)).toHaveLength(
				1,
			);
			expect(audit.filter((entry) => entry.type === "capability-result" && entry.eventId === eventId)).toEqual([
				expect.objectContaining({
					ok: false,
					recovered: true,
					error: { code: "host_recovered", message: "Capability host stopped before finalization" },
					usage: expect.objectContaining({ totalTokens: 200, costUsd: 0.1 }),
				}),
			]);
		}
	});

	it("rejects pre-aborted calls before preparation and bounds audited result payloads", async () => {
		const { paths } = await fixture();
		let preparations = 0;
		let executions = 0;
		const service: EvoCapabilityService = {
			prepare(payload) {
				preparations += 1;
				return { request: payload };
			},
			async execute() {
				executions += 1;
				return { result: { text: "x".repeat(1_000) } };
			},
		};
		const broker = new EvoCapabilityBroker({
			paths,
			services: { "read-file": service },
			maxAuditResultBytes: 64,
		});
		const authorityId = await broker.replaceComponentGrants(identity, [{ capability: "read-file", maxCalls: 2 }]);
		const frame = parseEvoCapabilityRequestFrame({
			type: "capability-request",
			invokeId: 7,
			id: "read-1",
			capability: "read-file",
			payload: { root: "workspace", path: "file.txt", encoding: "utf8" },
		});
		const controller = new AbortController();
		controller.abort(new Error("cancelled before broker"));
		await expect(broker.request(authorityId, identity, frame, controller.signal)).rejects.toMatchObject({
			code: "aborted",
		});
		expect(preparations).toBe(0);
		expect(executions).toBe(0);

		await expect(broker.request(authorityId, identity, frame, new AbortController().signal)).resolves.toEqual({
			text: "x".repeat(1_000),
		});
		const audit = (await readFile(join(paths.log, "capability-audit.jsonl"), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(audit.at(-1)).toMatchObject({
			type: "capability-result",
			ok: true,
			result: { omitted: true, reason: "byte-limit", bytes: 1_011 },
		});
	});
});

describe("infer host service", () => {
	it("calls the raw simple completion host with no agent or tools", async () => {
		const calls: unknown[] = [];
		const model: Model<Api> = {
			id: "test",
			name: "Test",
			api: "faux",
			provider: "faux",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
			contextWindow: 10_000,
			maxTokens: 1_000,
		};
		const host: EvoRawInferHost = {
			resolveModel: (route) => (route === "faux/test" ? model : undefined),
			async completeSimple(receivedModel, context, options) {
				calls.push({ receivedModel, context, options });
				return {
					role: "assistant",
					content: [{ type: "text", text: "raw response" }],
					api: "faux",
					provider: "faux",
					model: "test",
					usage: {
						input: 4,
						output: 2,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 6,
						cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
					},
					stopReason: "stop",
					timestamp: 1,
				};
			},
		};
		const service = createInferCapabilityService(host);
		const context = {
			component: identity,
			capability: "infer" as const,
			signal: new AbortController().signal,
		};
		const preparedRequest = service.prepare(
			{ model: "faux/test", systemPrompt: "system", prompt: "prompt", maxOutputTokens: 100 },
			context,
		);
		await expect(service.execute(preparedRequest.request, context)).resolves.toMatchObject({
			result: { content: [{ type: "text", text: "raw response" }] },
			usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6, costUsd: 0.3 },
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			context: { systemPrompt: "system", messages: [{ role: "user", content: "prompt" }] },
			options: { maxTokens: 100 },
		});
	});

	it("aborts already-cancelled and pending auth refreshes without leaking a late rejection", async () => {
		const model: Model<Api> = {
			id: "test",
			name: "Test",
			api: "faux",
			provider: "faux",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
			contextWindow: 10_000,
			maxTokens: 1_000,
		};
		let markAuthStarted = (): void => {};
		const authStarted = new Promise<void>((resolve) => {
			markAuthStarted = resolve;
		});
		let rejectAuth: ((error: Error) => void) | undefined;
		const pendingAuth = new Promise<never>((_resolve, reject) => {
			rejectAuth = reject;
		});
		let authCalls = 0;
		const registry: Pick<ModelRegistry, "find" | "getApiKeyAndHeaders"> = {
			find(provider, id) {
				return provider === "faux" && id === "test" ? model : undefined;
			},
			getApiKeyAndHeaders() {
				authCalls += 1;
				markAuthStarted();
				return pendingAuth;
			},
		};
		const host = createModelRegistryInferHost(registry);
		const context = { messages: [{ role: "user" as const, content: "prompt", timestamp: 1 }] };

		const alreadyAborted = new AbortController();
		const alreadyAbortedReason = new Error("cancel before auth refresh");
		alreadyAborted.abort(alreadyAbortedReason);
		await expect(host.completeSimple(model, context, { maxTokens: 100, signal: alreadyAborted.signal })).rejects.toBe(
			alreadyAbortedReason,
		);
		expect(authCalls).toBe(0);

		const controller = new AbortController();
		const reason = new Error("cancel during auth refresh");
		const running = host.completeSimple(model, context, { maxTokens: 100, signal: controller.signal });
		await authStarted;
		controller.abort(reason);

		const timeout = Symbol("infer auth abort timeout");
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
		const timeoutResult = new Promise<typeof timeout>((resolve) => {
			timeoutHandle = setTimeout(() => resolve(timeout), 250);
		});
		const outcome = await Promise.race([
			running.then(
				(result) => result,
				(error: unknown) => error,
			),
			timeoutResult,
		]);
		if (timeoutHandle) clearTimeout(timeoutHandle);
		expect(outcome).toBe(reason);
		expect(authCalls).toBe(1);

		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown): void => {
			unhandled.push(error);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			if (!rejectAuth) throw new Error("Auth rejection hook was not initialized");
			rejectAuth(new Error("late infer auth refresh failure"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});
