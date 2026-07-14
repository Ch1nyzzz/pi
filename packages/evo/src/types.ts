export const BUNDLE_SCHEMA_VERSION = 1;
export const POLICY_SCHEMA_VERSION = 1;
export const PROPOSAL_SCHEMA_VERSION = 1;
export const RECORDER_SCHEMA_VERSION = 1;

export type ProposalKind = "data" | "code";
export type ProposalTier = "T0" | "T1" | "T2";
export type ProposalStatus = "pending" | "approved" | "rejected" | "trialing" | "kept" | "rolled-back";

export interface BundleFileEntry {
	path: string;
	sha256: string;
	bytes: number;
}

export interface BundleManifest {
	schemaVersion: 1;
	parentDigest: string | null;
	summary: string;
	files: BundleFileEntry[];
}

export interface BundlePolicyLimits {
	promptBytes?: number;
	skillBytes?: number;
	totalBytes?: number;
}

export interface BundleModelRouting {
	worker?: string;
	reflector?: string;
	critic?: string;
}

export type DeterministicCheck = "bundle-compile" | "lint" | "typecheck" | "unit-tests";

export interface BundleValidationPolicy {
	requiredChecks?: DeterministicCheck[];
}

export interface BundlePolicy {
	schemaVersion: 1;
	promptOrder?: string[];
	stablePromptPaths?: string[];
	dynamicPromptPaths?: string[];
	enabledTools?: string[];
	coreAssets?: string[];
	limits?: BundlePolicyLimits;
	modelRouting?: BundleModelRouting;
	validation?: BundleValidationPolicy;
}

export interface CompiledBundle {
	digest: string;
	directory: string;
	manifest: BundleManifest;
	policy: BundlePolicy;
}

export interface EvidenceReference {
	sessionId: string;
	sequence: number;
	quote?: string;
}

export interface ReplayScenario {
	sessionId: string;
	sequence: number;
}

export interface ProposalL1Result {
	passed: boolean;
	reason: string;
	errors: string[];
}

export interface Proposal {
	schemaVersion: 1;
	id: string;
	createdAt: string;
	parentBundleDigest: string;
	kind: ProposalKind;
	tier: ProposalTier;
	motivation: string;
	diff: string;
	expectedEffect: string;
	risk: string;
	verifyPlan: string;
	trialPlan: string;
	status: ProposalStatus;
	source: "pattern" | "explicit-request";
	evidence: EvidenceReference[];
	inboxReferences: string[];
	replayScenarios: ReplayScenario[];
	changedPaths: string[];
	approvalDigest: string;
	candidateDigest?: string;
	codePatch?: string;
	l1: ProposalL1Result;
	reviewFile?: string;
	replayFile?: string;
	retrospectiveFile?: string;
}

export interface TrialState {
	digest: string;
	parent: string;
	proposalId: string;
	startedAt: string;
	plan: string;
}

export type HistoryAction =
	| "initialize"
	| "proposal-approved"
	| "proposal-rejected"
	| "trial-start"
	| "trial-keep"
	| "rollback"
	| "pause"
	| "resume";

export interface HistoryEntry {
	timestamp: string;
	action: HistoryAction;
	actor: "human" | "system";
	fromDigest?: string;
	toDigest?: string;
	proposalId?: string;
	reason: string;
}

export interface ArtifactReference {
	sha256: string;
	bytes: number;
	mediaType: "application/json" | "text/plain";
}

export interface StoredPayload {
	preview: string;
	artifact?: ArtifactReference;
	value?: unknown;
}

export interface UsageSummary {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
}

export interface EvoStatus {
	initialized: boolean;
	stableDigest?: string;
	trial?: TrialState;
	pendingProposals: number;
	paused: boolean;
}
