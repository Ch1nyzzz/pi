# Evo-Pi evolution workflow

This file is trusted user configuration. The evolution engine uses a resumable evidence pipeline: research, freeze the experiment, build, deterministic validation, candidate-aware replay, evidence assessment, reversible trial, and only then deterministic release.

## Research and plan

Read the supplied real-session evidence, current bundle, proposal history, repository context, and available external research before selecting one improvement. A user REQUEST takes priority but does not require a candidate when evidence or a safe experiment is unavailable. Without a request, look for repeated failures, wasted turns, latency, token/cache waste, repeated tool work, missing verification, and important mechanisms that have not been examined recently.

Classify every active inbox item before selecting the improvement. A cross-task instruction about how the agent should work is a durable preference; a request to add behavior or UI is a feature request even when it contains words such as “every” or “always.” Notes and task-local constraints are not durable preferences. Preference extraction must quote an exact user-authored substring. Reviewing an unresolved preference or request does not close it.

Select at most one narrow improvement. Open durable preferences take priority as an append-only `memory/preferences.json` data candidate. Otherwise prefer an implementation of an existing host-defined ABI. If the required ABI does not exist, set `requiresNewAbi` and produce an infrastructure plan instead of pretending the component can be activated.

## Experiment

Freeze the baseline, hypothesis, approved check profiles, metrics, minimum meaningful effect, trial plan, rollback conditions, and a structured evidence strategy before implementation starts. The ResearchPlanner must classify the patch and decide separately whether offline checks, historical replay, shadow execution, and Canary evidence are required. Marking a stage not applicable requires a concrete causal reason; inability to test offline must lead to shadow or Canary rather than direct release. Required stages are deterministic release gates and cannot be satisfied by a different replay type. Do not emit arbitrary shell commands. Research is a source of hypotheses, not proof of local benefit.

## Implementation

Make the smallest change that tests the hypothesis. Data candidates may edit only the bundle data schema. Component candidates must implement the exact target ABI. Other code stays in an isolated worktree and cannot be activated automatically.

## Evaluation and trial

Use deterministic checks first, then bounded baseline/candidate replay and real shadow or canary evidence where the metric depends on providers, time, external systems, or live sessions. Do not interpret generate-only replay as end-to-end execution. A valid candidate missing required future evidence is `needs-evidence`, not unsupported. `unsupported` requires sufficient executed comparative evidence that misses frozen thresholds; `invalid` means the candidate or experiment is broken.

When local policy enables component Canary offers, replacing a selected component stops at `awaiting-canary-approval`; otherwise it remains in normal review. Never activate it from a model verdict or standing auto-start policy alone. Show the exact diff, independent evaluation, current and candidate digests, target ABI, reversible scope, and rollback policy before an explicit Enter action starts the Canary. Stable mutation and final keep remain deterministic registry transitions with stale-parent checks.
