# Changelog

## [Unreleased]

### Added

- Added the workflow SDK: `composeWorkflowEntrypoint()` composes a dependency-free prelude into a workflow component entrypoint, giving authors `runWorkflow()`, `agent()` (with JSON-schema structured output and retry), barrier `parallel()`, streaming `pipeline()`, and `log()` over the JSONL-RPC protocol.
- Added workflow host defaults: `workflow/v1` invokes now carry an optional `host` record (default model, granted tools, per-call output ceiling) derived from the spawn-agent grant, and workflow invokes get a dedicated 60-minute request timeout.
- Added the bundled `/deep-review` workflow template and `writeDeepReviewPack()`: per-file reviewers plus adversarial verification, shipped as an importable integrity-signed pack.
- Added a workflow dry-run validator: workflow/v1 candidates are launched against a stub capability broker and must speak the protocol cleanly end to end before release; a structured orchestration error passes, a protocol violation fails.
- Added streaming session triage: every N completed sessions (config `triage.everyNSessions`, default 5) a minimum-cost model (`models.triage`, default `gpt-5.6-luna`) scans new session digests and files pre-classified improvement hypotheses into the inbox from the auto-improve tick.
- Added dual-channel research: request-triggered runs plan exclusively for the requested direction, while scheduled runs consume the pre-triaged inbox hypotheses before fresh mining.
- Added guardrail metrics: every pre-registered metric in a frozen experiment's `minimumEffect` now acts as a machine rollback trigger and auto-keep blocker, so a proposal cannot improve its primary metric while regressing another pre-registered one.
- Added `grants.approval` config (default `auto`): pack import/install stages the derived capability grants without an interactive confirmation; set `prompt` to restore the confirmation gate.

### Changed

- Changed Evo activity into a dedicated final status line that names active Canary components, stays separate from provider quota status, and can be entered with Down from the end of a draft to open runs, trials, and proposals.
- Raised default pack capability budgets (spawn-agent: 100 calls, 64-turn children, sized for parallel large-context reservations) and expanded the `workflow/v1` capability ceiling with `memory-read`/`memory-write` for persistent workflow state.
- Spawned child agents now default to the host's real coding tools (`bash`, `edit`, `find`, `grep`, `ls`, `read`, `write`) and grant previews default their allowlist to the same set.

## [0.80.9] - 2026-07-16

### Added

