import { canonicalJson } from "../../storage.ts";

export const EVO_CAPABILITY_NAMES = [
	"infer",
	"read-file",
	"write-file",
	"list-dir",
	"exec",
	"http-fetch",
	"retrieve",
	"memory-read",
	"memory-write",
	"spawn-agent",
] as const;

export type EvoCapabilityName = (typeof EVO_CAPABILITY_NAMES)[number];

const CAPABILITY_NAMES = new Set<string>(EVO_CAPABILITY_NAMES);
const FRAME_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface EvoCapabilityRequestFrame {
	type: "capability-request";
	/** Host request id of the invoke that owns this nested call. */
	invokeId: number;
	/** Component-chosen id, unique within an invoke. */
	id: string;
	capability: EvoCapabilityName;
	payload: unknown;
}

export interface EvoCapabilityFrameError {
	code: string;
	message: string;
}

export type EvoCapabilityResultFrame =
	| {
			type: "capability-result";
			invokeId: number;
			id: string;
			ok: true;
			result: unknown;
	  }
	| {
			type: "capability-result";
			invokeId: number;
			id: string;
			ok: false;
			error: EvoCapabilityFrameError;
	  };

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

function requireFrameId(value: unknown, label: string): string {
	if (typeof value !== "string" || !FRAME_ID_PATTERN.test(value)) {
		throw new Error(`${label} must be a safe identifier of at most 128 characters`);
	}
	return value;
}

function requireInvokeId(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) <= 0) {
		throw new Error(`${label} must be a positive safe integer`);
	}
	return value as number;
}

function requireJson(value: unknown, label: string): unknown {
	try {
		return JSON.parse(canonicalJson(value)) as unknown;
	} catch (error) {
		throw new Error(`${label} must be JSON data`, { cause: error });
	}
}

export function parseEvoCapabilityRequestFrame(value: unknown): EvoCapabilityRequestFrame {
	const frame = asRecord(value, "capability request frame");
	rejectUnknownKeys(frame, ["type", "invokeId", "id", "capability", "payload"], "capability request frame");
	if (frame.type !== "capability-request") {
		throw new Error("capability request frame.type must be 'capability-request'");
	}
	const invokeId = requireInvokeId(frame.invokeId, "capability request frame.invokeId");
	const id = requireFrameId(frame.id, "capability request frame.id");
	if (typeof frame.capability !== "string" || !CAPABILITY_NAMES.has(frame.capability)) {
		throw new Error("capability request frame.capability is unsupported");
	}
	if (!Object.hasOwn(frame, "payload")) throw new Error("capability request frame.payload is required");
	return {
		type: "capability-request",
		invokeId,
		id,
		capability: frame.capability as EvoCapabilityName,
		payload: requireJson(frame.payload, "capability request frame.payload"),
	};
}

export function parseEvoCapabilityRequestLine(line: string): EvoCapabilityRequestFrame {
	let value: unknown;
	try {
		value = JSON.parse(line) as unknown;
	} catch (error) {
		throw new Error("Component process returned invalid JSON", { cause: error });
	}
	return parseEvoCapabilityRequestFrame(value);
}

export function capabilitySuccessFrame(request: EvoCapabilityRequestFrame, result: unknown): EvoCapabilityResultFrame {
	return {
		type: "capability-result",
		invokeId: request.invokeId,
		id: request.id,
		ok: true,
		result: requireJson(result, "capability result"),
	};
}

export function capabilityErrorFrame(
	request: EvoCapabilityRequestFrame,
	code: string,
	message: string,
): EvoCapabilityResultFrame {
	if (!/^[a-z][a-z0-9_-]{0,63}$/.test(code)) throw new Error("capability error code is invalid");
	if (!message || message.length > 1_024) throw new Error("capability error message is invalid");
	return {
		type: "capability-result",
		invokeId: request.invokeId,
		id: request.id,
		ok: false,
		error: { code, message },
	};
}
