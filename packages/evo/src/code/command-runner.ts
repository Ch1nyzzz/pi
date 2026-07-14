import { spawn } from "node:child_process";

const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const KILL_GRACE_MS = 1_000;

export interface CommandRunOptions {
	cwd: string;
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	timeoutMs?: number;
	maxOutputBytes?: number;
}

export interface CommandResult {
	command: string;
	args: string[];
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
	timedOut: boolean;
	aborted: boolean;
	outputLimitExceeded: boolean;
}

export interface CommandRunner {
	run(command: string, args: readonly string[], options: CommandRunOptions): Promise<CommandResult>;
}

function appendBounded(chunks: Buffer[], chunk: Buffer, remaining: number): number {
	if (remaining <= 0) return 0;
	const accepted = chunk.subarray(0, remaining);
	if (accepted.length > 0) chunks.push(accepted);
	return accepted.length;
}

export class SpawnCommandRunner implements CommandRunner {
	async run(command: string, args: readonly string[], options: CommandRunOptions): Promise<CommandResult> {
		if (!command) throw new Error("Command must not be empty");
		if (!Number.isSafeInteger(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES)) {
			throw new Error("maxOutputBytes must be a safe integer");
		}
		const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
		if (maxOutputBytes <= 0) throw new Error("maxOutputBytes must be positive");
		if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)) {
			throw new Error("timeoutMs must be a positive safe integer");
		}

		return new Promise<CommandResult>((resolvePromise, rejectPromise) => {
			const copiedArgs = [...args];
			const child = spawn(command, copiedArgs, {
				cwd: options.cwd,
				env: options.env,
				detached: process.platform !== "win32",
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			const stdoutChunks: Buffer[] = [];
			const stderrChunks: Buffer[] = [];
			let capturedBytes = 0;
			let killed = false;
			let timedOut = false;
			let aborted = false;
			let outputLimitExceeded = false;
			let settled = false;
			let timeout: NodeJS.Timeout | undefined;
			let forceKillTimeout: NodeJS.Timeout | undefined;

			const signalProcessTree = (signal: NodeJS.Signals): void => {
				if (process.platform !== "win32" && child.pid !== undefined) {
					try {
						process.kill(-child.pid, signal);
						return;
					} catch (error) {
						if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ESRCH")
							throw error;
					}
				}
				child.kill(signal);
			};

			const terminateProcessTree = (signal: NodeJS.Signals): void => {
				try {
					signalProcessTree(signal);
				} catch {
					child.kill(signal);
				}
			};

			const kill = (): void => {
				if (killed) return;
				killed = true;
				terminateProcessTree("SIGTERM");
				forceKillTimeout = setTimeout(() => terminateProcessTree("SIGKILL"), KILL_GRACE_MS);
				forceKillTimeout.unref();
			};
			const onAbort = (): void => {
				aborted = true;
				kill();
			};
			const onData =
				(target: Buffer[]) =>
				(value: Buffer | string): void => {
					const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
					const accepted = appendBounded(target, chunk, maxOutputBytes - capturedBytes);
					capturedBytes += accepted;
					if (accepted < chunk.length) {
						outputLimitExceeded = true;
						kill();
					}
				};
			const cleanup = (): void => {
				if (timeout) clearTimeout(timeout);
				if (forceKillTimeout) clearTimeout(forceKillTimeout);
				options.signal?.removeEventListener("abort", onAbort);
			};

			child.stdout.on("data", onData(stdoutChunks));
			child.stderr.on("data", onData(stderrChunks));
			child.once("error", (error) => {
				if (settled) return;
				settled = true;
				terminateProcessTree("SIGKILL");
				cleanup();
				rejectPromise(error);
			});
			child.once("close", (code) => {
				if (settled) return;
				settled = true;
				terminateProcessTree("SIGKILL");
				cleanup();
				resolvePromise({
					command,
					args: copiedArgs,
					stdout: Buffer.concat(stdoutChunks).toString("utf8"),
					stderr: Buffer.concat(stderrChunks).toString("utf8"),
					code: code ?? 1,
					killed,
					timedOut,
					aborted,
					outputLimitExceeded,
				});
			});

			if (options.signal?.aborted) onAbort();
			else options.signal?.addEventListener("abort", onAbort, { once: true });
			if (options.timeoutMs !== undefined) {
				timeout = setTimeout(() => {
					timedOut = true;
					kill();
				}, options.timeoutMs);
			}
		});
	}
}
