export const BUNDLE_SCHEMA_VERSION = 1;
export const POLICY_SCHEMA_VERSION = 1;
export const PROPOSAL_SCHEMA_VERSION = 2;
export const RECORDER_SCHEMA_VERSION = 1;

export type ProposalKind = "data" | "code";
export type ProposalTier = "T0" | "T1" | "T2";
export type ProposalStatus = "pending" | "deferred" | "approved" | "rejected" | "trialing" | "kept" | "rolled-back";

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

export type DeterministicCheck = "bundle-compile";

export interface BundleValidationPolicy {
	requiredChecks?: DeterministicCheck[];
}

export type BundleManagedSourceKind =
	| "custom-prompt"
	| "append-prompt"
	| "context"
	| "prompt"
	| "skill"
	| "memory"
	| "preference";

export interface BundleManagedSource {
	kind: BundleManagedSourceKind;
	sourceRoot: string;
	relativePath: string;
	targetPath: string;
	sourceSha256: string;
}

export interface BundlePolicy {
	schemaVersion: 1;
	promptOrder?: string[];
	stablePromptPaths?: string[];
	dynamicPromptPaths?: string[];
	enabledTools?: string[];
	enabledFeatures?: string[];
	coreAssets?: string[];
	limits?: BundlePolicyLimits;
	modelRouting?: BundleModelRouting;
	validation?: BundleValidationPolicy;
	managedSources?: BundleManagedSource[];
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

export type ProposalArtifactKind = "review" | "replay" | "validation" | "retrospective";

export interface EvaluationEvidenceBinding {
	digest: string;
	cutoff: string;
}

export interface EvaluationArtifactRef {
	file: string;
	sha256: string;
	revision: number;
	diffDigest: string;
	createdAt: string;
	evidence?: EvaluationEvidenceBinding;
}

export interface ProposalArtifacts {
	review?: EvaluationArtifactRef;
	replay?: EvaluationArtifactRef;
	validation?: EvaluationArtifactRef;
	retrospective?: EvaluationArtifactRef;
}

export interface CodeWorkspace {
	repositoryRoot: string;
	repositoryId: string;
	worktreePath: string;
	branch: string;
	baseCommit: string;
	integrityDigest: string;
}

export interface ProposalDeferState {
	deferredAt: string;
	reason: string;
	until?: string;
}

export interface ProposalApproval {
	revision: number;
	diffDigest: string;
	approvalDigest?: string;
	artifactsDigest?: string;
}

export interface Proposal {
	schemaVersion: 2;
	id: string;
	createdAt: string;
	revision: number;
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
	diffDigest: string;
	approvalDigest: string;
	candidateDigest?: string;
	codePatch?: string;
	codeWorkspace?: CodeWorkspace;
	suggestedTier?: ProposalTier;
	defer?: ProposalDeferState;
	l1: ProposalL1Result;
	artifacts: ProposalArtifacts;
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
	| "proposal-deferred"
	| "proposal-reopened"
	| "trial-start"
	| "trial-keep"
	| "rollback"
	| "pause"
	| "resume";

export interface HistoryEntry {
	eventId?: string;
	timestamp: string;
	action: HistoryAction;
	actor: "human" | "system";
	fromDigest?: string;
	toDigest?: string;
	proposalId?: string;
	revision?: number;
	diffDigest?: string;
	approvalDigest?: string;
	candidateDigest?: string;
	branch?: string;
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
	deferredProposals: number;
	paused: boolean;
}
