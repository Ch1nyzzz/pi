# Changelog

## [Unreleased]

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

### Changed

- Changed `/evo report` to default to the evidence window since the last successful improve run (without advancing the review cursor); pass `window: "full"` through the library API for the previous behavior.
- Changed evaluator verdicts to distinguish verified candidates, valid candidates needing future evidence, sufficient negative evidence, and invalid candidates.

### Fixed

- Fixed managed-source replay reconstruction across Pi versions that add or remove the date line from the system prompt.
