import { Buffer } from "node:buffer";
import { type ChildProcess, spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
	atomicWriteRegularFileNoFollow,
	readRegularDirectoryNoFollow,
	readRegularFileNoFollow,
	resolveRegularDirectory,
} from "../../secure-file.ts";
import { canonicalJson } from "../../storage.ts";
import type { EvoCapabilityName } from "./protocol.ts";
import type { EvoCapabilityExecutionResult, EvoCapabilityService, EvoPreparedCapabilityRequest } from "./service.ts";

const ROOT_ALIAS_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const COMMAND_ALIAS_PATTERN = ROOT_ALIAS_PATTERN;
const MAX_ARGUMENTS = 256;
const MAX_ARGUMENT_BYTES = 64 * 1024;

export interface EvoFileCapabilityOptions {
	readRoots?: Record<string, string>;
	writeRoots?: Record<string, string>;
	maxReadBytes?: number;
	maxWriteBytes?: number;
	maxListEntries?: number;
}

export interface EvoExecCapabilityOptions {
	commands: Record<string, string>;
	cwdRoots: Record<string, string>;
	maxOutputBytes?: number;
	maxTimeoutMs?: number;
	terminationGraceMs?: number;
}

export interface EvoHttpFetchCapabilityOptions {
	origins: string[];
	maxResponseBytes?: number;
	maxRequestBytes?: number;
	maxTimeoutMs?: number;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
	const allowedKeys = new Set(allowed);
	for (const key of Object.keys(record)) {
		if (!allowedKeys.has(key)) throw new Error(`${label} has unknown key: ${key}`);
	}
}

function positiveInteger(value: unknown, fallback: number, label: string): number {
	const resolved = value ?? fallback;
	if (!Number.isSafeInteger(resolved) || (resolved as number) <= 0) {
		throw new Error(`${label} must be a positive integer`);
	}
	return resolved as number;
}

function parseRootMap(value: Record<string, string> | undefined, label: string): Record<string, string> {
	const roots: Record<string, string> = {};
	for (const [alias, path] of Object.entries(value ?? {})) {
		if (!ROOT_ALIAS_PATTERN.test(alias)) throw new Error(`${label} has an invalid alias: ${alias}`);
		if (!isAbsolute(path)) throw new Error(`${label}.${alias} must be absolute`);
		roots[alias] = resolve(path);
	}
	return roots;
}

function parseRelativePath(value: unknown, label: string): string {
	if (typeof value !== "string" || value.includes("\\") || value.startsWith("/") || value.includes("\0")) {
		throw new Error(`${label} must be a normalized relative path`);
	}
	if (value === "") return value;
	if (value.split("/").some((part) => !part || part === "." || part === "..")) {
		throw new Error(`${label} contains an unsafe segment`);
	}
	return value;
}

function parseRootRequest(value: unknown, label: string): { root: string; path: string } {
	const request = asRecord(value, label);
	if (typeof request.root !== "string" || !ROOT_ALIAS_PATTERN.test(request.root)) {
		throw new Error(`${label}.root is invalid`);
	}
	return { root: request.root, path: parseRelativePath(request.path, `${label}.path`) };
}

