/**
 * Evo workflow SDK — the single-file prelude composed into a workflow
 * component entrypoint by composeWorkflowEntrypoint().
 *
 * It owns the component side of the JSONL-RPC protocol (initialize / invoke /
 * health / shutdown plus capability-request multiplexing) and exposes the
 * orchestration primitives `agent()`, `parallel()`, and `pipeline()` so a
 * workflow author writes only:
 *
 *   runWorkflow(async ({ trigger, args, host }) => {
 *     const files = await agent("List the changed files.", { schema: FILES });
 *     return parallel(files.files.map((f) => () => agent(`Review ${f}`)));
 *   });
 *
 * Dependency-free plain JavaScript: artifacts must be a single self-contained
 * file and run in a no-network sandbox.
 */

import { createInterface } from "node:readline";

const __evoPending = new Map();
let __evoCapabilitySeq = 0;
let __evoActiveInvokeId = 0;
let __evoHost;
let __evoConcurrency = 8;
let __evoInFlight = 0;
const __evoWaiters = [];

function __evoWrite(frame) {
	process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function __evoReply(id, result) {
	__evoWrite({ id, ok: true, result });
}

function __evoReplyError(id, error) {
	const message = error instanceof Error ? error.message : String(error);
	__evoWrite({ id, ok: false, error: message.slice(0, 1_024) || "workflow failed" });
}

async function __evoAcquireSlot() {
	if (__evoInFlight < __evoConcurrency) {
		__evoInFlight += 1;
		return;
	}
	await new Promise((resolve) => __evoWaiters.push(resolve));
	__evoInFlight += 1;
}

function __evoReleaseSlot() {
	__evoInFlight -= 1;
	const next = __evoWaiters.shift();
	if (next) next();
}

/** Send one capability request and await its matching result frame. */
async function __evoCapability(capability, payload) {
	if (__evoActiveInvokeId === 0) throw new Error(`${capability} is only available inside runWorkflow's handler`);
	await __evoAcquireSlot();
	const invokeId = __evoActiveInvokeId;
	__evoCapabilitySeq += 1;
	const id = `c${__evoCapabilitySeq}`;
	try {
		return await new Promise((resolve, reject) => {
			__evoPending.set(id, { resolve, reject });
			__evoWrite({ type: "capability-request", invokeId, id, capability, payload });
		});
	} finally {
		__evoReleaseSlot();
	}
}

function __evoLastAssistantText(runResult) {
	const messages = Array.isArray(runResult?.messages) ? runResult.messages : [];
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!message || message.role !== "assistant" || !Array.isArray(message.content)) continue;
		const text = message.content
			.filter((part) => part && part.type === "text" && typeof part.text === "string")
			.map((part) => part.text)
			.join("");
		if (text) return text;
	}
	return "";
}

function __evoExtractJson(text) {
	const trimmed = text.trim();
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
	const candidates = [trimmed, fenced ? fenced[1].trim() : undefined];
	const first = trimmed.indexOf("{");
	const last = trimmed.lastIndexOf("}");
	if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));
	const firstArray = trimmed.indexOf("[");
	const lastArray = trimmed.lastIndexOf("]");
	if (firstArray !== -1 && lastArray > firstArray) candidates.push(trimmed.slice(firstArray, lastArray + 1));
	for (const candidate of candidates) {
		if (candidate === undefined) continue;
		try {
			return JSON.parse(candidate);
		} catch {
			// Try the next extraction strategy.
		}
	}
	throw new Error("response is not valid JSON");
}

/** Minimal JSON Schema subset: type, properties, required, items, enum, const. */
function __evoValidateSchema(value, schema, path = "$") {
	if (!schema || typeof schema !== "object") return;
	if (schema.enum !== undefined && !schema.enum.some((entry) => JSON.stringify(entry) === JSON.stringify(value))) {
		throw new Error(`${path} must be one of ${JSON.stringify(schema.enum)}`);
	}
	if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) {
		throw new Error(`${path} must equal ${JSON.stringify(schema.const)}`);
	}
	const type = schema.type;
	if (type === "object") {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new Error(`${path} must be an object`);
		}
		for (const key of schema.required ?? []) {
			if (!Object.hasOwn(value, key)) throw new Error(`${path}.${key} is required`);
		}
		if (schema.properties) {
			for (const [key, child] of Object.entries(schema.properties)) {
				if (Object.hasOwn(value, key)) __evoValidateSchema(value[key], child, `${path}.${key}`);
			}
		}
		if (schema.additionalProperties === false && schema.properties) {
			for (const key of Object.keys(value)) {
				if (!Object.hasOwn(schema.properties, key)) throw new Error(`${path} has unknown key: ${key}`);
			}
		}
		return;
	}
	if (type === "array") {
		if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
		if (schema.items) {
			for (const [index, entry] of value.entries()) __evoValidateSchema(entry, schema.items, `${path}[${index}]`);
		}
		return;
	}
	if (type === "string" && typeof value !== "string") throw new Error(`${path} must be a string`);
	if (type === "number" && typeof value !== "number") throw new Error(`${path} must be a number`);
	if (type === "integer" && !Number.isInteger(value)) throw new Error(`${path} must be an integer`);
	if (type === "boolean" && typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
	if (type === "null" && value !== null) throw new Error(`${path} must be null`);
}

