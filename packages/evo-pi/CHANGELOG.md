# Changelog

## [Unreleased]

### Added

- Added `packs init`, `workflows`, `config get/set`, `inbox`, and `usage` commands; `workflow` is renamed to `playbook` (deprecated alias kept).
- Added the bundled `/deep-research` (multi-source research with adversarial claim verification) and `/deepcode` (multi-agent coding: parallel exploration, frozen plan, verify-fix loop) workflow pack templates alongside `/deep-review`.
- Added the workflow SDK and the bundled `/deep-review` workflow pack template: workflow components can now be written with `runWorkflow()`/`agent()`/`parallel()`/`pipeline()` instead of raw JSONL-RPC, and child agents run with the host's real coding tools.
- Added streaming session triage (cheap-model hypothesis scouting every N sessions), dual-channel research (narrow request runs vs triage-fed scheduled runs), and guardrail-metric rollback for trials.
- Added `grants.approval: auto` (default): pack import/install auto-approves the previewed capability grants; set `prompt` to restore confirmation.

### Changed

- Changed Evo activity into a dedicated final status line that shows the active Canary component by name and can be entered with Down from the end of a draft without exposing internal IDs.

## [0.80.9] - 2026-07-16

### Added

- Added the one-command Evo-Pi distribution with the `evo-pi` interactive entry point and the Evo extension loaded by default.
- Added the visible research → build → validate → replay → evaluate → Canary → decision pipeline, including focused component approval and validation retry.
- Documented the boundary between shared product code, project configuration, local personal evolution state, and provider-bound model context.
- Added public `evo-pi import` and `evo-pi export` routing for staged optimization-pack exchange without entering interactive mode.
- Added public `evo-pi search` and `evo-pi install` routing for trusted signed registries, capability review, integrity-pinned downloads, and proposal-only installation.