function isWithin(root: string, path: string): boolean {
	const child = relative(root, path);
	return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

async function resolveExistingPath(roots: Record<string, string>, rootAlias: string, path: string): Promise<string> {
	const configuredRoot = roots[rootAlias];
	if (!configuredRoot) throw new Error(`Root is not granted: ${rootAlias}`);
	const [realRoot, realTarget] = await Promise.all([
		realpath(configuredRoot),
		realpath(path ? join(configuredRoot, path) : configuredRoot),
	]);
	if (!isWithin(realRoot, realTarget)) throw new Error("Path escapes its granted root");
	return realTarget;
}

async function resolveGrantedRoot(roots: Record<string, string>, rootAlias: string, label: string): Promise<string> {
	const configuredRoot = roots[rootAlias];
	if (!configuredRoot) throw new Error(`Root is not granted: ${rootAlias}`);
	return resolveRegularDirectory(configuredRoot, label);
}

function prepared(request: unknown): EvoPreparedCapabilityRequest {
	canonicalJson(request);
	return { request };
}

export function createFileCapabilityServices(
	options: EvoFileCapabilityOptions,
): Partial<Record<EvoCapabilityName, EvoCapabilityService>> {
	const readRoots = parseRootMap(options.readRoots, "readRoots");
	const writeRoots = parseRootMap(options.writeRoots, "writeRoots");
	const maxReadBytes = positiveInteger(options.maxReadBytes, 1024 * 1024, "maxReadBytes");
	const maxWriteBytes = positiveInteger(options.maxWriteBytes, 1024 * 1024, "maxWriteBytes");
	const maxListEntries = positiveInteger(options.maxListEntries, 10_000, "maxListEntries");
	return {
		"read-file": {
			prepare(value) {
				const request = asRecord(value, "read-file request");
				rejectUnknownKeys(request, ["root", "path", "encoding"], "read-file request");
				const rootPath = parseRootRequest(request, "read-file request");
				if (request.encoding !== "utf8" && request.encoding !== "base64") {
					throw new Error("read-file request.encoding must be 'utf8' or 'base64'");
				}
				return prepared({ ...rootPath, encoding: request.encoding });
			},
			async execute(value, context): Promise<EvoCapabilityExecutionResult> {
				if (context.signal.aborted) throw new Error("read-file request aborted");
				const request = asRecord(value, "read-file request");
				const root = await resolveGrantedRoot(readRoots, request.root as string, "read-file granted root");
				const target = request.path ? join(root, request.path as string) : root;
				const file = await readRegularFileNoFollow(target, "read-file target", maxReadBytes);
				return {
					result: {
						content: request.encoding === "base64" ? file.toString("base64") : file.toString("utf8"),
						bytes: file.byteLength,
						encoding: request.encoding,
					},
				};
			},
		},
		"write-file": {
			prepare(value) {
				const request = asRecord(value, "write-file request");
				rejectUnknownKeys(request, ["root", "path", "content", "encoding"], "write-file request");
				const rootPath = parseRootRequest(request, "write-file request");
				if (typeof request.content !== "string") throw new Error("write-file request.content must be a string");
				if (request.encoding !== "utf8") throw new Error("write-file request.encoding must be 'utf8'");
				const content = Buffer.from(request.content, "utf8");
				if (content.byteLength > maxWriteBytes)
					throw new Error("write-file request exceeds the configured byte limit");
				return prepared({ ...rootPath, content: request.content, encoding: request.encoding });
			},
			async execute(value, context): Promise<EvoCapabilityExecutionResult> {
				if (context.signal.aborted) throw new Error("write-file request aborted");
				const request = asRecord(value, "write-file request");
				if (!request.path) throw new Error("write-file request.path must name a file");
				const root = await resolveGrantedRoot(writeRoots, request.root as string, "write-file granted root");
				const target = join(root, request.path as string);
				const content = request.content as string;
				if (context.signal.aborted) throw new Error("write-file request aborted");
				await atomicWriteRegularFileNoFollow(target, content, "write-file target");
				return { result: { bytes: Buffer.byteLength(content, "utf8") } };
			},
		},
		"list-dir": {
			prepare(value) {
				const request = asRecord(value, "list-dir request");
				rejectUnknownKeys(request, ["root", "path"], "list-dir request");
				return prepared(parseRootRequest(request, "list-dir request"));
			},
			async execute(value, context): Promise<EvoCapabilityExecutionResult> {
				if (context.signal.aborted) throw new Error("list-dir request aborted");
				const request = asRecord(value, "list-dir request");
				const root = await resolveGrantedRoot(readRoots, request.root as string, "list-dir granted root");
				const target = request.path ? join(root, request.path as string) : root;
				const entries = await readRegularDirectoryNoFollow(target, "list-dir target");
				if (entries.length > maxListEntries) throw new Error("list-dir result exceeds the configured entry limit");
				return {
					result: {
						entries: entries
							.map((entry) => ({
								name: entry.name,
								type: entry.isDirectory()
									? "directory"
									: entry.isFile()
										? "file"
										: entry.isSymbolicLink()
											? "symlink"
											: "other",
							}))
							.sort((left, right) => left.name.localeCompare(right.name)),
					},
				};
			},
		},
	};
}

function parseExecRequest(value: unknown, maxTimeoutMs: number) {
	const request = asRecord(value, "exec request");
	rejectUnknownKeys(request, ["command", "args", "cwd", "timeoutMs"], "exec request");
	if (typeof request.command !== "string" || !COMMAND_ALIAS_PATTERN.test(request.command)) {
		throw new Error("exec request.command is invalid");
	}
	if (
		!Array.isArray(request.args) ||
		request.args.length > MAX_ARGUMENTS ||
		request.args.some((argument) => typeof argument !== "string" || argument.includes("\0"))
	) {
		throw new Error("exec request.args must be a bounded string array");
	}
	if (Buffer.byteLength(request.args.join("\0"), "utf8") > MAX_ARGUMENT_BYTES) {
		throw new Error("exec request.args exceeds the byte limit");
	}
	const cwd = parseRootRequest(request.cwd, "exec request.cwd");
	const timeoutMs = positiveInteger(request.timeoutMs, maxTimeoutMs, "exec request.timeoutMs");
	if (timeoutMs > maxTimeoutMs) throw new Error("exec request.timeoutMs exceeds the configured limit");
	return { command: request.command, args: request.args as string[], cwd, timeoutMs };
}

interface ExecProcessClose {
	code: number | null;
	signal: NodeJS.Signals | null;
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
	const pid = child.pid;
	if (pid === undefined) return;
	try {
		process.kill(-pid, signal);
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return;
		throw error;
	}
}

function processGroupExists(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return false;
		throw error;
	}
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (processGroupExists(pid)) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) return false;
		await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, Math.min(remaining, 10)));
	}
	return true;
}

