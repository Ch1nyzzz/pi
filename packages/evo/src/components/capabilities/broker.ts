import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { isDigest } from "../../bundle/schema.ts";
import type { EvoPaths } from "../../paths.ts";
import {
	appendJsonLine,
	atomicWriteJson,
	canonicalJson,
	readJsonIfExists,
	sha256,
	withFileLock,
} from "../../storage.ts";
import { assertEvoCapability, assertEvoComponentId } from "../manifest.ts";
import { EVO_CAPABILITY_NAMES, type EvoCapabilityName, type EvoCapabilityRequestFrame } from "./protocol.ts";
import type {
	EvoCapabilityComponentIdentity,
	EvoCapabilityExecutionResult,
	EvoCapabilityResourceUsage,
	EvoCapabilityService,
	EvoCapabilityServiceContext,
	EvoPreparedCapabilityRequest,
} from "./service.ts";

type BudgetedCapabilityName = Extract<EvoCapabilityName, "infer" | "spawn-agent">;
type CallCapabilityName = Exclude<EvoCapabilityName, BudgetedCapabilityName>;
const CAPABILITY_NAMES = new Set<string>(EVO_CAPABILITY_NAMES);
const PROCESS_CAPABILITY_SESSION_ID = randomUUID();
const DEFAULT_MAX_AUDIT_RESULT_BYTES = 1024 * 1024;
const ACTIVE_CAPABILITY_EVENTS = new Set<string>();

export interface EvoCallCapabilityGrant {
	capability: CallCapabilityName;
	maxCalls: number;
}

export interface EvoBudgetedCapabilityGrant {
	capability: BudgetedCapabilityName;
	maxCalls: number;
	models: string[];
	maxInputTokens: number;
	maxOutputTokens: number;
	maxTotalTokens: number;
	maxCostUsd: number;
	maxOutputTokensPerCall: number;
	/** Only meaningful for spawn-agent; omitted for infer. */
	tools?: string[];
}

export type EvoCapabilityGrant = EvoCallCapabilityGrant | EvoBudgetedCapabilityGrant;

export interface EvoCapabilityUsage extends EvoCapabilityResourceUsage {
	capability: EvoCapabilityName;
	calls: number;
}

interface EvoCapabilityReservation extends EvoCapabilityResourceUsage {
	eventId: string;
	authorityId: string;
	artifactDigest: string;
	capability: BudgetedCapabilityName;
}

interface EvoCapabilityOperation {
	eventId: string;
	authorityId: string;
	sessionId: string;
	ownerPid: number;
	startedAt: string;
	component: {
		id: string;
		abi: string;
		artifactDigest: string;
	};
	request: {
		invokeId: number;
		id: string;
		capability: EvoCapabilityName;
	};
}

interface EvoPendingCapabilityAudit {
	auditId: string;
	event: Record<string, unknown>;
}

export interface EvoComponentCapabilityState {
	authorityId: string;
	id: string;
	artifactDigest: string;
	grants: EvoCapabilityGrant[];
	usage: EvoCapabilityUsage[];
}

export interface EvoCapabilityState {
	schemaVersion: 1;
	components: EvoComponentCapabilityState[];
	reservations: EvoCapabilityReservation[];
	operations: EvoCapabilityOperation[];
	pendingAudit: EvoPendingCapabilityAudit[];
}

export type EvoCapabilityBrokerFaultPoint = "after-state-write" | "after-audit-append";

export interface EvoCapabilityBrokerOptions {
	paths: EvoPaths;
	services?: Partial<Record<EvoCapabilityName, EvoCapabilityService>>;
	now?: () => string;
	randomId?: () => string;
	maxAuditResultBytes?: number;
	/** Process-wide by default; injectable only for crash-recovery tests. */
	sessionId?: string;
	/** Current process id by default; injectable only for crash-recovery tests. */
	ownerPid?: number;
	/** Fault injection hook used to verify durable recovery boundaries. */
	faultInjector?: (point: EvoCapabilityBrokerFaultPoint) => void | Promise<void>;
}

export class EvoCapabilityDeniedError extends Error {
	readonly code: string;

