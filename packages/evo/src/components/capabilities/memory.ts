import { isDigest } from "../../bundle/schema.ts";
import type { EvoMemoryNamespace } from "../memory/store.ts";
import { parseEvoMemoryFragmentInput } from "../memory/store.ts";
import type { EvoCapabilityName } from "./protocol.ts";
import type {
	EvoCapabilityExecutionResult,
	EvoCapabilityService,
	EvoCapabilityServiceContext,
	EvoPreparedCapabilityRequest,
} from "./service.ts";

const MEMORY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_RETRIEVE_LIMIT = 100;

type MemoryReadRequest = { operation: "list" } | { operation: "get"; id: string };
type MemoryWriteRequest =
	| {
			operation: "append";
			fragment: ReturnType<typeof parseEvoMemoryFragmentInput>;
			expectedStateDigest?: string;
	  }
	| {
			operation: "update";
			fragment: ReturnType<typeof parseEvoMemoryFragmentInput>;
			expectedStateDigest?: string;
	  }
	| { operation: "forget"; id: string; expectedStateDigest?: string };
interface RetrieveRequest {
	query: string;
	limit: number;
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

function memoryId(value: unknown, label: string): string {
	if (typeof value !== "string" || !MEMORY_ID_PATTERN.test(value)) throw new Error(`${label} is invalid`);
	return value;
}

function optionalStateDigest(value: unknown, label: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !isDigest(value)) throw new Error(`${label} must be a sha256 digest`);
	return value;
}

function parseMemoryReadRequest(value: unknown): MemoryReadRequest {
	const request = asRecord(value, "memory-read request");
	if (request.operation === "list") {
		rejectUnknownKeys(request, ["operation"], "memory-read list request");
		return { operation: "list" };
	}
	if (request.operation === "get") {
		rejectUnknownKeys(request, ["operation", "id"], "memory-read get request");
		return { operation: "get", id: memoryId(request.id, "memory-read get request.id") };
	}
	throw new Error("memory-read request.operation must be 'list' or 'get'");
}

function parseMemoryWriteRequest(value: unknown): MemoryWriteRequest {
	const request = asRecord(value, "memory-write request");
	if (request.operation === "append") {
		rejectUnknownKeys(request, ["operation", "fragment", "expectedStateDigest"], "memory-write append request");
		const expectedStateDigest = optionalStateDigest(
			request.expectedStateDigest,
			"memory-write append request.expectedStateDigest",
		);
		return {
			operation: "append",
			fragment: parseEvoMemoryFragmentInput(request.fragment, "memory-write append request.fragment"),
			...(expectedStateDigest === undefined ? {} : { expectedStateDigest }),
		};
	}
	if (request.operation === "update") {
		rejectUnknownKeys(request, ["operation", "fragment", "expectedStateDigest"], "memory-write update request");
		const expectedStateDigest = optionalStateDigest(
			request.expectedStateDigest,
			"memory-write update request.expectedStateDigest",
		);
		return {
			operation: "update",
			fragment: parseEvoMemoryFragmentInput(request.fragment, "memory-write update request.fragment"),
			...(expectedStateDigest === undefined ? {} : { expectedStateDigest }),
		};
	}
	if (request.operation === "forget") {
		rejectUnknownKeys(request, ["operation", "id", "expectedStateDigest"], "memory-write forget request");
		const expectedStateDigest = optionalStateDigest(
			request.expectedStateDigest,
			"memory-write forget request.expectedStateDigest",
		);
		return {
			operation: "forget",
			id: memoryId(request.id, "memory-write forget request.id"),
			...(expectedStateDigest === undefined ? {} : { expectedStateDigest }),
		};
	}
	throw new Error("memory-write request.operation must be 'append', 'update', or 'forget'");
}

function parseRetrieveRequest(value: unknown): RetrieveRequest {
	const request = asRecord(value, "retrieve request");
	rejectUnknownKeys(request, ["query", "limit"], "retrieve request");
	if (
		typeof request.query !== "string" ||
		!request.query.trim() ||
		request.query !== request.query.trim() ||
		request.query.length > 8_000
	) {
		throw new Error("retrieve request.query must be a trimmed non-empty string of at most 8000 characters");
	}
	const limit = request.limit ?? 10;
	if (!Number.isSafeInteger(limit) || (limit as number) <= 0 || (limit as number) > MAX_RETRIEVE_LIMIT) {
		throw new Error(`retrieve request.limit must be an integer from 1 to ${MAX_RETRIEVE_LIMIT}`);
	}
	return { query: request.query, limit: limit as number };
}

function prepared(request: unknown): EvoPreparedCapabilityRequest {
	return { request };
}

function assertNamespaceComponent(namespace: EvoMemoryNamespace, context: EvoCapabilityServiceContext): void {
	namespace.assertComponent(context.component);
}

export function createMemoryCapabilityServices(
	namespace: EvoMemoryNamespace,
): Partial<Record<EvoCapabilityName, EvoCapabilityService>> {
	return {
		"memory-read": {
			prepare(value, context) {
				assertNamespaceComponent(namespace, context);
				return prepared(parseMemoryReadRequest(value));
			},
			async execute(value, context): Promise<EvoCapabilityExecutionResult> {
				assertNamespaceComponent(namespace, context);
				const request = parseMemoryReadRequest(value);
				const state = await namespace.read();
				if (request.operation === "list") return { result: state };
				return {
					result: {
						stateDigest: state.stateDigest,
						fragment: state.fragments.find((fragment) => fragment.id === request.id) ?? null,
					},
				};
			},
		},
		"memory-write": {
			prepare(value, context) {
				assertNamespaceComponent(namespace, context);
				return prepared(parseMemoryWriteRequest(value));
			},
			async execute(value, context): Promise<EvoCapabilityExecutionResult> {
				assertNamespaceComponent(namespace, context);
				const request = parseMemoryWriteRequest(value);
				if (request.operation === "append") {
					return {
						result: await namespace.append(request.fragment, request.expectedStateDigest),
					};
				}
				if (request.operation === "update") {
					return {
						result: await namespace.update(request.fragment, request.expectedStateDigest),
					};
				}
				const mutation = await namespace.forget(request.id, request.expectedStateDigest);
				return { result: { stateDigest: mutation.stateDigest, forgottenId: request.id } };
			},
		},
		retrieve: {
			prepare(value, context) {
				assertNamespaceComponent(namespace, context);
				return prepared(parseRetrieveRequest(value));
			},
			async execute(value, context): Promise<EvoCapabilityExecutionResult> {
				assertNamespaceComponent(namespace, context);
				const request = parseRetrieveRequest(value);
				return { result: await namespace.retrieve(request.query, request.limit) };
			},
		},
	};
}