async function terminateExecProcessGroup(
	child: ChildProcess,
	closed: Promise<ExecProcessClose>,
	terminationGraceMs: number,
): Promise<void> {
	if (process.platform === "win32") {
		throw new Error("exec capability cannot guarantee process-tree teardown on win32");
	}
	const pid = child.pid;
	if (pid === undefined) {
		await closed;
		return;
	}
	try {
		signalProcessGroup(child, "SIGTERM");
		if (await waitForProcessGroupExit(pid, terminationGraceMs)) {
			await closed;
			return;
		}
		signalProcessGroup(child, "SIGKILL");
		await closed;
		if (!(await waitForProcessGroupExit(pid, terminationGraceMs))) {
			throw new Error("exec process group still exists after SIGKILL");
		}
	} catch (error) {
		child.kill("SIGKILL");
		await closed;
		throw new Error("exec process-group teardown failed", { cause: error });
	}
}

export function createExecCapabilityService(options: EvoExecCapabilityOptions): EvoCapabilityService {
	const commands: Record<string, string> = {};
	for (const [alias, command] of Object.entries(options.commands)) {
		if (!COMMAND_ALIAS_PATTERN.test(alias)) throw new Error(`commands has an invalid alias: ${alias}`);
		if (!isAbsolute(command)) throw new Error(`commands.${alias} must be absolute`);
		commands[alias] = resolve(command);
	}
	const cwdRoots = parseRootMap(options.cwdRoots, "cwdRoots");
	const maxOutputBytes = positiveInteger(options.maxOutputBytes, 1024 * 1024, "maxOutputBytes");
	const maxTimeoutMs = positiveInteger(options.maxTimeoutMs, 60_000, "maxTimeoutMs");
	const terminationGraceMs = positiveInteger(options.terminationGraceMs, 1_000, "terminationGraceMs");
	return {
		prepare(value) {
			return prepared(parseExecRequest(value, maxTimeoutMs));
		},
		async execute(value, context): Promise<EvoCapabilityExecutionResult> {
			if (process.platform === "win32") {
				throw new Error(
					"exec capability is unavailable on win32 because process-tree teardown cannot be guaranteed",
				);
			}
			if (context.signal.aborted) throw new Error("exec request aborted");
			const request = parseExecRequest(value, maxTimeoutMs);
			const command = commands[request.command];
			if (!command) throw new Error(`Command is not granted: ${request.command}`);
			const cwd = await resolveExistingPath(cwdRoots, request.cwd.root, request.cwd.path);
			return new Promise((resolvePromise, reject) => {
				const child = spawn(command, request.args, {
					cwd,
					env: { HOME: cwd, LANG: "C.UTF-8", PATH: "" },
					stdio: ["ignore", "pipe", "pipe"],
					detached: true,
				});
				const stdout: Buffer[] = [];
				const stderr: Buffer[] = [];
				let bytes = 0;
				let settled = false;
				let timer: NodeJS.Timeout | undefined;
				let resolveClosed: (value: ExecProcessClose) => void = () => {};
				const closed = new Promise<ExecProcessClose>((resolveClose) => {
					resolveClosed = resolveClose;
				});
				let abort = (): void => {};
				const cleanup = (): void => {
					if (timer) clearTimeout(timer);
					context.signal.removeEventListener("abort", abort);
				};
				const finishError = (error: Error): void => {
					if (settled) return;
					settled = true;
					cleanup();
					void terminateExecProcessGroup(child, closed, terminationGraceMs).then(
						() => reject(error),
						(teardownError: unknown) =>
							reject(new Error(`${error.message}; exec process teardown failed`, { cause: teardownError })),
					);
				};
				const capture =
					(target: Buffer[]) =>
					(chunk: Buffer | string): void => {
						if (settled) return;
						const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
						bytes += buffer.byteLength;
						if (bytes > maxOutputBytes) {
							finishError(new Error("exec output exceeds the configured byte limit"));
							return;
						}
						target.push(buffer);
					};
				child.stdout.on("data", capture(stdout));
				child.stderr.on("data", capture(stderr));
				child.once("error", finishError);
				child.once("close", (code, signal) => {
					resolveClosed({ code, signal });
					if (settled) return;
					settled = true;
					cleanup();
					const response: EvoCapabilityExecutionResult = {
						result: {
							exitCode: code,
							signal,
							stdout: Buffer.concat(stdout).toString("utf8"),
							stderr: Buffer.concat(stderr).toString("utf8"),
						},
					};
					void terminateExecProcessGroup(child, closed, terminationGraceMs).then(
						() => resolvePromise(response),
						(teardownError: unknown) =>
							reject(new Error("exec process teardown failed after command exit", { cause: teardownError })),
					);
				});
				abort = (): void => finishError(new Error("exec request aborted"));
				context.signal.addEventListener("abort", abort, { once: true });
				timer = setTimeout(() => finishError(new Error("exec request timed out")), request.timeoutMs);
				timer.unref();
				if (context.signal.aborted) abort();
			});
		},
	};
}

