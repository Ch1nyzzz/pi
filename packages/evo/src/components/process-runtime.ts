import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { LoadedEvoComponentArtifact } from "./artifact.ts";
import type { EvoAbiDefinition } from "./registry.ts";

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const MAX_STDERR_BYTES = 64 * 1024;

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
}

export interface EvoComponentProcessOptions {
	requestTimeoutMs?: number;
	/** Test/development escape hatch. Production callers should keep this true. */
	sandbox?: boolean;
}

function parseResponse(value: string): ProcessResponse {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch (error) {
		throw new Error("Component process returned invalid JSON", { cause: error });
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Component process response must be an object");
	}
	const response = parsed as Record<string, unknown>;
	if (
		!Number.isSafeInteger(response.id) ||
		typeof response.ok !== "boolean" ||
		(response.error !== undefined && typeof response.error !== "string")
	) {
		throw new Error("Component process response is invalid");
	}
	return response as unknown as ProcessResponse;
}

export async function canUseEvoComponentSandbox(): Promise<boolean> {
	if (process.platform !== "linux") return false;
	return new Promise((resolve) => {
		const child = spawn(
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
			{ stdio: "ignore" },
		);
		child.once("error", () => resolve(false));
		child.once("close", (code) => resolve(code === 0));
	});
}

function sandboxCommand(artifact: LoadedEvoComponentArtifact): {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
} {
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

function directCommand(artifact: LoadedEvoComponentArtifact): {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
} {
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
	private stderr = "";
	private stopped = false;
	private readonly artifact: LoadedEvoComponentArtifact;
	private readonly abi: EvoAbiDefinition<TInput, TOutput, TConfig>;
	private readonly config: TConfig;
	private readonly options: EvoComponentProcessOptions;

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
	}

	async start(): Promise<void> {
		if (this.child) return;
		if (this.stopped) throw new Error("Component process cannot be restarted after shutdown");
		const launch = this.options.sandbox === false ? directCommand(this.artifact) : sandboxCommand(this.artifact);
		const child = spawn(launch.command, launch.args, {
			cwd: this.artifact.directory,
			env: launch.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child = child;
		const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
		lines.on("line", (line) => this.handleLine(line));
		child.stderr.on("data", (chunk: Buffer | string) => {
			if (Buffer.byteLength(this.stderr, "utf8") >= MAX_STDERR_BYTES) return;
			this.stderr += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
			if (Buffer.byteLength(this.stderr, "utf8") > MAX_STDERR_BYTES) {
				this.stderr = Buffer.from(this.stderr).subarray(0, MAX_STDERR_BYTES).toString("utf8");
			}
		});
		child.once("error", (error) => this.failAll(new Error(`Component process failed to start: ${error.message}`)));
		child.once("close", (code, signal) => {
			this.child = undefined;
			const detail = this.stderr.trim();
			this.failAll(
				new Error(`Component process exited (${signal ?? code ?? "unknown"})${detail ? `: ${detail}` : ""}`),
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
			return;
		}
		try {
			await this.request("shutdown");
		} catch {
			// The process may close immediately after acknowledging shutdown.
		} finally {
			this.stopped = true;
			this.child?.kill("SIGTERM");
			this.child = undefined;
		}
	}

	private request(method: ProcessRequest["method"], payload?: unknown): Promise<unknown> {
		const child = this.child;
		if (!child || child.stdin.destroyed) throw new Error("Component process is not running");
		const id = this.nextId++;
		const timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Component ${method} request timed out`));
				child.kill("SIGTERM");
			}, timeoutMs);
			timer.unref?.();
			this.pending.set(id, { resolve, reject, timer });
			child.stdin.write(
				`${JSON.stringify({ id, method, ...(payload === undefined ? {} : { payload }) })}\n`,
				(error) => {
					if (!error) return;
					const pending = this.pending.get(id);
					if (!pending) return;
					this.pending.delete(id);
					clearTimeout(pending.timer);
					pending.reject(error);
				},
			);
		});
	}

	private handleLine(line: string): void {
		let response: ProcessResponse;
		try {
			response = parseResponse(line);
		} catch (error) {
			this.child?.kill("SIGTERM");
			this.failAll(error instanceof Error ? error : new Error(String(error)));
			return;
		}
		const pending = this.pending.get(response.id);
		if (!pending) {
			this.child?.kill("SIGTERM");
			this.failAll(new Error(`Component process returned an unknown response id: ${response.id}`));
			return;
		}
		this.pending.delete(response.id);
		clearTimeout(pending.timer);
		if (response.ok) pending.resolve(response.result);
		else pending.reject(new Error(response.error || "Component process request failed"));
	}

	private failAll(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}
}
