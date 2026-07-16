import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { LoadedEvoComponentArtifact } from "./artifact.ts";
import {
	capabilityErrorFrame,
	capabilitySuccessFrame,
	type EvoCapabilityRequestFrame,
	parseEvoCapabilityRequestFrame,
} from "./capabilities/protocol.ts";
import type { EvoCapabilityComponentIdentity } from "./capabilities/service.ts";
import type { EvoAbiDefinition } from "./registry.ts";

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const MAX_STDERR_BYTES = 64 * 1024;
const DOCKER_PROBE_TIMEOUT_MS = 10_000;
const DOCKER_PULL_TIMEOUT_MS = 180_000;
const MAX_CONCURRENT_CAPABILITY_REQUESTS = 32;
const DEFAULT_MAX_STDOUT_FRAME_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_CAPABILITY_RESULT_BYTES = 8 * 1024 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 1_000;
const INITIAL_STDOUT_FRAME_BUFFER_BYTES = 64 * 1024;
const DOCKER_CONTROL_TIMEOUT_MS = 10_000;
const MAX_DOCKER_CONTROL_OUTPUT_BYTES = 64 * 1024;

/** Major version pinned to the supported host runtime; override for air-gapped hosts. */
function dockerImage(): string {
	return process.env.PI_EVO_DOCKER_IMAGE || "node:22-slim";
}

export type EvoComponentSandboxKind = "bwrap" | "docker";

interface ProcessRequest {
	id: number;
	method: "initialize" | "invoke" | "health" | "shutdown";
	payload?: unknown;
}

interface ProcessResponse {
	id: number;
	ok: boolean;
	result?: unknown;
	error?: string;
}

interface PendingRequest {
	resolve(value: unknown): void;
	reject(error: Error): void;
	timer: NodeJS.Timeout;
	method: ProcessRequest["method"];
}

export interface EvoComponentCapabilityBroker {
	request(
		component: EvoCapabilityComponentIdentity,
		frame: EvoCapabilityRequestFrame,
		signal: AbortSignal,
	): Promise<unknown>;
}

export interface EvoComponentProcessOptions {
	requestTimeoutMs?: number;
	/** Maximum bytes in one component JSONL frame. Primarily overridden by focused tests. */
	maxStdoutFrameBytes?: number;
	/** Maximum aggregate stdout bytes emitted over the component process lifetime. */
	maxStdoutBytes?: number;
	/** Maximum bytes in one host-to-component capability-result JSONL frame. */
	maxCapabilityResultBytes?: number;
	/** Grace between TERM and KILL when tearing down an uncooperative component. */
	terminationGraceMs?: number;
	/** Test/development escape hatch. Production callers should keep this true. */
	sandbox?: boolean;
	capabilityBroker?: EvoComponentCapabilityBroker;
}

function parseResponse(parsed: unknown): ProcessResponse {
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Component process response must be an object");
	}
	const response = parsed as Record<string, unknown>;
	for (const key of Object.keys(response)) {
		if (!["id", "ok", "result", "error"].includes(key)) {
			throw new Error(`Component process response has unknown key: ${key}`);
		}
	}
	if (!Number.isSafeInteger(response.id) || (response.id as number) <= 0 || typeof response.ok !== "boolean") {
		throw new Error("Component process response is invalid");
	}
	if (response.ok) {
		if (Object.hasOwn(response, "error")) throw new Error("Successful component response cannot include error");
	} else {
		if (typeof response.error !== "string" || response.error.length === 0) {
			throw new Error("Failed component response must include a non-empty error");
		}
		if (Object.hasOwn(response, "result")) throw new Error("Failed component response cannot include result");
	}
	return response as unknown as ProcessResponse;
}

type ComponentOutput =
	| { kind: "response"; value: ProcessResponse }
	| { kind: "capability"; value: EvoCapabilityRequestFrame };

function parseComponentOutput(line: string): ComponentOutput {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line) as unknown;
	} catch (error) {
		throw new Error("Component process returned invalid JSON", { cause: error });
	}
	if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && Object.hasOwn(parsed, "type")) {
		return { kind: "capability", value: parseEvoCapabilityRequestFrame(parsed) };
	}
	return { kind: "response", value: parseResponse(parsed) };
}