function parseFetchRequest(value: unknown, maxRequestBytes: number, maxTimeoutMs: number) {
	const request = asRecord(value, "http-fetch request");
	rejectUnknownKeys(
		request,
		["url", "method", "headers", "body", "responseEncoding", "timeoutMs"],
		"http-fetch request",
	);
	if (typeof request.url !== "string" || request.url.length > 8_192)
		throw new Error("http-fetch request.url is invalid");
	const method = request.method ?? "GET";
	if (method !== "GET" && method !== "HEAD" && method !== "POST") {
		throw new Error("http-fetch request.method must be GET, HEAD, or POST");
	}
	const headers = request.headers === undefined ? {} : asRecord(request.headers, "http-fetch request.headers");
	const normalizedHeaders: Record<string, string> = {};
	for (const [name, headerValue] of Object.entries(headers)) {
		const lower = name.toLowerCase();
		if (!new Set(["accept", "content-type", "user-agent"]).has(lower) || typeof headerValue !== "string") {
			throw new Error(`http-fetch request header is not allowed: ${name}`);
		}
		normalizedHeaders[lower] = headerValue;
	}
	if (request.body !== undefined && typeof request.body !== "string") {
		throw new Error("http-fetch request.body must be a string");
	}
	if (method !== "POST" && request.body !== undefined) throw new Error("http-fetch body requires POST");
	if (Buffer.byteLength((request.body as string | undefined) ?? "", "utf8") > maxRequestBytes) {
		throw new Error("http-fetch request body exceeds the configured byte limit");
	}
	const responseEncoding = request.responseEncoding ?? "utf8";
	if (responseEncoding !== "utf8" && responseEncoding !== "base64") {
		throw new Error("http-fetch request.responseEncoding must be 'utf8' or 'base64'");
	}
	const timeoutMs = positiveInteger(request.timeoutMs, maxTimeoutMs, "http-fetch request.timeoutMs");
	if (timeoutMs > maxTimeoutMs) throw new Error("http-fetch request.timeoutMs exceeds the configured limit");
	return {
		url: request.url,
		method,
		headers: normalizedHeaders,
		...(request.body === undefined ? {} : { body: request.body }),
		responseEncoding,
		timeoutMs,
	};
}