- Added the initial Evo-Pi package, Pi extension entry point, and command-line entry point.
- Added grounded T0/T1/T2 proposal lifecycles with exact revision and evaluation-artifact approval binding, Critic/replay artifacts, follow-up questions, constrained revisions, defer/reopen decisions, trials, keep, rollback, and append-only audit history.
- Added incremental evidence review cursors, independent source quotas, grounded zero-proposal observations, and a per-phase model token/cost journal with rolling seven-day report summaries.
- Added isolated Git branch/worktree staging for code proposals with fixed sandboxed L1 validation, integrity-bound human approval, and manual-integration handoff without automatic commits, merges, or dependency installation.
- Added evidence-bound immutable retrospective snapshots; keeping a data trial rechecks the current full evidence digest and rejects stale snapshots.
- Added one-shot guarded scheduled reflection with quiet-hours, inactivity, daily-limit, pause cancellation, an atomic heartbeating owner lease, and torn-tail run-journal recovery.
- Added a persisted, user-selectable reflection cadence (`registry/schedule.json`, `/evo schedule daily|3d|weekly|every <n>d|manual`) enforced through an `interval-not-elapsed` guard on top of the existing scheduled-reflection gates.
- Added zero-maintenance in-session background reflection: the Pi extension periodically makes one guarded scheduled-improve attempt at the configured cadence (excluding the running session's own activity), then surfaces staged proposals through a notification and the status bar. Disable per install with `/evo schedule manual` or per embed with `createEvoExtension({ autoImprove: false })`.
- Added a trial-due status-bar reminder once the active trial exceeds the configured `trialDueAfterDays` (default 7), pointing at `/evo keep` or `/evo rollback`.
- Added session-pinned bundle feature/tool policy and worker model routing with fail-closed tool blocking plus original model/tool restoration.
- Added crash-recoverable registry transitions, state-bound durable service intents, append-only operation receipts, idempotent response-loss recovery, and fail-closed before/after image validation.
- Added interactive-terminal and live-confirmation guards for local state-changing commands.
- Added first-initialization migration of conventional Pi system prompts, global AGENTS/CLAUDE context, and data-only skills, plus explicit prompt, skill, memory, and preference source directories, content-bound managed-source metadata, fail-closed source-drift detection, duplicate-injection replacement, and bundle takeover after legacy source deletion.
- Added idle-TUI `Ctrl+Alt+E` quick approval for the first pending T0 proposal and restricted rollback targets to bundles previously committed as stable ancestors of the current bundle.
- Added required generate-only `code-patch-hypothesis` replay for T2 code proposals, explicitly separating model-predicted first actions from executed candidate behavior.
- Added restricted `codeFeatures` registration with session-pinned hook and tool wrappers, dormant-tool filtering, rollback-aware activation for new sessions, and documented raw `ExtensionAPI` bypass boundaries.
- Added T2 classification for `managedSources`, `enabledTools`, and `enabledFeatures` changes that alter the runtime trust or capability boundary.
- Added managed-source-aware T2 data replay reconstruction from recorded system-prompt options, preserving extension wrappers while replacing evolved resources exactly once.
- Added explicit validation, replay, evaluation, evidence-waiting, Canary, and final-decision run states with a live Evo status indicator and proposal-lifecycle reconciliation.
- Added executable component validation, canonical frozen-experiment digests, and `/evo retry <run-id>` for resuming an unchanged content-addressed component at validation without rewriting the original audit record.
- Added a focused component Canary approval view that binds Enter approval to the exact proposal, diff, evaluation artifacts, current/candidate bundle digests, ABI, and rollback plan.
- Added one-time, non-persisted direct component execution permission when the OS sandbox is unavailable; non-interactive activation remains fail-closed.
- Added strict optimization-pack v1 import/export for prompts, skills, structured memory, components, tools, and workflows, with content integrity, exact capability-grant preflight, reversible staging, and T2 Builder routing for unregistered ABIs ([#11](https://github.com/Ch1nyzzz/pi/issues/11), [#12](https://github.com/Ch1nyzzz/pi/issues/12), [#13](https://github.com/Ch1nyzzz/pi/issues/13)).
- Added the eight standard host ABIs and runtime wiring for instructions, context transform/checkpoint, guards, generation replacement/redo, control, tools, memory, and workflows while retaining legacy compaction compatibility ([#14](https://github.com/Ch1nyzzz/pi/issues/14), [#15](https://github.com/Ch1nyzzz/pi/issues/15), [#16](https://github.com/Ch1nyzzz/pi/issues/16), [#17](https://github.com/Ch1nyzzz/pi/issues/17), [#18](https://github.com/Ch1nyzzz/pi/issues/18), [#19](https://github.com/Ch1nyzzz/pi/issues/19)).
- Added bidirectional component capability RPC with persistent exact grants, reservations, call/model/token/cost/tool budgets, crash-recoverable append-only audit, conservative orphan reconciliation, derived filesystem/exec/HTTP/retrieval/memory services, host-mediated inference, and bounded isolated subagents ([#20](https://github.com/Ch1nyzzz/pi/issues/20), [#21](https://github.com/Ch1nyzzz/pi/issues/21), [#22](https://github.com/Ch1nyzzz/pi/issues/22)).
- Added a namespace-isolated component memory store whose trial creation, idempotent promotion, lineage-aware rollback, ancestor restoration, removal, and legacy recovery follow bundle lifecycle under a shared lock, with a durable pointer/audit outbox and no-follow storage access ([#23](https://github.com/Ch1nyzzz/pi/issues/23), [#24](https://github.com/Ch1nyzzz/pi/issues/24), [#25](https://github.com/Ch1nyzzz/pi/issues/25), [#26](https://github.com/Ch1nyzzz/pi/issues/26), [#27](https://github.com/Ch1nyzzz/pi/issues/27), [#28](https://github.com/Ch1nyzzz/pi/issues/28)).
- Added signed optimization-pack discovery with strict registry configuration, trusted signer verification, bounded HTTPS/git/gist transport, search/inspection metadata, integrity-pinned install, and `/evo` plus administrative CLI search/install commands ([#29](https://github.com/Ch1nyzzz/pi/issues/29)).

### Changed

- Changed `/evo report` to default to the evidence window since the last successful improve run (without advancing the review cursor); pass `window: "full"` through the library API for the previous behavior.
- Changed evaluator verdicts to distinguish verified candidates, valid candidates needing future evidence, sufficient negative evidence, and invalid candidates.

### Fixed

- Fixed background reflection treating the component capability audit journal as a Recorder session log.
- Fixed managed-source replay reconstruction across Pi versions that add or remove the date line from the system prompt.
