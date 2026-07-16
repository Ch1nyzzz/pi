import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publishEvoComponentArtifact } from "../src/components/artifact.ts";
import { EvoComponentProcess } from "../src/components/process-runtime.ts";
import type { EvoAbiDefinition } from "../src/components/registry.ts";
import { getEvoPaths } from "../src/paths.ts";

const roots: string[] = [];

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return false;
		throw error;
	}
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(source: string) {
	const root = await mkdtemp(join(tmpdir(), "pi-evo-capability-process-"));
	roots.push(root);
	const paths = getEvoPaths(join(root, "evo"));
	return publishEvoComponentArtifact(paths, {
		id: "broker-protocol-test",
		version: "1",
		abi: "test/v1",
		activationBoundary: "session",
		capabilities: ["infer"],
		entrypointContent: source,
	});
}

const abi: EvoAbiDefinition<Record<string, unknown>, Record<string, unknown>, Record<string, never>> = {
	id: "test/v1",
	surface: "test",
	activationBoundary: "session",
	capabilityCeiling: ["infer"],
	validateConfig(value) {
		if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length > 0) {
			throw new Error("test config must be empty");
		}
		return {};
	},
	validateInput(value) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid test input");
		return value as Record<string, unknown>;
	},
	validateOutput(value) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid test output");
		return value as Record<string, unknown>;
	},
};

const prelude = `
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let invoke;
function reply(id, result) {
  process.stdout.write(JSON.stringify({ id, ok: true, result }) + "\\n");
}
`;

const brokeredSource = `${prelude}
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return reply(message.id, { initialized: true });
  if (message.method === "invoke") {
    invoke = message;
    process.stdout.write(JSON.stringify({
      type: "capability-request",
      invokeId: message.id,
      id: "nested-1",
      capability: "infer",
      payload: { prompt: message.payload.prompt }
    }) + "\\n");
    return;
  }
  if (message.type === "capability-result") {
    return reply(invoke.id, message.ok ? { text: message.result.text } : { errorCode: message.error.code });
  }
  if (message.method === "health") return reply(message.id, { healthy: true });
  if (message.method === "shutdown") {
    reply(message.id, { stopped: true });
    process.exit(0);
  }
});
`;