function validateFetchUrl(value: string, origins: Set<string>): URL {
	const url = new URL(value);
	if (url.protocol !== "https:" || url.username || url.password || !origins.has(url.origin)) {
		throw new Error("http-fetch URL is outside the granted HTTPS origins");
	}
	return url;
}

async function boundedResponseBody(response: Response, maxBytes: number): Promise<Buffer> {
	if (!response.body) return Buffer.alloc(0);
	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	let bytes = 0;
	while (true) {
		const next = await reader.read();
		if (next.done) break;
		bytes += next.value.byteLength;
		if (bytes > maxBytes) {
			await reader.cancel();
			throw new Error("http-fetch response exceeds the configured byte limit");
		}
		chunks.push(Buffer.from(next.value));
	}
	return Buffer.concat(chunks);
}

export function createHttpFetchCapabilityService(options: EvoHttpFetchCapabilityOptions): EvoCapabilityService {
	const origins = new Set(
		options.origins.map((origin) => {
			const parsed = new URL(origin);
			if (parsed.protocol !== "https:" || parsed.origin !== origin || parsed.username || parsed.password) {
				throw new Error(`Invalid granted HTTPS origin: ${origin}`);
			}
			return origin;
		}),
	);
	const maxResponseBytes = positiveInteger(options.maxResponseBytes, 1024 * 1024, "maxResponseBytes");
	const maxRequestBytes = positiveInteger(options.maxRequestBytes, 1024 * 1024, "maxRequestBytes");
	const maxTimeoutMs = positiveInteger(options.maxTimeoutMs, 60_000, "maxTimeoutMs");
	return {
		prepare(value) {
			const request = parseFetchRequest(value, maxRequestBytes, maxTimeoutMs);
			validateFetchUrl(request.url, origins);
			return prepared(request);
		},
		async execute(value, context): Promise<EvoCapabilityExecutionResult> {
			if (context.signal.aborted) throw new Error("http-fetch request aborted");
			const request = parseFetchRequest(value, maxRequestBytes, maxTimeoutMs);
			let url = validateFetchUrl(request.url, origins);
			const controller = new AbortController();
			const abort = (): void => controller.abort(context.signal.reason);
			context.signal.addEventListener("abort", abort, { once: true });
			if (context.signal.aborted) abort();
			const timer = setTimeout(() => controller.abort(new Error("http-fetch request timed out")), request.timeoutMs);
			timer.unref();
			try {
				for (let redirects = 0; redirects <= 5; redirects += 1) {
					const response = await fetch(url, {
						method: request.method,
						headers: request.headers,
						...(request.body === undefined ? {} : { body: request.body }),
						redirect: "manual",
						signal: controller.signal,
					});
					if (response.status >= 300 && response.status < 400) {
						const location = response.headers.get("location");
						if (!location || redirects === 5) throw new Error("http-fetch redirect limit exceeded");
						url = validateFetchUrl(new URL(location, url).toString(), origins);
						continue;
					}
					const body = await boundedResponseBody(response, maxResponseBytes);
					return {
						result: {
							url: url.toString(),
							status: response.status,
							headers: Object.fromEntries(response.headers.entries()),
							body: request.responseEncoding === "base64" ? body.toString("base64") : body.toString("utf8"),
							encoding: request.responseEncoding,
						},
					};
				}
				throw new Error("http-fetch redirect limit exceeded");
			} finally {
				clearTimeout(timer);
				context.signal.removeEventListener("abort", abort);
			}
		},
	};
}
