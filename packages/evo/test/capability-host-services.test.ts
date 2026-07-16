import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createExecCapabilityService,
	createFileCapabilityServices,
	createHttpFetchCapabilityService,
} from "../src/components/capabilities/host-services.ts";
import type { EvoCapabilityComponentIdentity } from "../src/components/capabilities/service.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-evo-host-capability-"));
	roots.push(root);
	const allowed = join(root, "allowed");
	const outside = join(root, "outside");
	await Promise.all([mkdir(allowed), mkdir(outside)]);
	await writeFile(join(allowed, "input.txt"), "allowed content");
	await writeFile(join(outside, "secret.txt"), "secret content");
	return { root, allowed, outside };
}

const component: EvoCapabilityComponentIdentity = {
	id: "host-service-test",
	abi: "tool/v1",
	artifactDigest: "b".repeat(64),
	declaredCapabilities: ["read-file", "write-file", "list-dir", "exec", "http-fetch"],
	abiCapabilityCeiling: ["read-file", "write-file", "list-dir", "exec", "http-fetch"],
};

function context(capability: "read-file" | "write-file" | "list-dir" | "exec" | "http-fetch") {
	return { component, capability, signal: new AbortController().signal };
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return false;
		throw error;
	}
}

async function waitForProcessExit(pid: number): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (!processExists(pid)) return;
		await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
	}
	throw new Error(`process ${pid} survived exec capability teardown`);
}

