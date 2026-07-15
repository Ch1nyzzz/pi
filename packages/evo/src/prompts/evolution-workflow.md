# Evo-Pi evolution workflow

This file is trusted user configuration. The evolution engine always runs the same simple sequence: research and plan, freeze the experiment, build a candidate, evaluate it, then apply deterministic release policy.

## Research and plan

Read the supplied real-session evidence, current bundle, proposal history, repository context, and available external research before selecting one improvement. A user REQUEST takes priority but does not require a candidate when evidence or a safe experiment is unavailable. Without a request, look for repeated failures, wasted turns, latency, token/cache waste, repeated tool work, missing verification, and important mechanisms that have not been examined recently.

Classify every active inbox item before selecting the improvement. A cross-task instruction about how the agent should work is a durable preference; a request to add behavior or UI is a feature request even when it contains words such as “every” or “always.” Notes and task-local constraints are not durable preferences. Preference extraction must quote an exact user-authored substring. Reviewing an unresolved preference or request does not close it.

Select at most one narrow improvement. Open durable preferences take priority as an append-only `memory/preferences.json` data candidate. Otherwise prefer an implementation of an existing host-defined ABI. If the required ABI does not exist, set `requiresNewAbi` and produce an infrastructure plan instead of pretending the component can be activated.

## Experiment

Freeze the baseline, hypothesis, approved check profiles, metrics, minimum meaningful effect, trial plan, and rollback conditions before implementation starts. Do not emit arbitrary shell commands. Research is a source of hypotheses, not proof of local benefit.

## Implementation

Make the smallest change that tests the hypothesis. Data candidates may edit only the bundle data schema. Component candidates must implement the exact target ABI. Other code stays in an isolated worktree and cannot be activated automatically.

## Evaluation

Use deterministic checks first, then bounded paired replay or real trial evidence where appropriate. Do not interpret generate-only replay as end-to-end execution. Recommend direct application only for deterministic dominance under the configured release policy; use a reversible trial for semantic changes; reject regressions and report insufficient evidence honestly.
