# Changelog

## [Unreleased]

### Added

- Added `grants` (capability budgets and usage per component), `history` (bundle keep/rollback audit trail), and `triage [now]` (streaming-triage status and manual trigger) commands; `go --scheduled` absorbs `scheduled-improve` (deprecated alias kept), and the shared commands of `/evo` and `evo-pi` now run through one handler table so the two surfaces cannot drift.
- Added `packs init`, `workflows`, `config get/set`, `inbox`, and `usage` commands; `workflow` is renamed to `playbook` (deprecated alias kept).
- Added the bundled `/deep-research` (multi-source research with adversarial claim verification) and `/deepcode` (multi-agent coding: parallel exploration, frozen plan, verify-fix loop) workflow pack templates alongside `/deep-review`.
- Added the workflow SDK and the bundled `/deep-review` workflow pack template: workflow components can now be written with `runWorkflow()`/`agent()`/`parallel()`/`pipeline()` instead of raw JSONL-RPC, and child agents run with the host's real coding tools.
- Added streaming session triage (cheap-model hypothesis scouting every N sessions), dual-channel research (narrow request runs vs triage-fed scheduled runs), and guardrail-metric rollback for trials.
- Added `grants.approval: auto` (default): pack import/install auto-approves the previewed capability grants; set `prompt` to restore confirmation.

### Changed

- Changed Evo activity into a dedicated final status line that shows the active Canary component by name and can be entered with Down from the end of a draft without exposing internal IDs.

### Fixed

- Fixed `/evo inspect` on small terminals hiding the top of the task list (pending proposals sort first), permanently showing "正在连接后台任务……" when an opened item no longer exists, and proposal cards opening scrolled to the bottom.
- Pending proposals can now be processed directly inside `/evo inspect`: a pinned action bar offers approve/reject/defer (reopen for deferred) with reason input and strict digest confirmation, and the task list gained status glyphs and inline timing.

## [0.80.9] - 2026-07-16

### Added

- Added the one-command Evo-Pi distribution with the `evo-pi` interactive entry point and the Evo extension loaded by default.
- Added the visible research → build → validate → replay → evaluate → Canary → decision pipeline, including focused component approval and validation retry.
- Documented the boundary between shared product code, project configuration, local personal evolution state, and provider-bound model context.
- Added public `evo-pi import` and `evo-pi export` routing for staged optimization-pack exchange without entering interactive mode.
- Added public `evo-pi search` and `evo-pi install` routing for trusted signed registries, capability review, integrity-pinned downloads, and proposal-only installation.
