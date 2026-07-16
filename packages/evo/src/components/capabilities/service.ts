import type { EvoCapabilityName } from "./protocol.ts";

export interface EvoCapabilityComponentIdentity {
	id: string;
	abi: string;
	artifactDigest: string;
	declaredCapabilities: readonly string[];
	abiCapabilityCeiling: readonly string[];
}

export interface EvoCapabilityResourceUsage {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	costUsd: number;
}

export interface EvoCapabilityAuthorizationHints {
	model?: string;
	maxOutputTokens?: number;
	tools?: string[];
}

export interface EvoPreparedCapabilityRequest {
	request: unknown;
	/** Conservative upper bound reserved before an external side effect starts. */
	reservation?: EvoCapabilityResourceUsage;
	authorization?: EvoCapabilityAuthorizationHints;
}

export interface EvoCapabilityExecutionResult {
	result: unknown;
	usage?: EvoCapabilityResourceUsage;
}

export interface EvoCapabilityServiceContext {
	component: EvoCapabilityComponentIdentity;
	capability: EvoCapabilityName;
	signal: AbortSignal;
}

/**
 * A trusted host adapter. It validates untrusted component payloads in prepare()
 * and performs the side effect in execute(). Components never receive this object.
 */
export interface EvoCapabilityService {
	prepare(payload: unknown, context: EvoCapabilityServiceContext): EvoPreparedCapabilityRequest;
	execute(request: unknown, context: EvoCapabilityServiceContext): Promise<EvoCapabilityExecutionResult>;
}