function probeCommand(command: string, args: string[], timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		const child = spawn(command, args, { stdio: "ignore" });
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			resolve(false);
		}, timeoutMs);
		timer.unref?.();
		child.once("error", () => {
			clearTimeout(timer);
			resolve(false);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			resolve(code === 0);
		});
	});
}

interface DockerControlResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

function runDockerControlCommand(args: string[]): Promise<DockerControlResult> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn("docker", args, {
			env: { ...process.env, LANG: "C" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let outputBytes = 0;
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill("SIGKILL");
			reject(new Error(`Docker control command timed out: docker ${args.join(" ")}`));
		}, DOCKER_CONTROL_TIMEOUT_MS);
		timer.unref();
		const capture =
			(target: Buffer[]) =>
			(chunk: Buffer | string): void => {
				if (settled) return;
				const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				outputBytes += buffer.byteLength;
				if (outputBytes > MAX_DOCKER_CONTROL_OUTPUT_BYTES) {
					settled = true;
					clearTimeout(timer);
					child.kill("SIGKILL");
					reject(new Error("Docker control command output exceeded the byte limit"));
					return;
				}
				target.push(buffer);
			};
		child.stdout.on("data", capture(stdout));
		child.stderr.on("data", capture(stderr));
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new Error(`Docker control command failed to start: ${error.message}`, { cause: error }));
		});
		child.once("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolvePromise({
				code,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
			});
		});
	});
}

async function probeBwrapSandbox(): Promise<boolean> {
	if (process.platform !== "linux") return false;
	return probeCommand(
		"bwrap",
		[
			"--die-with-parent",
			"--new-session",
			"--unshare-net",
			"--unshare-pid",
			"--unshare-ipc",
			"--unshare-uts",
			"--proc",
			"/proc",
			"--dev",
			"/dev",
			"--ro-bind",
			"/usr",
			"/usr",
			"--ro-bind",
			"/bin",
			"/bin",
			"--",
			"/bin/true",
		],
		DOCKER_PROBE_TIMEOUT_MS,
	);
}

async function probeDockerSandbox(): Promise<boolean> {
	const image = dockerImage();
	if (await probeCommand("docker", ["image", "inspect", image], DOCKER_PROBE_TIMEOUT_MS)) return true;
	// A missing image is fetched once; a dead daemon or offline host fails here too.
	return probeCommand("docker", ["pull", "--quiet", image], DOCKER_PULL_TIMEOUT_MS);
}

let sandboxProbe: Promise<EvoComponentSandboxKind | undefined> | undefined;

/**
 * Resolve the strongest available component sandbox: bwrap when unprivileged user
 * namespaces work, otherwise an equally isolated Docker container (hosts that
 * restrict userns via AppArmor typically still run Docker). The probe result is
 * cached per process.
 */
export function resolveEvoComponentSandbox(): Promise<EvoComponentSandboxKind | undefined> {
	sandboxProbe ??= (async () => {
		if (await probeBwrapSandbox()) return "bwrap";
		if (await probeDockerSandbox()) return "docker";
		return undefined;
	})();
	return sandboxProbe;
}

export async function canUseEvoComponentSandbox(): Promise<boolean> {
	return (await resolveEvoComponentSandbox()) !== undefined;
}

interface ComponentLaunch {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	dockerContainerName?: string;
}

function bwrapCommand(artifact: LoadedEvoComponentArtifact): ComponentLaunch {
	if (process.platform !== "linux") {
		throw new Error(`Sandboxed Evo component processes are unsupported on ${process.platform}`);
	}
	const runtime = process.execPath;
	return {
		command: "bwrap",
		args: [
			"--die-with-parent",
			"--new-session",
			"--unshare-net",
			"--unshare-pid",
			"--unshare-ipc",
			"--unshare-uts",
			"--proc",
			"/proc",
			"--dev",
			"/dev",
			"--tmpfs",
			"/tmp",
			"--ro-bind",
			"/usr",
			"/usr",
			"--ro-bind",
			"/bin",
			"/bin",
			"--ro-bind-try",
			"/lib",
			"/lib",
			"--ro-bind-try",
			"/lib64",
			"/lib64",
			"--dir",
			"/component",
			"--ro-bind",
			artifact.directory,
			"/component",
			"--dir",
			"/runtime",
			"--ro-bind",
			runtime,
			"/runtime/node",
			"--dir",
			"/home",
			"--chdir",
			"/component",
			"--",
			"/runtime/node",
			`/component/${artifact.manifest.entrypoint}`,
		],
		env: { HOME: "/home", PATH: "/runtime:/usr/bin:/bin", LANG: "C.UTF-8" },
	};
}