	constructor(code: string, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "EvoCapabilityDeniedError";
		this.code = code;
	}
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

function positiveInteger(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${label} must be a positive integer`);
	return value as number;
}

function nonNegativeInteger(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new Error(`${label} must be a non-negative integer`);
	}
	return value as number;
}

function nonNegativeNumber(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(`${label} must be a non-negative finite number`);
	}
	return value;
}

function positiveNumber(value: unknown, label: string): number {
	const number = nonNegativeNumber(value, label);
	if (number === 0) throw new Error(`${label} must be positive`);
	return number;
}

function stringArray(value: unknown, label: string, requireOne: boolean): string[] {
	if (
		!Array.isArray(value) ||
		(requireOne && value.length === 0) ||
		value.some((entry) => typeof entry !== "string" || !entry || entry.length > 300)
	) {
		throw new Error(`${label} must be ${requireOne ? "a non-empty" : "an"} array of non-empty strings`);
	}
	const strings = value as string[];
	if (new Set(strings).size !== strings.length) throw new Error(`${label} must not contain duplicates`);
	return [...strings].sort();
}

function isBudgetedCapability(capability: EvoCapabilityName): capability is BudgetedCapabilityName {
	return capability === "infer" || capability === "spawn-agent";
}

function isBudgetedGrant(grant: EvoCapabilityGrant): grant is EvoBudgetedCapabilityGrant {
	return grant.capability === "infer" || grant.capability === "spawn-agent";
}

function parseGrant(value: unknown, label: string): EvoCapabilityGrant {
	const record = asRecord(value, label);
	if (typeof record.capability !== "string") throw new Error(`${label}.capability must be a string`);
	assertEvoCapability(record.capability, `${label}.capability`);
	if (!CAPABILITY_NAMES.has(record.capability)) throw new Error(`${label}.capability is unsupported`);
	if (record.capability !== "infer" && record.capability !== "spawn-agent") {
		rejectUnknownKeys(record, ["capability", "maxCalls"], label);
		return {
			capability: record.capability as CallCapabilityName,
			maxCalls: positiveInteger(record.maxCalls, `${label}.maxCalls`),
		};
	}
	rejectUnknownKeys(
		record,
		[
			"capability",
			"maxCalls",
			"models",
			"maxInputTokens",
			"maxOutputTokens",
			"maxTotalTokens",
			"maxCostUsd",
			"maxOutputTokensPerCall",
			"tools",
		],
		label,
	);
	if (record.capability === "infer" && record.tools !== undefined) {
		throw new Error(`${label}.tools is only supported for spawn-agent`);
	}
	const grant: EvoBudgetedCapabilityGrant = {
		capability: record.capability,
		maxCalls: positiveInteger(record.maxCalls, `${label}.maxCalls`),
		models: stringArray(record.models, `${label}.models`, true),
		maxInputTokens: positiveInteger(record.maxInputTokens, `${label}.maxInputTokens`),
		maxOutputTokens: positiveInteger(record.maxOutputTokens, `${label}.maxOutputTokens`),
		maxTotalTokens: positiveInteger(record.maxTotalTokens, `${label}.maxTotalTokens`),
		maxCostUsd: positiveNumber(record.maxCostUsd, `${label}.maxCostUsd`),
		maxOutputTokensPerCall: positiveInteger(record.maxOutputTokensPerCall, `${label}.maxOutputTokensPerCall`),
		...(record.tools === undefined ? {} : { tools: stringArray(record.tools, `${label}.tools`, false) }),
	};
	if (grant.maxTotalTokens < grant.maxInputTokens || grant.maxTotalTokens < grant.maxOutputTokens) {
		throw new Error(`${label}.maxTotalTokens must cover each token sub-budget`);
	}
	if (grant.maxOutputTokensPerCall > grant.maxOutputTokens) {
		throw new Error(`${label}.maxOutputTokensPerCall exceeds maxOutputTokens`);
	}
	return grant;
}

function requireAuthorityId(value: unknown, label: string): string {
	if (typeof value !== "string" || !isDigest(value)) throw new Error(`${label} must be a sha256 digest`);
	return value;
}

/**
 * Parse an explicit grant list without touching broker state. Import and
 * proposal code use this to freeze the exact authority a future selection may
 * receive before a component is registered with the broker.
 */
export function parseEvoCapabilityGrants(value: unknown, label = "grants"): EvoCapabilityGrant[] {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
	const grants = value.map((grant, index) => parseGrant(grant, `${label}[${index}]`));
	if (new Set(grants.map((grant) => grant.capability)).size !== grants.length) {
		throw new Error(`${label} must not contain duplicate capabilities`);
	}
	return grants.sort((left, right) => left.capability.localeCompare(right.capability));
}

export function deriveEvoCapabilityAuthorityId(artifactDigest: string, grants: readonly EvoCapabilityGrant[]): string {
	if (!isDigest(artifactDigest)) throw new Error("capability authority artifactDigest must be a sha256 digest");
	const parsed = parseEvoCapabilityGrants(grants, "capability authority grants");
	return sha256(canonicalJson({ artifactDigest, grants: parsed }));
}

function parseUsage(value: unknown, label: string): EvoCapabilityUsage {
	const record = asRecord(value, label);
	rejectUnknownKeys(record, ["capability", "calls", "inputTokens", "outputTokens", "totalTokens", "costUsd"], label);
	if (typeof record.capability !== "string") throw new Error(`${label}.capability must be a string`);
	assertEvoCapability(record.capability, `${label}.capability`);
	if (!CAPABILITY_NAMES.has(record.capability)) throw new Error(`${label}.capability is unsupported`);
	return {
		capability: record.capability as EvoCapabilityName,
		calls: nonNegativeInteger(record.calls, `${label}.calls`),
		inputTokens: nonNegativeInteger(record.inputTokens, `${label}.inputTokens`),
		outputTokens: nonNegativeInteger(record.outputTokens, `${label}.outputTokens`),
		totalTokens: nonNegativeInteger(record.totalTokens, `${label}.totalTokens`),
		costUsd: nonNegativeNumber(record.costUsd, `${label}.costUsd`),
	};
}

function parseReservation(value: unknown, label: string): EvoCapabilityReservation {
	const record = asRecord(value, label);
	rejectUnknownKeys(
		record,
		[
			"eventId",
			"authorityId",
			"artifactDigest",
			"capability",
			"inputTokens",
			"outputTokens",
			"totalTokens",
			"costUsd",
		],
		label,
	);
	if (typeof record.eventId !== "string" || !record.eventId) throw new Error(`${label}.eventId is invalid`);
	if (typeof record.artifactDigest !== "string" || !isDigest(record.artifactDigest)) {
		throw new Error(`${label}.artifactDigest must be a digest`);
	}
	if (record.capability !== "infer" && record.capability !== "spawn-agent") {
		throw new Error(`${label}.capability is not budgeted`);
	}
	return {
		eventId: record.eventId,
		authorityId: requireAuthorityId(record.authorityId, `${label}.authorityId`),
		artifactDigest: record.artifactDigest,
		capability: record.capability,
		inputTokens: nonNegativeInteger(record.inputTokens, `${label}.inputTokens`),
		outputTokens: nonNegativeInteger(record.outputTokens, `${label}.outputTokens`),
		totalTokens: nonNegativeInteger(record.totalTokens, `${label}.totalTokens`),
		costUsd: nonNegativeNumber(record.costUsd, `${label}.costUsd`),
	};
}

function parseOperation(value: unknown, label: string): EvoCapabilityOperation {
	const record = asRecord(value, label);
	rejectUnknownKeys(
		record,
		["eventId", "authorityId", "sessionId", "ownerPid", "startedAt", "component", "request"],
		label,
	);
	if (typeof record.eventId !== "string" || !record.eventId) throw new Error(`${label}.eventId is invalid`);
	if (typeof record.sessionId !== "string" || !record.sessionId || record.sessionId.length > 300) {
		throw new Error(`${label}.sessionId is invalid`);
	}
	if (
		typeof record.startedAt !== "string" ||
		!Number.isFinite(Date.parse(record.startedAt)) ||
		new Date(record.startedAt).toISOString() !== record.startedAt
	) {
		throw new Error(`${label}.startedAt must be an ISO timestamp`);
	}
	const component = asRecord(record.component, `${label}.component`);
	rejectUnknownKeys(component, ["id", "abi", "artifactDigest"], `${label}.component`);
	if (typeof component.id !== "string") throw new Error(`${label}.component.id must be a string`);
	assertEvoComponentId(component.id, `${label}.component.id`);
	if (typeof component.abi !== "string" || !component.abi) throw new Error(`${label}.component.abi is invalid`);
	if (typeof component.artifactDigest !== "string" || !isDigest(component.artifactDigest)) {
		throw new Error(`${label}.component.artifactDigest must be a digest`);
	}
	const request = asRecord(record.request, `${label}.request`);
	rejectUnknownKeys(request, ["invokeId", "id", "capability"], `${label}.request`);
	if (!Number.isSafeInteger(request.invokeId) || (request.invokeId as number) <= 0) {
		throw new Error(`${label}.request.invokeId must be a positive safe integer`);
	}
	if (typeof request.id !== "string" || !request.id) throw new Error(`${label}.request.id is invalid`);
	if (typeof request.capability !== "string") throw new Error(`${label}.request.capability must be a string`);
	assertEvoCapability(request.capability, `${label}.request.capability`);
	if (!CAPABILITY_NAMES.has(request.capability)) throw new Error(`${label}.request.capability is unsupported`);
	return {
		eventId: record.eventId,
		authorityId: requireAuthorityId(record.authorityId, `${label}.authorityId`),
		sessionId: record.sessionId,
		ownerPid: positiveInteger(record.ownerPid, `${label}.ownerPid`),
		startedAt: record.startedAt,
		component: {
			id: component.id,
			abi: component.abi,
			artifactDigest: component.artifactDigest,
		},
		request: {
			invokeId: request.invokeId as number,
			id: request.id,
			capability: request.capability as EvoCapabilityName,
		},
	};
}

function parsePendingAudit(value: unknown, label: string): EvoPendingCapabilityAudit {
	const record = asRecord(value, label);
	rejectUnknownKeys(record, ["auditId", "event"], label);
	const auditId = requireAuthorityId(record.auditId, `${label}.auditId`);
	const event = asRecord(record.event, `${label}.event`);
	if (event.auditId !== auditId) throw new Error(`${label}.event.auditId does not match auditId`);
	canonicalJson(event);
	return { auditId, event };
}

export function parseEvoCapabilityState(value: unknown): EvoCapabilityState {
	const root = asRecord(value, "capability state");
	rejectUnknownKeys(
		root,
		["schemaVersion", "components", "reservations", "operations", "pendingAudit"],
		"capability state",
	);
	if (root.schemaVersion !== 1) throw new Error("capability state.schemaVersion must be 1");
	if (!Array.isArray(root.components)) throw new Error("capability state.components must be an array");
	if (!Array.isArray(root.reservations)) throw new Error("capability state.reservations must be an array");
	if (root.operations !== undefined && !Array.isArray(root.operations)) {
		throw new Error("capability state.operations must be an array");
	}
	if (root.pendingAudit !== undefined && !Array.isArray(root.pendingAudit)) {
		throw new Error("capability state.pendingAudit must be an array");
	}
	const components = root.components.map((value, index) => {
		const label = `capability state.components[${index}]`;
		const record = asRecord(value, label);
		rejectUnknownKeys(record, ["authorityId", "id", "artifactDigest", "grants", "usage"], label);
		const authorityId = requireAuthorityId(record.authorityId, `${label}.authorityId`);
		if (typeof record.id !== "string") throw new Error(`${label}.id must be a string`);
		assertEvoComponentId(record.id, `${label}.id`);
		if (typeof record.artifactDigest !== "string" || !isDigest(record.artifactDigest)) {
			throw new Error(`${label}.artifactDigest must be a digest`);
		}
		if (!Array.isArray(record.grants)) throw new Error(`${label}.grants must be an array`);
		if (!Array.isArray(record.usage)) throw new Error(`${label}.usage must be an array`);
		const grants = parseEvoCapabilityGrants(record.grants, `${label}.grants`);
		if (authorityId !== deriveEvoCapabilityAuthorityId(record.artifactDigest, grants)) {
			throw new Error(`${label}.authorityId does not match its exact artifact and grants`);
		}
		const usage = record.usage.map((entry, usageIndex) => parseUsage(entry, `${label}.usage[${usageIndex}]`));
		for (const [entries, entryLabel] of [
			[grants, "grants"],
			[usage, "usage"],
		] as const) {
			if (new Set(entries.map((entry) => entry.capability)).size !== entries.length) {
				throw new Error(`${label}.${entryLabel} must not contain duplicate capabilities`);
			}
		}
		return {
			authorityId,
			id: record.id,
			artifactDigest: record.artifactDigest,
			grants: grants.sort((left, right) => left.capability.localeCompare(right.capability)),
			usage: usage.sort((left, right) => left.capability.localeCompare(right.capability)),
		};
	});
	if (new Set(components.map((entry) => entry.authorityId)).size !== components.length) {
		throw new Error("capability state.components must not contain duplicate authority ids");
	}
	const reservations = root.reservations.map((value, index) =>
		parseReservation(value, `capability state.reservations[${index}]`),
	);
	if (new Set(reservations.map((entry) => entry.eventId)).size !== reservations.length) {
		throw new Error("capability state.reservations must not contain duplicate event ids");
	}
	const operations = (root.operations ?? []).map((value, index) =>
		parseOperation(value, `capability state.operations[${index}]`),
	);
	if (new Set(operations.map((entry) => entry.eventId)).size !== operations.length) {
		throw new Error("capability state.operations must not contain duplicate event ids");
	}
	const pendingAudit = (root.pendingAudit ?? []).map((value, index) =>
		parsePendingAudit(value, `capability state.pendingAudit[${index}]`),
	);
	if (new Set(pendingAudit.map((entry) => entry.auditId)).size !== pendingAudit.length) {
		throw new Error("capability state.pendingAudit must not contain duplicate audit ids");
	}
	for (const [index, reservation] of reservations.entries()) {
		const authority = components.find((entry) => entry.authorityId === reservation.authorityId);
		if (
			!authority ||
			authority.artifactDigest !== reservation.artifactDigest ||
			!authority.grants.some((grant) => grant.capability === reservation.capability)
		) {
			throw new Error(`capability state.reservations[${index}] does not match a granted authority`);
		}
	}
	for (const [index, operation] of operations.entries()) {
		const authority = components.find((entry) => entry.authorityId === operation.authorityId);
		if (
			!authority ||
			authority.id !== operation.component.id ||
			authority.artifactDigest !== operation.component.artifactDigest ||
			!authority.grants.some((grant) => grant.capability === operation.request.capability)
		) {
			throw new Error(`capability state.operations[${index}] does not match a granted authority`);
		}
	}
	return {
		schemaVersion: 1,
		components: components.sort((left, right) => left.authorityId.localeCompare(right.authorityId)),
		reservations: reservations.sort((left, right) => left.eventId.localeCompare(right.eventId)),
		operations: operations.sort((left, right) => left.eventId.localeCompare(right.eventId)),
		pendingAudit: pendingAudit.sort((left, right) => left.auditId.localeCompare(right.auditId)),
	};
}

function emptyState(): EvoCapabilityState {
	return { schemaVersion: 1, components: [], reservations: [], operations: [], pendingAudit: [] };
}

function emptyUsage(capability: EvoCapabilityName): EvoCapabilityUsage {
	return { capability, calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };
}

function validateResourceUsage(value: EvoCapabilityResourceUsage, label: string): EvoCapabilityResourceUsage {
	return {
		inputTokens: nonNegativeInteger(value.inputTokens, `${label}.inputTokens`),
		outputTokens: nonNegativeInteger(value.outputTokens, `${label}.outputTokens`),
		totalTokens: nonNegativeInteger(value.totalTokens, `${label}.totalTokens`),
		costUsd: nonNegativeNumber(value.costUsd, `${label}.costUsd`),
	};
}

function addUsage(left: EvoCapabilityResourceUsage, right: EvoCapabilityResourceUsage): EvoCapabilityResourceUsage {
	return {
		inputTokens: left.inputTokens + right.inputTokens,
		outputTokens: left.outputTokens + right.outputTokens,
		totalTokens: left.totalTokens + right.totalTokens,
		costUsd: left.costUsd + right.costUsd,
	};
}

function isWithinReservation(usage: EvoCapabilityResourceUsage, reservation: EvoCapabilityResourceUsage): boolean {
	return (
		usage.inputTokens <= reservation.inputTokens &&
		usage.outputTokens <= reservation.outputTokens &&
		usage.totalTokens <= reservation.totalTokens &&
		usage.costUsd <= reservation.costUsd
	);
}

function publicError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.slice(0, 1_024) || "Capability service failed";
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errorCode(error) !== "ESRCH";
	}
}

export class EvoCapabilityBroker {
	private readonly paths: EvoPaths;
	private readonly services: Partial<Record<EvoCapabilityName, EvoCapabilityService>>;
	private readonly now: () => string;
	private readonly randomId: () => string;
	private readonly statePath: string;
	private readonly auditPath: string;
	private readonly maxAuditResultBytes: number;
	private readonly sessionId: string;
	private readonly ownerPid: number;
	private readonly faultInjector: ((point: EvoCapabilityBrokerFaultPoint) => void | Promise<void>) | undefined;

	constructor(options: EvoCapabilityBrokerOptions) {
		this.paths = options.paths;
		this.services = { ...options.services };
		this.now = options.now ?? (() => new Date().toISOString());
		this.randomId = options.randomId ?? randomUUID;
		this.statePath = join(options.paths.registry, "capability-grants.json");
		this.auditPath = join(options.paths.log, "capability-audit.jsonl");
		this.maxAuditResultBytes =
			options.maxAuditResultBytes === undefined
				? DEFAULT_MAX_AUDIT_RESULT_BYTES
				: positiveInteger(options.maxAuditResultBytes, "maxAuditResultBytes");
		this.sessionId = options.sessionId ?? PROCESS_CAPABILITY_SESSION_ID;
		if (!this.sessionId || this.sessionId.length > 300) throw new Error("capability broker sessionId is invalid");
		this.ownerPid = options.ownerPid ?? process.pid;
		positiveInteger(this.ownerPid, "capability broker ownerPid");
		this.faultInjector = options.faultInjector;
	}

	async replaceComponentGrants(
		component: EvoCapabilityComponentIdentity,
		grants: readonly EvoCapabilityGrant[],
	): Promise<string> {
		const parsed = parseEvoCapabilityGrants(grants);
		for (const grant of parsed) {
			if (!component.declaredCapabilities.includes(grant.capability)) {
				throw new Error(`Cannot grant undeclared capability: ${grant.capability}`);
			}
			if (!component.abiCapabilityCeiling.includes(grant.capability)) {
				throw new Error(`Cannot grant capability above ABI ceiling: ${grant.capability}`);
			}
		}
		const authorityId = deriveEvoCapabilityAuthorityId(component.artifactDigest, parsed);
		return withFileLock(this.paths, "capability-broker", async () => {
			const state = await this.readRecoveredState();
			let entry = state.components.find((candidate) => candidate.authorityId === authorityId);
			if (
				entry &&
				(entry.id !== component.id ||
					entry.artifactDigest !== component.artifactDigest ||
					canonicalJson(entry.grants) !== canonicalJson(parsed))
			) {
				throw new Error("Capability authority identity mismatch");
			}
			if (!entry) {
				entry = {
					authorityId,
					id: component.id,
					artifactDigest: component.artifactDigest,
					grants: parsed,
					usage: [],
				};
				state.components.push(entry);
			}
			this.queueAudit(state, {
				schemaVersion: 1,
				type: "authority-registered",
				timestamp: this.now(),
				component: this.auditComponent(component, authorityId),
				grants: entry.grants,
			});
			await this.persistStateAndAudit(state);
			return authorityId;
		});
	}

	async getState(): Promise<EvoCapabilityState> {
		return withFileLock(this.paths, "capability-broker", async () => this.readRecoveredState());
	}

	async request(
		authorityId: string,
		component: EvoCapabilityComponentIdentity,
		frame: EvoCapabilityRequestFrame,
		signal: AbortSignal,
	): Promise<unknown> {
		requireAuthorityId(authorityId, "capability authority id");
		const eventId = this.randomId();
		const context: EvoCapabilityServiceContext = { component, capability: frame.capability, signal };
		if (signal.aborted) {
			return this.deny(authorityId, component, frame, eventId, "aborted", "Capability request was already aborted");
		}
		if (!component.declaredCapabilities.includes(frame.capability)) {
			return this.deny(
				authorityId,
				component,
				frame,
				eventId,
				"undeclared",
				"Component did not declare this capability",
			);
		}
		if (!component.abiCapabilityCeiling.includes(frame.capability)) {
			return this.deny(
				authorityId,
				component,
				frame,
				eventId,
				"ceiling",
				"Capability exceeds the component ABI ceiling",
			);
		}
		const service = this.services[frame.capability];
		if (!service) {
			return this.deny(authorityId, component, frame, eventId, "unavailable", "Capability service is unavailable");
		}

		let prepared: EvoPreparedCapabilityRequest;
		try {
			prepared = service.prepare(frame.payload, context);
			canonicalJson(prepared.request);
			if (prepared.reservation) {
				prepared = {
					...prepared,
					reservation: validateResourceUsage(prepared.reservation, "capability reservation"),
				};
			}
		} catch (error) {
			return this.deny(authorityId, component, frame, eventId, "invalid_request", publicError(error));
		}

		if (signal.aborted) {
			return this.deny(authorityId, component, frame, eventId, "aborted", "Capability request was aborted");
		}
		ACTIVE_CAPABILITY_EVENTS.add(eventId);
		try {
			await this.authorizeAndReserve(authorityId, component, frame, eventId, prepared);
			if (signal.aborted) {
				const message = "Capability request was aborted before execution";
				await this.finalize(authorityId, component, frame, eventId, undefined, undefined, {
					code: "aborted",
					message,
				});
				throw new EvoCapabilityDeniedError("aborted", message);
			}
			let execution: EvoCapabilityExecutionResult | undefined;
			let resourceUsage: EvoCapabilityResourceUsage | undefined;
			try {
				execution = await service.execute(prepared.request, context);
				canonicalJson(execution.result);
				if (execution.usage) resourceUsage = validateResourceUsage(execution.usage, "capability usage");
				if (isBudgetedCapability(frame.capability)) {
					if (!resourceUsage) throw new Error("Budgeted capability service did not return resource usage");
					if (!prepared.reservation || !isWithinReservation(resourceUsage, prepared.reservation)) {
						throw new Error("Budgeted capability usage exceeded its reservation");
					}
				}
			} catch (error) {
				const message = publicError(error);
				const code = signal.aborted ? "aborted" : "service_error";
				await this.finalize(authorityId, component, frame, eventId, undefined, resourceUsage, { code, message });
				throw new EvoCapabilityDeniedError(code, message, { cause: error });
			}
			await this.finalize(authorityId, component, frame, eventId, execution.result, resourceUsage);
			return execution.result;
		} finally {
			ACTIVE_CAPABILITY_EVENTS.delete(eventId);
		}
	}

	private async readState(): Promise<EvoCapabilityState> {
		const value = await readJsonIfExists<unknown>(this.statePath);
		return value === undefined ? emptyState() : parseEvoCapabilityState(value);
	}

	private async writeState(state: EvoCapabilityState): Promise<void> {
		state.components.sort((left, right) => left.authorityId.localeCompare(right.authorityId));
		state.reservations.sort((left, right) => left.eventId.localeCompare(right.eventId));
		state.operations.sort((left, right) => left.eventId.localeCompare(right.eventId));
		state.pendingAudit.sort((left, right) => left.auditId.localeCompare(right.auditId));
		await atomicWriteJson(this.statePath, state);
	}

	private async injectFault(point: EvoCapabilityBrokerFaultPoint): Promise<void> {
		await this.faultInjector?.(point);
	}

	private queueAudit(state: EvoCapabilityState, event: Record<string, unknown>): void {
		const auditId = sha256(`${this.sessionId}\0${randomUUID()}`);
		const audited = { ...event, auditId };
		canonicalJson(audited);
		state.pendingAudit.push({ auditId, event: audited });
	}

	private async repairAuditTail(): Promise<void> {
		let handle: Awaited<ReturnType<typeof open>>;
		try {
			handle = await open(this.auditPath, "r+");
		} catch (error) {
			if (errorCode(error) === "ENOENT") return;
			throw error;
		}
		try {
			const size = (await handle.stat()).size;
			if (size === 0) return;
			const last = Buffer.allocUnsafe(1);
			const finalRead = await handle.read(last, 0, 1, size - 1);
			if (finalRead.bytesRead === 1 && last[0] === 0x0a) return;
			const chunk = Buffer.allocUnsafe(64 * 1024);
			let position = size;
			let repairedSize = 0;
			while (position > 0) {
				const length = Math.min(position, chunk.byteLength);
				position -= length;
				const read = await handle.read(chunk, 0, length, position);
				const newline = chunk.subarray(0, read.bytesRead).lastIndexOf(0x0a);
				if (newline >= 0) {
					repairedSize = position + newline + 1;
					break;
				}
			}
			await handle.truncate(repairedSize);
			await handle.sync();
		} finally {
			await handle.close();
		}
	}

	private async existingAuditIds(pending: ReadonlySet<string>): Promise<Set<string>> {
		const existing = new Set<string>();
		if (pending.size === 0) return existing;
		await this.repairAuditTail();
		const input = createReadStream(this.auditPath, { encoding: "utf8" });
		const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
		try {
			for await (const line of lines) {
				if (!line) continue;
				let value: unknown;
				try {
					value = JSON.parse(line) as unknown;
				} catch (error) {
					throw new Error("Capability audit log contains invalid JSON", { cause: error });
				}
				const record = asRecord(value, "capability audit event");
				if (typeof record.auditId === "string" && pending.has(record.auditId)) existing.add(record.auditId);
				if (existing.size === pending.size) break;
			}
		} catch (error) {
			if (errorCode(error) !== "ENOENT") throw error;
		} finally {
			lines.close();
			input.destroy();
		}
		return existing;
	}

	private async flushPendingAudit(state: EvoCapabilityState, checkExisting: boolean): Promise<void> {
		if (state.pendingAudit.length === 0) return;
		const pendingIds = new Set(state.pendingAudit.map((entry) => entry.auditId));
		const existing = checkExisting ? await this.existingAuditIds(pendingIds) : new Set<string>();
		for (const pending of state.pendingAudit) {
			if (existing.has(pending.auditId)) continue;
			await appendJsonLine(this.auditPath, pending.event);
			await this.injectFault("after-audit-append");
		}
		state.pendingAudit = [];
		await this.writeState(state);
	}

	private async persistStateAndAudit(state: EvoCapabilityState): Promise<void> {
		await this.writeState(state);
		await this.injectFault("after-state-write");
		await this.flushPendingAudit(state, false);
	}

	private chargeReservation(
		state: EvoCapabilityState,
		reservation: EvoCapabilityReservation,
	): EvoCapabilityResourceUsage {
		const entry = state.components.find((candidate) => candidate.authorityId === reservation.authorityId);
		if (!entry || entry.artifactDigest !== reservation.artifactDigest) {
			throw new Error("Recovered capability reservation has no matching authority");
		}
		let usage = entry.usage.find((candidate) => candidate.capability === reservation.capability);
		if (!usage) {
			usage = emptyUsage(reservation.capability);
			entry.usage.push(usage);
		}
		usage.inputTokens += reservation.inputTokens;
		usage.outputTokens += reservation.outputTokens;
		usage.totalTokens += reservation.totalTokens;
		usage.costUsd += reservation.costUsd;
		entry.usage.sort((left, right) => left.capability.localeCompare(right.capability));
		return validateResourceUsage(reservation, "recovered capability reservation");
	}

	private operationIsLive(operation: EvoCapabilityOperation): boolean {
		if (operation.ownerPid === process.pid) return ACTIVE_CAPABILITY_EVENTS.has(operation.eventId);
		return processIsAlive(operation.ownerPid);
	}

	private async readRecoveredState(): Promise<EvoCapabilityState> {
		const state = await this.readState();
		if (state.pendingAudit.length > 0) await this.flushPendingAudit(state, true);
		const orphaned = state.operations.filter((operation) => !this.operationIsLive(operation));
		const orphanedIds = new Set(orphaned.map((operation) => operation.eventId));
		let changed = orphaned.length > 0;
		for (const operation of orphaned) {
			const reservationIndex = state.reservations.findIndex(
				(candidate) => candidate.eventId === operation.eventId && candidate.authorityId === operation.authorityId,
			);
			const reservation = reservationIndex < 0 ? undefined : state.reservations[reservationIndex];
			const usage = reservation ? this.chargeReservation(state, reservation) : undefined;
			if (reservationIndex >= 0) state.reservations.splice(reservationIndex, 1);
			this.queueAudit(state, {
				schemaVersion: 1,
				type: "capability-result",
				eventId: operation.eventId,
				timestamp: this.now(),
				component: { authorityId: operation.authorityId, ...operation.component },
				request: operation.request,
				ok: false,
				recovered: true,
				error: { code: "host_recovered", message: "Capability host stopped before finalization" },
				...(usage === undefined ? {} : { usage }),
			});
		}
		state.operations = state.operations.filter((operation) => !orphanedIds.has(operation.eventId));

		for (const reservation of [...state.reservations]) {
			if (state.operations.some((operation) => operation.eventId === reservation.eventId)) continue;
			changed = true;
			const usage = this.chargeReservation(state, reservation);
			const entry = state.components.find((candidate) => candidate.authorityId === reservation.authorityId);
			if (!entry) throw new Error("Recovered capability reservation has no authority");
			this.queueAudit(state, {
				schemaVersion: 1,
				type: "capability-result",
				eventId: reservation.eventId,
				timestamp: this.now(),
				component: {
					authorityId: reservation.authorityId,
					id: entry.id,
					artifactDigest: entry.artifactDigest,
				},
				request: { invokeId: 0, id: reservation.eventId, capability: reservation.capability },
				ok: false,
				recovered: true,
				error: { code: "host_recovered", message: "Legacy capability reservation was not finalized" },
				usage,
			});
		}
		if (changed) {
			state.reservations = state.reservations.filter((reservation) =>
				state.operations.some((operation) => operation.eventId === reservation.eventId),
			);
			await this.persistStateAndAudit(state);
		}
		return state;
	}

	private boundedAuditResult(result: unknown): unknown {
		const json = canonicalJson(result);
		const bytes = Buffer.byteLength(json, "utf8");
		if (bytes <= this.maxAuditResultBytes) return JSON.parse(json) as unknown;
		return { omitted: true, reason: "byte-limit", bytes, sha256: sha256(json) };
	}

	private auditComponent(component: EvoCapabilityComponentIdentity, authorityId: string) {
		return {
			authorityId,
			id: component.id,
			abi: component.abi,
			artifactDigest: component.artifactDigest,
		};
	}

	private async deny(
		authorityId: string,
		component: EvoCapabilityComponentIdentity,
		frame: EvoCapabilityRequestFrame,
		eventId: string,
		code: string,
		message: string,
	): Promise<never> {
		await withFileLock(this.paths, "capability-broker", async () => {
			const state = await this.readRecoveredState();
			this.queueAudit(state, {
				schemaVersion: 1,
				type: "capability-request",
				eventId,
				timestamp: this.now(),
				component: this.auditComponent(component, authorityId),
				request: frame,
				decision: "denied",
				error: { code, message },
			});
			await this.persistStateAndAudit(state);
		});
		throw new EvoCapabilityDeniedError(code, message);
	}

	private async authorizeAndReserve(
		authorityId: string,
		component: EvoCapabilityComponentIdentity,
		frame: EvoCapabilityRequestFrame,
		eventId: string,
		prepared: EvoPreparedCapabilityRequest,
	): Promise<void> {
		await withFileLock(this.paths, "capability-broker", async () => {
			const state = await this.readRecoveredState();
			const entry = state.components.find((candidate) => candidate.authorityId === authorityId);
			const grant = entry?.grants.find((candidate) => candidate.capability === frame.capability);
			const deny = async (code: string, message: string): Promise<never> => {
				this.queueAudit(state, {
					schemaVersion: 1,
					type: "capability-request",
					eventId,
					timestamp: this.now(),
					component: this.auditComponent(component, authorityId),
					request: frame,
					decision: "denied",
					error: { code, message },
				});
				await this.persistStateAndAudit(state);
				throw new EvoCapabilityDeniedError(code, message);
			};
			if (!entry || entry.id !== component.id || entry.artifactDigest !== component.artifactDigest || !grant) {
				return deny("not_granted", "Capability is off until explicitly granted for this artifact");
			}
			let usage = entry.usage.find((candidate) => candidate.capability === frame.capability);
			if (!usage) {
				usage = emptyUsage(frame.capability);
				entry.usage.push(usage);
			}
			if (usage.calls >= grant.maxCalls) return deny("call_budget", "Capability call budget is exhausted");

			if (isBudgetedCapability(frame.capability)) {
				if (!isBudgetedGrant(grant)) throw new Error("Capability grant type mismatch");
				const reservation = prepared.reservation;
				const model = prepared.authorization?.model;
				const maxOutputTokens = prepared.authorization?.maxOutputTokens;
				if (!reservation || !model || maxOutputTokens === undefined) {
					return deny("invalid_service", "Budgeted capability service did not provide authorization bounds");
				}
				if (!grant.models.includes(model)) return deny("model_restricted", "Requested model is not granted");
				if (maxOutputTokens > grant.maxOutputTokensPerCall) {
					return deny("output_budget", "Per-call output token budget is exceeded");
				}
				const requestedTools = prepared.authorization?.tools ?? [];
				if (requestedTools.some((tool) => !(grant.tools ?? []).includes(tool))) {
					return deny("tool_restricted", "Requested spawn-agent tool is not granted");
				}
				const outstanding = state.reservations
					.filter(
						(candidate) => candidate.authorityId === authorityId && candidate.capability === frame.capability,
					)
					.reduce<EvoCapabilityResourceUsage>((total, candidate) => addUsage(total, candidate), {
						inputTokens: 0,
						outputTokens: 0,
						totalTokens: 0,
						costUsd: 0,
					});
				const projected = addUsage(addUsage(usage, outstanding), reservation);
				if (projected.inputTokens > grant.maxInputTokens) {
					return deny("input_budget", "Capability input token budget is exhausted");
				}
				if (projected.outputTokens > grant.maxOutputTokens) {
					return deny("output_budget", "Capability output token budget is exhausted");
				}
				if (projected.totalTokens > grant.maxTotalTokens) {
					return deny("token_budget", "Capability total token budget is exhausted");
				}
				if (projected.costUsd > grant.maxCostUsd) {
					return deny("cost_budget", "Capability cost budget is exhausted");
				}
				state.reservations.push({
					eventId,
					authorityId,
					artifactDigest: component.artifactDigest,
					capability: frame.capability,
					...reservation,
				});
			}
			usage.calls += 1;
			state.operations.push({
				eventId,
				authorityId,
				sessionId: this.sessionId,
				ownerPid: this.ownerPid,
				startedAt: this.now(),
				component: { id: component.id, abi: component.abi, artifactDigest: component.artifactDigest },
				request: { invokeId: frame.invokeId, id: frame.id, capability: frame.capability },
			});
			entry.usage.sort((left, right) => left.capability.localeCompare(right.capability));
			this.queueAudit(state, {
				schemaVersion: 1,
				type: "capability-request",
				eventId,
				timestamp: this.now(),
				component: this.auditComponent(component, authorityId),
				request: frame,
				decision: "allowed",
				...(prepared.reservation === undefined ? {} : { reservation: prepared.reservation }),
			});
			await this.persistStateAndAudit(state);
		});
	}

	private async finalize(
		authorityId: string,
		component: EvoCapabilityComponentIdentity,
		frame: EvoCapabilityRequestFrame,
		eventId: string,
		result?: unknown,
		resourceUsage?: EvoCapabilityResourceUsage,
		failure?: { code: string; message: string },
	): Promise<void> {
		await withFileLock(this.paths, "capability-broker", async () => {
			const state = await this.readRecoveredState();
			const operationIndex = state.operations.findIndex(
				(candidate) => candidate.eventId === eventId && candidate.authorityId === authorityId,
			);
			if (operationIndex < 0) throw new Error("Capability operation disappeared before finalization");
			const reservationIndex = state.reservations.findIndex(
				(candidate) => candidate.eventId === eventId && candidate.authorityId === authorityId,
			);
			let chargedUsage = resourceUsage;
			if (isBudgetedCapability(frame.capability)) {
				if (reservationIndex < 0) throw new Error("Capability reservation disappeared before finalization");
				const reservation = state.reservations[reservationIndex];
				if (!reservation) throw new Error("Capability reservation disappeared before finalization");
				if (failure === undefined) {
					if (!chargedUsage) throw new Error("Successful budgeted capability result is missing usage");
					if (!isWithinReservation(chargedUsage, reservation)) {
						throw new Error("Successful budgeted capability usage exceeds its reservation");
					}
				} else if (!chargedUsage) {
					chargedUsage = reservation;
				}
				state.reservations.splice(reservationIndex, 1);
			}
			state.operations.splice(operationIndex, 1);
			if (chargedUsage) {
				const entry = state.components.find((candidate) => candidate.authorityId === authorityId);
				const usage = entry?.usage.find((candidate) => candidate.capability === frame.capability);
				if (!entry || entry.id !== component.id || entry.artifactDigest !== component.artifactDigest || !usage) {
					throw new Error("Capability usage disappeared before finalization");
				}
				const validated = validateResourceUsage(chargedUsage, "capability usage");
				usage.inputTokens += validated.inputTokens;
				usage.outputTokens += validated.outputTokens;
				usage.totalTokens += validated.totalTokens;
				usage.costUsd += validated.costUsd;
			}
			this.queueAudit(state, {
				schemaVersion: 1,
				type: "capability-result",
				eventId,
				timestamp: this.now(),
				component: this.auditComponent(component, authorityId),
				request: { invokeId: frame.invokeId, id: frame.id, capability: frame.capability },
				ok: failure === undefined,
				...(failure === undefined ? { result: this.boundedAuditResult(result) } : { error: failure }),
				...(chargedUsage === undefined ? {} : { usage: chargedUsage }),
			});
			await this.persistStateAndAudit(state);
		});
	}
}