/**
 * Spawn one isolated child agent and return its final answer.
 *
 * Without `schema` the resolved value is the agent's final text. With `schema`
 * the final text is parsed as JSON, validated against the (subset) JSON
 * Schema, and re-asked on mismatch up to `retries` extra attempts.
 */
async function agent(prompt, opts = {}) {
	const model = opts.model ?? __evoHost?.model;
	if (!model) throw new Error("agent() needs opts.model: the host granted no default spawn-agent model");
	const tools = opts.tools ?? __evoHost?.tools ?? [];
	const maxOutputTokens = opts.maxOutputTokens ?? __evoHost?.maxOutputTokensPerCall ?? 16_384;
	const schemaSuffix = opts.schema
		? `\n\nRespond with ONLY a JSON value (no prose, no code fences) matching this JSON Schema:\n${JSON.stringify(opts.schema)}`
		: "";
	const attempts = 1 + (opts.retries ?? (opts.schema ? 1 : 0));
	let lastError;
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		const corrective =
			attempt === 0 || !lastError
				? ""
				: `\n\nYour previous response was invalid (${lastError}). Respond again with ONLY valid JSON matching the schema.`;
		const payload = {
			model,
			prompt: `${prompt}${schemaSuffix}${corrective}`,
			maxOutputTokens,
			tools,
			...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
		};
		const run = await __evoCapability("spawn-agent", payload);
		const text = __evoLastAssistantText(run);
		if (!opts.schema) return text;
		try {
			const parsed = __evoExtractJson(text);
			__evoValidateSchema(parsed, opts.schema);
			return parsed;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
	}
	throw new Error(`agent() structured output failed after ${attempts} attempt(s): ${lastError}`);
}

/**
 * Run thunks concurrently and await them all (barrier). A thunk that throws
 * resolves to null instead of rejecting the whole batch.
 */
function parallel(thunks) {
	return Promise.all(
		thunks.map(async (thunk) => {
			try {
				return await thunk();
			} catch {
				return null;
			}
		}),
	);
}

/**
 * Stream items through stages with no barrier between them: each item advances
 * through all stages independently. Stage callbacks receive
 * (previousResult, originalItem, index). A stage that throws drops the item to
 * null and skips its remaining stages.
 */
function pipeline(items, ...stages) {
	return Promise.all(
		items.map(async (item, index) => {
			let value = item;
			for (const stage of stages) {
				try {
					value = await stage(value, item, index);
				} catch {
					return null;
				}
			}
			return value;
		}),
	);
}

/** Emit a progress note. Captured on the host's stderr diagnostics channel. */
function log(message) {
	process.stderr.write(`${String(message)}\n`);
}

async function __evoDrainCapabilities() {
	while (__evoPending.size > 0 || __evoInFlight > 0) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/**
 * Register the workflow handler and start serving the component protocol.
 * The handler receives { trigger, args, host } and its JSON-serializable
 * return value becomes the workflow result.
 */
function runWorkflow(handler, options = {}) {
	if (typeof handler !== "function") throw new Error("runWorkflow(handler) requires a function");
	if (options.concurrency !== undefined) {
		if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 16) {
			throw new Error("runWorkflow concurrency must be an integer from 1 to 16");
		}
		__evoConcurrency = options.concurrency;
	}
	const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
	lines.on("line", (line) => {
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}
		if (message && message.type === "capability-result") {
			const pending = __evoPending.get(message.id);
			if (!pending) return;
			__evoPending.delete(message.id);
			if (message.ok) pending.resolve(message.result);
			else pending.reject(new Error(message.error?.message ?? "capability failed"));
			return;
		}
		if (!message || !Number.isSafeInteger(message.id)) return;
		if (message.method === "initialize") {
			__evoReply(message.id, { abi: message.payload?.abi });
			return;
		}
		if (message.method === "health") {
			__evoReply(message.id, { healthy: true });
			return;
		}
		if (message.method === "shutdown") {
			__evoReply(message.id, { stopped: true });
			process.exit(0);
		}
		if (message.method === "invoke") {
			const { trigger, args, host } = message.payload ?? {};
			__evoHost = host;
			__evoActiveInvokeId = message.id;
			void (async () => {
				let outcome;
				try {
					const result = await handler({ trigger, args: args ?? {}, host, agent, parallel, pipeline, log });
					outcome = { ok: true, result: result === undefined ? null : result };
				} catch (error) {
					outcome = { ok: false, error };
				}
				// The host kills the process if an invoke reply is written while
				// capability requests are still outstanding — drain them first.
				await __evoDrainCapabilities();
				__evoActiveInvokeId = 0;
				if (outcome.ok) __evoReply(message.id, { result: outcome.result });
				else __evoReplyError(message.id, outcome.error);
			})();
		}
	});
}

export { agent, log, parallel, pipeline, runWorkflow };