describe("bidirectional component process protocol", () => {
	it("services a nested capability request during invoke", async () => {
		const artifact = await fixture(brokeredSource);
		const requests: unknown[] = [];
		const process = new EvoComponentProcess(
			artifact,
			abi,
			{},
			{
				sandbox: false,
				requestTimeoutMs: 5_000,
				capabilityBroker: {
					async request(component, frame) {
						requests.push({ component, frame });
						return { text: "broker response" };
					},
				},
			},
		);
		await expect(process.invoke({ prompt: "full prompt" })).resolves.toEqual({ text: "broker response" });
		expect(requests).toMatchObject([
			{
				component: {
					id: "broker-protocol-test",
					artifactDigest: artifact.manifest.artifactDigest,
					declaredCapabilities: ["infer"],
					abiCapabilityCeiling: ["infer"],
				},
				frame: {
					type: "capability-request",
					invokeId: 2,
					id: "nested-1",
					capability: "infer",
					payload: { prompt: "full prompt" },
				},
			},
		]);
		await process.shutdown();
	});

	it("returns a structured denial when no broker is configured", async () => {
		const artifact = await fixture(brokeredSource);
		const process = new EvoComponentProcess(artifact, abi, {}, { sandbox: false, requestTimeoutMs: 5_000 });
		await expect(process.invoke({ prompt: "test" })).resolves.toEqual({ errorCode: "unavailable" });
		await process.shutdown();
	});

	it("terminates a component instead of writing an oversized capability result", async () => {
		const artifact = await fixture(brokeredSource);
		const process = new EvoComponentProcess(
			artifact,
			abi,
			{},
			{
				sandbox: false,
				requestTimeoutMs: 5_000,
				maxCapabilityResultBytes: 256,
				capabilityBroker: {
					async request() {
						return { text: "x".repeat(1_024) };
					},
				},
			},
		);

		await expect(process.invoke({ prompt: "test" })).rejects.toThrow("Capability result exceeds");
		await process.shutdown();
	});

	it("kills a component that emits a malformed capability frame", async () => {
		const artifact = await fixture(`${prelude}
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return reply(message.id, {});
  if (message.method === "invoke") process.stdout.write(JSON.stringify({
    type: "capability-request",
    invokeId: message.id,
    id: "nested-1",
    capability: "infer",
    payload: {},
    extra: true
  }) + "\\n");
});
`);
		const process = new EvoComponentProcess(
			artifact,
			abi,
			{},
			{
				sandbox: false,
				requestTimeoutMs: 5_000,
				capabilityBroker: {
					async request() {
						return {};
					},
				},
			},
		);
		await expect(process.invoke({})).rejects.toThrow("unknown key");
	});

	it("rejects duplicate nested ids and invoke completion with an outstanding call", async () => {
		for (const linesAfterInvoke of [
			`process.stdout.write(frame + "\\n" + frame + "\\n");`,
			`process.stdout.write(frame + "\\n"); reply(message.id, { bypassed: true });`,
		]) {
			const artifact = await fixture(`${prelude}
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return reply(message.id, {});
  if (message.method === "invoke") {
    const frame = JSON.stringify({ type: "capability-request", invokeId: message.id, id: "same", capability: "infer", payload: {} });
    ${linesAfterInvoke}
  }
});
`);
			const process = new EvoComponentProcess(
				artifact,
				abi,
				{},
				{
					sandbox: false,
					requestTimeoutMs: 5_000,
					capabilityBroker: {
						async request() {
							await new Promise(() => {});
						},
					},
				},
			);
			await expect(process.invoke({})).rejects.toThrow(/Duplicate capability|outstanding capability/);
		}
	});

	it("parses fragmented JSONL frames without relying on readline buffering", async () => {
		const artifact = await fixture(`${prelude}
lines.on("line", (line) => {
  const message = JSON.parse(line);
  const response = JSON.stringify({ id: message.id, ok: true, result: { method: message.method } }) + "\\r\\n";
  process.stdout.write(response.slice(0, 7));
  setImmediate(() => process.stdout.write(response.slice(7)));
});
`);
		const process = new EvoComponentProcess(artifact, abi, {}, { sandbox: false, requestTimeoutMs: 5_000 });
		await expect(process.invoke({})).resolves.toEqual({ method: "invoke" });
		await process.shutdown();
	});

	it("kills components that exceed a frame or process stdout byte limit", async () => {
		const oversizedFrame = await fixture(`
import { writeFileSync } from "node:fs";
writeFileSync("component.pid", String(process.pid));
process.on("SIGTERM", () => {});
process.stdin.once("data", () => {
  for (let index = 0; index < 33; index += 1) process.stdout.write("x");
});
`);
		const frameProcess = new EvoComponentProcess(
			oversizedFrame,
			abi,
			{},
			{
				sandbox: false,
				requestTimeoutMs: 5_000,
				maxStdoutFrameBytes: 32,
				maxStdoutBytes: 64,
				terminationGraceMs: 50,
			},
		);
		await expect(frameProcess.invoke({})).rejects.toThrow("stdout frame exceeds");
		const stubbornPid = Number(await readFile(join(oversizedFrame.directory, "component.pid"), "utf8"));
		await frameProcess.shutdown();
		expect(processExists(stubbornPid)).toBe(false);

		const aggregateOutput = await fixture(`${prelude}
lines.on("line", (line) => {
  const message = JSON.parse(line);
  reply(message.id, {});
});
`);
		const aggregateProcess = new EvoComponentProcess(
			aggregateOutput,
			abi,
			{},
			{
				sandbox: false,
				requestTimeoutMs: 5_000,
				maxStdoutFrameBytes: 60,
				maxStdoutBytes: 60,
			},
		);
		await expect(aggregateProcess.invoke({})).rejects.toThrow("process byte limit");
		await aggregateProcess.shutdown();
	});

	it("rejects a final truncated JSONL frame when the component closes", async () => {
		const artifact = await fixture(`
process.stdin.once("data", () => {
  process.stdout.write(JSON.stringify({ id: 1, ok: true, result: {} }));
  process.exit(0);
});
`);
		const process = new EvoComponentProcess(artifact, abi, {}, { sandbox: false, requestTimeoutMs: 5_000 });
		await expect(process.invoke({})).rejects.toThrow("truncated JSONL frame");
	});

	it("reports a native process group that remains after SIGKILL", async () => {
		if (process.platform === "win32") return;
		const artifact = await fixture(`${prelude}
import { writeFileSync } from "node:fs";
writeFileSync("component.pid", String(process.pid));
process.on("SIGTERM", () => {});
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return reply(message.id, {});
});
`);
		const componentProcess = new EvoComponentProcess(
			artifact,
			abi,
			{},
			{ sandbox: false, requestTimeoutMs: 5_000, terminationGraceMs: 25 },
		);
		await componentProcess.start();
		const pid = Number(await readFile(join(artifact.directory, "component.pid"), "utf8"));
		const originalKill = process.kill.bind(process);
		let sentSigkill = false;
		const killSpy = vi.spyOn(process, "kill").mockImplementation((candidatePid, signal) => {
			if (candidatePid === -pid && signal === "SIGKILL") {
				sentSigkill = true;
				return originalKill(candidatePid, signal);
			}
			if (candidatePid === -pid && signal === 0 && sentSigkill) return true;
			return originalKill(candidatePid, signal);
		});
		try {
			await expect(componentProcess.terminate(new Error("cancel component"))).rejects.toThrow(
				"Component process hard teardown failed",
			);
		} finally {
			killSpy.mockRestore();
		}
		expect(sentSigkill).toBe(true);
		expect(processExists(pid)).toBe(false);
	});
});
