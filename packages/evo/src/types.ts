import type { EvoCapabilityGrant } from "./components/capabilities/broker.ts";

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
	/** @deprecated Evolution control-plane routing now belongs in evo/config.json. */
	reflector?: string;
	/** @deprecated Evaluation routing now belongs in evo/config.json. */
	critic?: string;
}

export type EvoComponentActivationBoundary = "turn" | "session" | "process" | "invocation";

export interface EvoComponentManifest {
	schemaVersion: 1;
	id: string;
	version: string;
	artifactDigest: string;
	entrypointSha256: string;
	abi: string;
	activationBoundary: EvoComponentActivationBoundary;
	capabilities: string[];
	entrypoint: string;
}

export interface EvoComponentSelection {
	id: string;
	abi: string;
	artifactDigest: string;
	config?: Record<string, unknown>;
	/** Explicit, artifact-bound broker grants approved with this selection. */
	grants?: EvoCapabilityGrant[];
}

export type EvoToolSelection = EvoComponentSelection;

export interface EvoWorkflowSelection extends EvoComponentSelection {
	trigger: string;
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
	/** Singleton surface id to a content-addressed implementation of a host-defined ABI. */
	components?: Record<string, EvoComponentSelection>;
	/** Independently registered tool/v1 implementations. */
	tools?: EvoToolSelection[];
	/** Trigger-bound workflow/v1 implementations. */
	workflows?: EvoWorkflowSelection[];
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

export type ProposalArtifactKind = "review" | "replay" | "validation" | "comparison" | "retrospective";

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
	comparison?: EvaluationArtifactRef;
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
	/** Existing host-defined ABI implemented by this candidate, when applicable. */
	targetAbi?: string;
	/** True only for infrastructure proposals that add a new host ABI. */
	requiresNewAbi?: boolean;
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
	evidenceDigest?: string;
	comparisonDigest?: string;
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

export type EvolutionRunActiveStatus =
	| "queued"
	| "researching"
	| "planned"
	| "building"
	| "validating"
	| "replaying"
	| "evaluating";
export type EvolutionRunStatus =
	| EvolutionRunActiveStatus
	| "awaiting-evidence"
	| "awaiting-canary-approval"
	| "trialing"
	| "awaiting-decision"
	| "paused"
	| "completed"
	| "failed"
	| "cancelled";

export type EvoCheckProfile =
	| "bundle-compile"
	| "repo-check"
	| "related-tests"
	| "paired-replay"
	| "session-comparison"
	| "compaction-replay";

export type EvoPatchClass = "pure-transform" | "component" | "routing" | "prompt" | "tool" | "infrastructure";

export interface EvoEvidenceStrategy {
	patchClass: EvoPatchClass;
	offline:
		| {
				mode: "required";
				profiles: Array<Extract<EvoCheckProfile, "bundle-compile" | "repo-check" | "related-tests">>;
		  }
		| { mode: "not-applicable"; reason: string };
	historicalReplay:
		| {
				mode: "required";
				profiles: Array<Extract<EvoCheckProfile, "paired-replay" | "session-comparison" | "compaction-replay">>;
				datasets: string[];
				minimumSamples: number;
		  }
		| { mode: "optional" | "not-applicable"; reason: string };
	online: { mode: "none" } | { mode: "shadow" | "canary"; minimumSamples: number; maximumDuration: string };
	rollout: "direct" | "shadow-first" | "canary-first";
}

export interface EvoExperimentSpec {
	baseline: string;
	hypothesis: string;
	checkProfiles: EvoCheckProfile[];
	evidenceStrategy: EvoEvidenceStrategy;
	metrics: string[];
	/** Pre-registered decision metric; required whenever the plan declares a trial. */
	primaryMetric?: string;
	minimumEffect: Record<string, number>;
	trialPlan: string;
	rollbackConditions: string[];
}

export interface EvolutionInboxDecision {
	file: string;
	kind: "preference" | "request" | "note" | "task-local";
	reason: string;
	/** Exact user-authored substring; required only for a durable preference. */
	instruction?: string;
}

export interface EvolutionResearchPlan {
	topic: string;
	reason: string;
	planMarkdown: string;
	experiment: EvoExperimentSpec;
	targetAbi?: string;
	requiresNewAbi: boolean;
	candidateKind: "none" | "data" | "component" | "code";
	builderInstructions: string;
	inboxDecisions: EvolutionInboxDecision[];
}

export interface EvolutionRun {
	schemaVersion: 1;
	id: string;
	trigger: "scheduled" | "request";
	request?: string;
	status: EvolutionRunStatus;
	startedAt: string;
	updatedAt: string;
	evidenceDigest: string;
	planFile?: string;
	experimentFile?: string;
	proposalId?: string;
	error?: string;
	workerPid?: number;
	workerStartedAt?: string;
	logFile?: string;
	pausedAt?: string;
	pausedFrom?: EvolutionRunActiveStatus;
	canaryApprovedAt?: string;
	canaryApprovalDigest?: string;
	canaryStableDigest?: string;
	canaryCandidateDigest?: string;
	canaryParentDigest?: string;
	canaryTargetAbi?: string;
	experimentDigest?: string;
	retryOfRunId?: string;
	sourceProposalId?: string;
}

export interface EvoRoleModelConfig {
	model: string;
	thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export interface EvoControlConfig {
	schemaVersion: 1;
	models: {
		researchPlanner: EvoRoleModelConfig;
		builder: EvoRoleModelConfig;
		evaluator: EvoRoleModelConfig;
		/** Minimum-cost model that pre-triages session digests into inbox hypotheses. */
		triage: EvoRoleModelConfig;
	};
	release: {
		autoApplyT0: boolean;
		autoStartDataTrial: boolean;
		autoStartComponentTrial: boolean;
		autoKeepSuccessfulTrial: boolean;
	};
	grants: {
		/**
		 * How pack capability grants are approved at import/install time.
		 * "auto" stages the derived grants without prompting (the preview is
		 * still shown); "prompt" requires interactive confirmation.
		 */
		approval: "auto" | "prompt";
	};
	triage: {
		/** Run the streaming session triage after this many new complete sessions. */
		everyNSessions: number;
	};
}