describe("file capability host services", () => {
	it("uses named roots and refuses symlink traversal", async () => {
		const { allowed, outside } = await fixture();
		await symlink(outside, join(allowed, "escape"));
		const services = createFileCapabilityServices({
			readRoots: { workspace: allowed },
			writeRoots: { workspace: allowed },
			maxReadBytes: 1_000,
			maxWriteBytes: 1_000,
			maxListEntries: 10,
		});
		const read = services["read-file"]!;
		const readContext = context("read-file");
		const readRequest = read.prepare({ root: "workspace", path: "input.txt", encoding: "utf8" }, readContext);
		await expect(read.execute(readRequest.request, readContext)).resolves.toEqual({
			result: { content: "allowed content", bytes: 15, encoding: "utf8" },
		});
		const escapeRequest = read.prepare(
			{ root: "workspace", path: "escape/secret.txt", encoding: "utf8" },
			readContext,
		);
		await expect(read.execute(escapeRequest.request, readContext)).rejects.toThrow("symbolic link");

		const write = services["write-file"]!;
		const writeContext = context("write-file");
		const writeRequest = write.prepare(
			{ root: "workspace", path: "output.txt", content: "written", encoding: "utf8" },
			writeContext,
		);
		await expect(write.execute(writeRequest.request, writeContext)).resolves.toEqual({ result: { bytes: 7 } });
		await expect(readFile(join(allowed, "output.txt"), "utf8")).resolves.toBe("written");
		const escapeWrite = write.prepare(
			{ root: "workspace", path: "escape/output.txt", content: "outside", encoding: "utf8" },
			writeContext,
		);
		await expect(write.execute(escapeWrite.request, writeContext)).rejects.toThrow("symbolic link");
		await expect(readFile(join(outside, "output.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		expect(() =>
			write.prepare({ root: "workspace", path: "binary.txt", content: "AA==", encoding: "base64" }, writeContext),
		).toThrow("encoding must be 'utf8'");

		const list = services["list-dir"]!;
		const listContext = context("list-dir");
		const listRequest = list.prepare({ root: "workspace", path: "" }, listContext);
		await expect(list.execute(listRequest.request, listContext)).resolves.toMatchObject({
			result: { entries: expect.arrayContaining([{ name: "escape", type: "symlink" }]) },
		});
	});
});

describe("exec capability host service", () => {
	it("runs only an absolute allowlisted command without a shell", async () => {
		const { allowed } = await fixture();
		const service = createExecCapabilityService({
			commands: { echo: "/bin/echo" },
			cwdRoots: { workspace: allowed },
			maxOutputBytes: 1_000,
			maxTimeoutMs: 5_000,
		});
		const execContext = context("exec");
		const request = service.prepare(
			{ command: "echo", args: ["literal;not-a-shell"], cwd: { root: "workspace", path: "" }, timeoutMs: 1_000 },
			execContext,
		);
		await expect(service.execute(request.request, execContext)).resolves.toMatchObject({
			result: { exitCode: 0, stdout: "literal;not-a-shell\n", stderr: "" },
		});
		expect(() =>
			service.prepare({ command: "sh", args: ["-c", "id"], cwd: { root: "workspace", path: "" } }, execContext),
		).not.toThrow();
		await expect(
			service.execute(
				{ command: "sh", args: ["-c", "id"], cwd: { root: "workspace", path: "" }, timeoutMs: 1_000 },
				execContext,
			),
		).rejects.toThrow("not granted");
	});

	it("terminates the entire POSIX process group and awaits close on timeout", async () => {
		if (process.platform === "win32") return;
		const { allowed } = await fixture();
		const script = join(allowed, "stubborn-tree.mjs");
		const childSource = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
		await writeFile(
			script,
			`import { spawn } from "node:child_process";\n` +
				`import { writeFileSync } from "node:fs";\n` +
				`const child = spawn(process.execPath, ["-e", ${JSON.stringify(childSource)}], { stdio: "ignore" });\n` +
				`writeFileSync("pids.json", JSON.stringify({ parent: process.pid, child: child.pid }));\n` +
				`process.on("SIGTERM", () => {});\n` +
				`setInterval(() => {}, 1000);\n`,
		);
		const service = createExecCapabilityService({
			commands: { node: process.execPath },
			cwdRoots: { workspace: allowed },
			maxOutputBytes: 1_000,
			maxTimeoutMs: 1_000,
			terminationGraceMs: 50,
		});
		const execContext = context("exec");
		const request = service.prepare(
			{ command: "node", args: [script], cwd: { root: "workspace", path: "" }, timeoutMs: 100 },
			execContext,
		);
		await expect(service.execute(request.request, execContext)).rejects.toThrow("timed out");
		const parsed = JSON.parse(await readFile(join(allowed, "pids.json"), "utf8")) as unknown;
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			!("parent" in parsed) ||
			!("child" in parsed) ||
			typeof parsed.parent !== "number" ||
			typeof parsed.child !== "number"
		) {
			throw new Error("stubborn process fixture did not record numeric pids");
		}
		await Promise.all([waitForProcessExit(parsed.parent), waitForProcessExit(parsed.child)]);
	});
});

describe("http-fetch capability host service", () => {
	it("allows only configured HTTPS origins and non-credential headers", () => {
		const service = createHttpFetchCapabilityService({ origins: ["https://example.com"] });
		const fetchContext = context("http-fetch");
		expect(() =>
			service.prepare({ url: "https://example.com/data", headers: { accept: "application/json" } }, fetchContext),
		).not.toThrow();
		expect(() => service.prepare({ url: "http://example.com/data" }, fetchContext)).toThrow("granted HTTPS");
		expect(() => service.prepare({ url: "https://other.example/data" }, fetchContext)).toThrow("granted HTTPS");
		expect(() =>
			service.prepare({ url: "https://example.com/data", headers: { authorization: "secret" } }, fetchContext),
		).toThrow("not allowed");
	});

	it("does not dispatch an already-aborted request", async () => {
		const service = createHttpFetchCapabilityService({ origins: ["https://example.com"] });
		const controller = new AbortController();
		controller.abort(new Error("cancel before fetch"));
		const fetchContext = { ...context("http-fetch"), signal: controller.signal };
		const request = service.prepare({ url: "https://example.com/data" }, fetchContext);
		await expect(service.execute(request.request, fetchContext)).rejects.toThrow("aborted");
	});
});