/** Isolation equivalent to the bwrap profile: no network, read-only rootfs, no capabilities. */
export function dockerSandboxCommand(artifact: LoadedEvoComponentArtifact): ComponentLaunch {
	const containerName = `pi-evo-${process.pid}-${randomUUID().replaceAll("-", "")}`;
	const user =
		typeof process.getuid === "function" && typeof process.getgid === "function"
			? [`--user=${process.getuid()}:${process.getgid()}`]
			: [];
	return {
		command: "docker",
		args: [
			"run",
			"--rm",
			"--name",
			containerName,
			"--interactive",
			"--init",
			"--network=none",
			"--read-only",
			"--cap-drop=ALL",
			"--security-opt=no-new-privileges",
			"--pids-limit=256",
			...user,
			"--tmpfs",
			"/tmp",
			"--volume",
			`${artifact.directory}:/component:ro`,
			"--workdir",
			"/component",
			"--env",
			"HOME=/tmp",
			"--env",
			"LANG=C.UTF-8",
			dockerImage(),
			"node",
			`/component/${artifact.manifest.entrypoint}`,
		],
		// The docker CLI itself needs the caller's environment (DOCKER_HOST and
		// friends); the container only sees the --env flags above.
		env: process.env,
		dockerContainerName: containerName,
	};
}

function directCommand(artifact: LoadedEvoComponentArtifact): ComponentLaunch {
	return {
		command: process.execPath,
		args: [artifact.entrypoint],
		env: { HOME: artifact.directory, PATH: process.env.PATH, LANG: "C.UTF-8" },
	};
}

export class EvoComponentProcess<TInput = unknown, TOutput = unknown, TConfig = unknown> {
	private child?: ChildProcessWithoutNullStreams;
	private nextId = 1;
	private readonly pending = new Map<number, PendingRequest>();
	private readonly inFlightCapabilities = new Set<string>();
	private readonly seenCapabilityIds = new Map<number, Set<string>>();
	private readonly capabilityAbort = new AbortController();
	private stderr = "";
	private stdoutFrameBuffer?: Buffer;
	private stdoutFrameBytes = 0;
	private stdoutBytes = 0;
	private stdoutFailed = false;
	private childClose?: Promise<void>;
	private resolveChildClose: () => void = () => {};
	private terminationPromise?: Promise<void>;
	private terminationError?: Error;
	private dockerContainerName?: string;
	private stopped = false;
	private launchedSandbox?: EvoComponentSandboxKind | "direct";
	private readonly artifact: LoadedEvoComponentArtifact;
	private readonly abi: EvoAbiDefinition<TInput, TOutput, TConfig>;
	private readonly config: TConfig;
	private readonly options: EvoComponentProcessOptions;
	private readonly maxStdoutFrameBytes: number;
	private readonly maxStdoutBytes: number;
	private readonly maxCapabilityResultBytes: number;
	private readonly terminationGraceMs: number;

	constructor(
		artifact: LoadedEvoComponentArtifact,
		abi: EvoAbiDefinition<TInput, TOutput, TConfig>,
		config: TConfig,
		options: EvoComponentProcessOptions = {},
	) {
		this.artifact = artifact;
		this.abi = abi;
		this.config = config;
		this.options = options;
		this.maxStdoutFrameBytes = this.positiveByteLimit(
			options.maxStdoutFrameBytes ?? DEFAULT_MAX_STDOUT_FRAME_BYTES,
			"maxStdoutFrameBytes",
		);
		this.maxStdoutBytes = this.positiveByteLimit(
			options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES,
			"maxStdoutBytes",
		);
		this.maxCapabilityResultBytes = this.positiveByteLimit(
			options.maxCapabilityResultBytes ?? DEFAULT_MAX_CAPABILITY_RESULT_BYTES,
			"maxCapabilityResultBytes",
		);
		this.terminationGraceMs = this.positiveByteLimit(
			options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS,
			"terminationGraceMs",
		);
		if (this.maxStdoutFrameBytes > this.maxStdoutBytes) {
			throw new Error("maxStdoutFrameBytes must not exceed maxStdoutBytes");
		}
	}

	/** The execution boundary this process actually launched under. */
	get sandboxKind(): EvoComponentSandboxKind | "direct" | undefined {
		return this.launchedSandbox;
	}

	async start(): Promise<void> {
		if (this.stopped) throw new Error("Component process cannot be restarted after shutdown");
		if (this.child) return;
		let launch: ComponentLaunch;
		if (this.options.sandbox === false) {
			this.launchedSandbox = "direct";
			launch = directCommand(this.artifact);
		} else {
			const kind = await resolveEvoComponentSandbox();
			if (!kind) {
				throw new Error(
					"No component sandbox is available: bwrap cannot create unprivileged namespaces on this host " +
						"and Docker is not usable. Fix either, or retry with explicit one-time direct permission.",
				);
			}
			this.launchedSandbox = kind;
			launch = kind === "bwrap" ? bwrapCommand(this.artifact) : dockerSandboxCommand(this.artifact);
		}
		const child = spawn(launch.command, launch.args, {
			cwd: this.artifact.directory,
			env: launch.env,
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		this.child = child;
		this.dockerContainerName = launch.dockerContainerName;
		this.childClose = new Promise<void>((resolveClose) => {
			this.resolveChildClose = resolveClose;
		});
		child.stdout.on("data", (chunk: Buffer | string) => this.handleStdoutData(chunk));
		child.stderr.on("data", (chunk: Buffer | string) => {
			if (Buffer.byteLength(this.stderr, "utf8") >= MAX_STDERR_BYTES) return;
			this.stderr += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
			if (Buffer.byteLength(this.stderr, "utf8") > MAX_STDERR_BYTES) {
				this.stderr = Buffer.from(this.stderr).subarray(0, MAX_STDERR_BYTES).toString("utf8");
			}
		});
		child.once("error", (error) =>
			this.failProcess(new Error(`Component process failed to start: ${error.message}`)),
		);
		child.once("close", (code, signal) => {
			this.resolveChildClose();
			void this.beginHardTermination();
			this.child = undefined;
			this.capabilityAbort.abort(new Error("Component process closed"));
			const detail = this.stderr.trim();
			const truncated = !this.stdoutFailed && this.stdoutFrameBytes > 0;
			this.stdoutFrameBuffer = undefined;
			this.stdoutFrameBytes = 0;
			this.failAll(
				truncated
					? new Error("Component process closed with a truncated JSONL frame")
					: new Error(`Component process exited (${signal ?? code ?? "unknown"})${detail ? `: ${detail}` : ""}`),
			);
		});
		await this.request("initialize", {
			abi: this.abi.id,
			component: {
				id: this.artifact.manifest.id,
				version: this.artifact.manifest.version,
				artifactDigest: this.artifact.manifest.artifactDigest,
			},
			config: this.config,
		});
	}

	async invoke(input: unknown): Promise<TOutput> {
		await this.start();
		const validated = this.abi.validateInput(input);
		return this.abi.validateOutput(await this.request("invoke", validated));
	}

	async health(): Promise<unknown> {
		await this.start();
		return this.request("health");
	}

	async shutdown(): Promise<void> {
		if (!this.child) {
			this.stopped = true;
			await this.terminationPromise;
			if (this.terminationError) throw this.terminationError;
			return;
		}
		if (!this.stdoutFailed) {
			try {
				await this.request("shutdown");
			} catch {
				// The process may close immediately after acknowledging shutdown.
			}
		}
		this.stopped = true;
		await this.beginHardTermination();
		if (this.terminationError) throw this.terminationError;
	}

	/** Abort active work and immediately begin TERM-to-KILL process teardown. */
	async terminate(reason?: unknown): Promise<void> {
		const error =
			reason instanceof Error
				? reason
				: new Error(reason === undefined ? "Component process terminated" : String(reason));
		this.stopped = true;
		this.capabilityAbort.abort(error);
		this.failProcess(error);
		await this.beginHardTermination();
		if (this.terminationError) throw this.terminationError;
	}

	private request(method: ProcessRequest["method"], payload?: unknown): Promise<unknown> {
		if (this.stopped) {
			const reason = this.capabilityAbort.signal.reason;
			throw reason instanceof Error ? reason : new Error("Component process is not running");
		}
		const child = this.child;
		if (!child || child.stdin.destroyed) throw new Error("Component process is not running");
		const id = this.nextId++;
		const timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				const error = new Error(`Component ${method} request timed out`);
				reject(error);
				this.failProcess(error);
			}, timeoutMs);
			timer.unref?.();
			this.pending.set(id, { resolve, reject, timer, method });
			child.stdin.write(
				`${JSON.stringify({ id, method, ...(payload === undefined ? {} : { payload }) })}\n`,
				(error) => {
					if (!error) return;
					const pending = this.pending.get(id);
					if (!pending) return;
					this.pending.delete(id);
					clearTimeout(pending.timer);
					pending.reject(error);
					this.failProcess(error);
				},
			);
		});
	}

	private handleLine(line: string): void {
		let output: ComponentOutput;
		try {
			output = parseComponentOutput(line);
		} catch (error) {
			this.failProcess(error instanceof Error ? error : new Error(String(error)));
			return;
		}
		if (output.kind === "capability") {
			this.handleCapabilityRequest(output.value);
			return;
		}
		const response = output.value;
		const pending = this.pending.get(response.id);
		if (!pending) {
			this.failProcess(new Error(`Component process returned an unknown response id: ${response.id}`));
			return;
		}
		if (
			pending.method === "invoke" &&
			[...this.inFlightCapabilities].some((key) => key.startsWith(`${response.id}:`))
		) {
			this.failProcess(new Error(`Component invoke ${response.id} completed with outstanding capability requests`));
			return;
		}
		this.pending.delete(response.id);
		this.seenCapabilityIds.delete(response.id);
		clearTimeout(pending.timer);
		if (response.ok) pending.resolve(response.result);
		else pending.reject(new Error(response.error || "Component process request failed"));
	}

	private positiveByteLimit(value: number, label: string): number {
		if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
		return value;
	}

	private appendStdoutFrameChunk(chunk: Buffer): boolean {
		if (chunk.byteLength === 0) return true;
		const requiredBytes = this.stdoutFrameBytes + chunk.byteLength;
		if (requiredBytes > this.maxStdoutFrameBytes) {
			this.failProcess(new Error("Component process stdout frame exceeds the configured byte limit"));
			return false;
		}
		if (!this.stdoutFrameBuffer || this.stdoutFrameBuffer.byteLength < requiredBytes) {
			let capacity =
				this.stdoutFrameBuffer?.byteLength ?? Math.min(INITIAL_STDOUT_FRAME_BUFFER_BYTES, this.maxStdoutFrameBytes);
			while (capacity < requiredBytes) capacity = Math.min(this.maxStdoutFrameBytes, capacity * 2);
			const expanded = Buffer.allocUnsafe(capacity);
			this.stdoutFrameBuffer?.copy(expanded, 0, 0, this.stdoutFrameBytes);
			this.stdoutFrameBuffer = expanded;
		}
		chunk.copy(this.stdoutFrameBuffer, this.stdoutFrameBytes);
		this.stdoutFrameBytes = requiredBytes;
		return true;
	}

	private handleStdoutData(value: Buffer | string): void {
		if (this.stdoutFailed) return;
		const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
		this.stdoutBytes += chunk.byteLength;
		if (this.stdoutBytes > this.maxStdoutBytes) {
			this.failProcess(new Error("Component process stdout exceeds the configured process byte limit"));
			return;
		}
		let start = 0;
		for (let index = 0; index < chunk.byteLength; index += 1) {
			if (chunk[index] !== 0x0a) continue;
			if (!this.appendStdoutFrameChunk(chunk.subarray(start, index))) return;
			let frame = this.stdoutFrameBuffer?.subarray(0, this.stdoutFrameBytes) ?? Buffer.alloc(0);
			this.stdoutFrameBytes = 0;
			if (frame.at(-1) === 0x0d) frame = frame.subarray(0, -1);
			this.handleLine(frame.toString("utf8"));
			if (this.stdoutFailed) return;
			start = index + 1;
		}
		this.appendStdoutFrameChunk(chunk.subarray(start));
	}

	private handleCapabilityRequest(frame: EvoCapabilityRequestFrame): void {
		const pending = this.pending.get(frame.invokeId);
		if (!pending || pending.method !== "invoke") {
			this.failProcess(new Error(`Capability request references a non-active invoke: ${frame.invokeId}`));
			return;
		}
		let seen = this.seenCapabilityIds.get(frame.invokeId);
		if (!seen) {
			seen = new Set();
			this.seenCapabilityIds.set(frame.invokeId, seen);
		}
		if (seen.has(frame.id)) {
			this.failProcess(new Error(`Duplicate capability request id for invoke ${frame.invokeId}: ${frame.id}`));
			return;
		}
		if (this.inFlightCapabilities.size >= MAX_CONCURRENT_CAPABILITY_REQUESTS) {
			this.failProcess(new Error("Component exceeded the concurrent capability request limit"));
			return;
		}
		seen.add(frame.id);
		const key = `${frame.invokeId}:${frame.id}`;
		this.inFlightCapabilities.add(key);
		const identity: EvoCapabilityComponentIdentity = {
			id: this.artifact.manifest.id,
			abi: this.artifact.manifest.abi,
			artifactDigest: this.artifact.manifest.artifactDigest,
			declaredCapabilities: this.artifact.manifest.capabilities,
			abiCapabilityCeiling: this.abi.capabilityCeiling,
		};
		const result = this.options.capabilityBroker
			? this.options.capabilityBroker.request(identity, frame, this.capabilityAbort.signal)
			: Promise.reject(Object.assign(new Error("Capability broker is unavailable"), { code: "unavailable" }));
		void result.then(
			(value) => this.finishCapabilityRequest(key, frame, capabilitySuccessFrame(frame, value)),
			(error: unknown) => {
				const code =
					typeof error === "object" &&
					error !== null &&
					"code" in error &&
					typeof error.code === "string" &&
					/^[a-z][a-z0-9_-]{0,63}$/.test(error.code)
						? error.code
						: "service_error";
				const message =
					(error instanceof Error ? error.message : String(error)).slice(0, 1_024) || "Capability failed";
				this.finishCapabilityRequest(key, frame, capabilityErrorFrame(frame, code, message));
			},
		);
	}

	private finishCapabilityRequest(key: string, frame: EvoCapabilityRequestFrame, result: unknown): void {
		if (!this.inFlightCapabilities.delete(key)) return;
		if (!this.pending.has(frame.invokeId)) {
			this.failProcess(new Error(`Capability result arrived after invoke ${frame.invokeId} completed`));
			return;
		}
		const child = this.child;
		if (!child || child.stdin.destroyed) {
			this.failProcess(new Error("Component process closed before a capability result could be delivered"));
			return;
		}
		let serialized: string | undefined;
		try {
			serialized = JSON.stringify(result);
		} catch (error) {
			this.failProcess(new Error("Capability result is not JSON serializable", { cause: error }));
			return;
		}
		if (serialized === undefined) {
			this.failProcess(new Error("Capability result is not JSON serializable"));
			return;
		}
		const line = `${serialized}\n`;
		if (Buffer.byteLength(line, "utf8") > this.maxCapabilityResultBytes) {
			this.failProcess(new Error("Capability result exceeds the configured byte limit"));
			return;
		}
		child.stdin.write(line, (error) => {
			if (error) this.failProcess(error);
		});
	}

	private failProcess(error: Error): void {
		if (this.stdoutFailed) return;
		this.stdoutFailed = true;
		this.capabilityAbort.abort(error);
		void this.beginHardTermination();
		this.failAll(error);
	}

	private signalChild(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
		try {
			if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, signal);
			else child.kill(signal);
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return;
			throw error;
		}
	}

	private waitForChildClose(closed: Promise<void>): Promise<boolean> {
		return new Promise((resolvePromise) => {
			const timer = setTimeout(() => resolvePromise(false), this.terminationGraceMs);
			timer.unref();
			void closed.then(() => {
				clearTimeout(timer);
				resolvePromise(true);
			});
		});
	}

	private processGroupExists(pid: number): boolean {
		try {
			process.kill(-pid, 0);
			return true;
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return false;
			throw error;
		}
	}

	private async waitForProcessGroupExit(pid: number): Promise<boolean> {
		const deadline = Date.now() + this.terminationGraceMs;
		while (this.processGroupExists(pid)) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) return false;
			await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, Math.min(remaining, 10)));
		}
		return true;
	}

	private async dockerContainerState(name: string): Promise<"running" | "stopped" | "absent"> {
		const result = await runDockerControlCommand(["container", "inspect", "--format", "{{.State.Running}}", name]);
		if (result.code === 0) {
			const state = result.stdout.trim();
			if (state === "true") return "running";
			if (state === "false") return "stopped";
			throw new Error(`Docker returned an invalid container state for ${name}`);
		}
		if (/No such (object|container)/i.test(result.stderr)) return "absent";
		throw new Error(`Docker could not inspect container ${name}: ${result.stderr.trim() || `exit ${result.code}`}`);
	}

	private async signalDockerContainer(name: string, signal: "TERM" | "KILL"): Promise<void> {
		if ((await this.dockerContainerState(name)) !== "running") return;
		const result = await runDockerControlCommand(["kill", "--signal", signal, name]);
		if (result.code === 0) return;
		if ((await this.dockerContainerState(name)) !== "running") return;
		throw new Error(
			`Docker could not send ${signal} to container ${name}: ${result.stderr.trim() || `exit ${result.code}`}`,
		);
	}

	private async waitForDockerContainerExit(name: string): Promise<boolean> {
		const deadline = Date.now() + this.terminationGraceMs;
		while ((await this.dockerContainerState(name)) === "running") {
			const remaining = deadline - Date.now();
			if (remaining <= 0) return false;
			await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, Math.min(remaining, 50)));
		}
		return true;
	}

	private async removeDockerContainer(name: string): Promise<void> {
		if ((await this.dockerContainerState(name)) === "absent") return;
		const result = await runDockerControlCommand(["rm", "--force", name]);
		if (result.code !== 0 && (await this.dockerContainerState(name)) !== "absent") {
			throw new Error(`Docker could not remove container ${name}: ${result.stderr.trim() || `exit ${result.code}`}`);
		}
		if ((await this.dockerContainerState(name)) !== "absent") {
			throw new Error(`Docker container ${name} still exists after forced removal`);
		}
	}

	private async terminateDockerContainer(
		name: string,
		child: ChildProcessWithoutNullStreams,
		closed: Promise<void>,
	): Promise<void> {
		await this.signalDockerContainer(name, "TERM");
		if (!(await this.waitForDockerContainerExit(name))) {
			await this.signalDockerContainer(name, "KILL");
			if (!(await this.waitForDockerContainerExit(name))) await this.removeDockerContainer(name);
		}
		await this.removeDockerContainer(name);
		if (!(await this.waitForChildClose(closed))) {
			this.signalChild(child, "SIGKILL");
			if (!(await this.waitForChildClose(closed))) {
				throw new Error("Docker CLI did not close after its container was removed");
			}
		}
		// The CLI may be killed while its create request is still reaching the
		// daemon. Recheck by the unique name only after the CLI has closed.
		await this.removeDockerContainer(name);
	}

	private beginHardTermination(): Promise<void> {
		if (this.terminationPromise) return this.terminationPromise;
		const child = this.child;
		const closed = this.childClose;
		if (!child || !closed) return Promise.resolve();
		this.terminationPromise = (async () => {
			try {
				if (this.launchedSandbox === "docker" && this.dockerContainerName) {
					await this.terminateDockerContainer(this.dockerContainerName, child, closed);
					return;
				}
				this.signalChild(child, "SIGTERM");
				const terminated =
					process.platform !== "win32" && child.pid !== undefined
						? await this.waitForProcessGroupExit(child.pid)
						: await this.waitForChildClose(closed);
				if (terminated) {
					if (!(await this.waitForChildClose(closed))) {
						throw new Error("Component process group exited without closing its leader");
					}
					return;
				}
				this.signalChild(child, "SIGKILL");
				if (process.platform !== "win32" && child.pid !== undefined) {
					if (!(await this.waitForProcessGroupExit(child.pid))) {
						throw new Error("Component process group still exists after SIGKILL");
					}
					if (!(await this.waitForChildClose(closed))) {
						throw new Error("Component process group exited without closing its leader after SIGKILL");
					}
				} else if (!(await this.waitForChildClose(closed))) {
					throw new Error("Component process did not close after SIGKILL");
				}
			} catch (error) {
				try {
					this.signalChild(child, "SIGKILL");
					if (process.platform !== "win32" && child.pid !== undefined) {
						await this.waitForProcessGroupExit(child.pid);
					}
					await this.waitForChildClose(closed);
				} catch {
					// Preserve the daemon/group teardown error below.
				}
				this.terminationError = new Error("Component process hard teardown failed", { cause: error });
			}
		})();
		return this.terminationPromise;
	}

	private failAll(error: Error): void {
		this.capabilityAbort.abort(error);
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
		this.inFlightCapabilities.clear();
		this.seenCapabilityIds.clear();
	}
}
