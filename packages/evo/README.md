# @ch1nyzzz/pi-evo

Evo-Pi is a self-evolving Pi coding-agent workflow. It records session evidence, runs a fixed research-plan → experiment → candidate cycle, evaluates candidates independently, and activates only through a deterministic standing release policy or explicit human decision.

The implementation covers T0/T1/T2 risk tiers, revision-bound approval, trials and rollback, code worktrees, scheduled evolution, user-editable workflow instructions, and host-defined component ABIs. The default control roles are ResearchPlanner `openai-codex/gpt-5.6-sol` at `max`, Builder `openai-codex/gpt-5.6-terra` at `max`, and Evaluator `openai-codex/gpt-5.6-terra` at `xhigh`; override them in `evo/config.json` when needed.

## Install

```bash
pi install npm:@ch1nyzzz/pi-evo
```

The package installs a Pi extension with one `/evo` command. The standalone Evo-Pi distribution exposes the same state-management operations through `evo-pi-admin`.

Initialize the immutable seed bundle before running improvement workflows:

```text
/evo init
/evo status
```

On first initialization, Evo-Pi automatically imports supported global Pi data from the agent directory into the seed bundle: `SYSTEM.md`, `APPEND_SYSTEM.md`, the first available `AGENTS.md`/`CLAUDE.md` context, and valid data-only skills. If none exists, initialization creates a policy-only seed.

Then use Pi normally. The Recorder writes session evidence without making live optimization decisions. Run an evolution cycle when enough evidence exists:

```text
/evo report
/evo go <research goal>
/evo inspect
/evo list
/evo show <proposal-id>
/evo permit <proposal-id>
```

Pending proposals and background work appear on a dedicated final Pi status line; startup never opens an approval dialog. Press Down at the end of a draft to enter those status items, then use the configured selection keys and Enter to open the selected run, proposal, or Canary directly. Canary entries show the selected component name rather than internal run, proposal, or bundle IDs. `/evo inspect` opens the same unified activity list. In an idle interactive TUI, `Ctrl+Alt+E` applies the exact first pending T0 proposal without entering `/evo permit`. The same deterministic eligibility, revision, and artifact checks still run; non-T0 proposals require the normal review flow.

## Commands

| Pi command | Admin CLI | Purpose |
|---|---|---|
| `/evo help` | `evo-pi-admin help` | Show command help. |
| `/evo init` | `evo-pi-admin init` | Migrate supported agent-global data into an immutable seed, or create a policy-only seed, and initialize `registry/stable`. Safe to run again. |
| `/evo status` | `evo-pi-admin status` | Show the stable digest, active trial, pending/deferred counts, and pause state. |
| `/evo report` | `evo-pi-admin report` | Generate a read-only evidence report covering the window since the last successful improve. |
| `/evo go [request\|--scheduled]` | `evo-pi-admin go [request\|--scheduled]` | Start a detached headless ResearchPlanner → Builder → Evaluator task and return immediately. `--scheduled` instead makes one guarded cadence-gated attempt in the foreground (`scheduled-improve` remains a deprecated alias). |
| `/evo inspect [run-id]` | `evo-pi-admin inspect [run-id]` | Open the unified Evo activity picker for runs, Canary trials, proposals, and recent history. Select an item with the arrow keys and press Enter for its live details. The local CLI prints a run snapshot. |
| `/evo pause <run-id>` | `evo-pi-admin pause <run-id>` | Suspend a live task without deleting its process or artifacts. |
| `/evo resume <run-id>` | `evo-pi-admin resume <run-id>` | Continue a suspended task. |
| `/evo delete <run-id>` | `evo-pi-admin delete <run-id>` | Stop a live worker and permanently delete the task directory. |
| `/evo retry <run-id>` | `evo-pi-admin retry <run-id>` | Preserve the old audit record, clone its built component candidate, verify the unchanged stable parent, and continue with executable ABI/determinism validation. |
| `/evo schedule [cadence]` | `evo-pi-admin schedule [cadence]` | Show or set the evolution cadence: `daily`, `3d`, `weekly`, `every <n>d`, or `manual`. |
| `/evo playbook [reset]` | `evo-pi-admin playbook [reset]` | Show the trusted user-editable evolution playbook (`workflow.md`), or restore its packaged default. `workflow` remains a deprecated alias. |
| `/evo workflows` | `evo-pi-admin workflows` | List active workflow components with their triggers, spawn-agent grants, and live call usage. |
| `/evo packs [init <name> [dir]]` | `evo-pi-admin packs [init <name> [dir]]` | List the bundled workflow pack templates, or write one as an importable integrity-signed pack. |
| `/evo config [set <key> <value>]` | `evo-pi-admin config [set <key> <value>]` | Show the control config, or update a whitelisted key through the fail-closed parser. |
| `/evo grants` | `evo-pi-admin grants` | Show every component's persisted capability grants with usage against each budget, plus in-flight operations. |
| `/evo history [<count>]` | `evo-pi-admin history [<count>]` | Show the bundle transition audit history: initialize, keep, rollback, pause, and proposal decisions. |
| `/evo triage [now]` | `evo-pi-admin triage [now]` | Show the streaming-triage cursor and backlog, or force an immediate scan of new session digests. |
| `/evo inbox` | `evo-pi-admin inbox` | List inbox entries with lifecycle status and a content preview. |
| `/evo usage [<n>d]` | `evo-pi-admin usage [<n>d]` | Summarize background model tokens and cost by phase (default 7 days). |
| `/evo list` | `evo-pi-admin list` | List proposals, revisions, and statuses. |
| `/evo show <id>` | `evo-pi-admin show <id>` | Show the proposal card, exact diff, evidence, validation, review, replay, and retrospective when present. |
| `/evo note <text>` | `evo-pi-admin note <session-id> <text>` | Add an explicit `NOTE:` inbox item. |
| `/evo request <text>` | `evo-pi-admin request <session-id> <text>` | Add an explicit feature/research request. |
| `/evo preference <text>` | `evo-pi-admin preference <session-id> <text>` | Materialize an explicit durable preference directly through the trusted append-only T0 path; no model cycle is used. |
| `/evo preferences` | `evo-pi-admin preferences` | Show instructions in the active stable `memory/preferences.json`. |
| `/evo forget <preference-id>` | `evo-pi-admin forget <session-id> <preference-id>` | Queue removal of an active preference through the normal evaluated release path. |
| `/evo resolve <inbox-file> [reason]` | `evo-pi-admin resolve <inbox-file> [reason]` | Mark an externally completed input fulfilled and collect its payload. |
| `/evo gc [--dry-run]` | `evo-pi-admin gc [--dry-run]` | Preview or collect terminal inbox payloads while retaining lifecycle tombstones. |
| `/evo permit <id>` | `evo-pi-admin permit <id>` | Ask questions, request an eligible revision, defer/reopen, reject, or approve the displayed proposal revision. |
| `/evo reject <id> <reason>` | `evo-pi-admin reject <id> <reason>` | Reject a pending or deferred proposal and journal the reason. |
| `/evo rollback [digest] [reason]` | `evo-pi-admin rollback [digest] [reason]` | Restore the active trial parent; without a trial, restore the stable bundle's manifest parent. An explicit target must be a previously committed stable ancestor. |
| `/evo retrospect` | `evo-pi-admin retrospect` | Generate and display a retrospective for the active data trial. |
| `/evo keep [reason]` | `evo-pi-admin keep [reason]` | Generate or reuse the current evidence-bound retrospective, ask for confirmation, then keep the active data trial. |

`report`, `go` (including `--scheduled`), `triage now`, `retrospect`, and `keep` may invoke the configured Pi subscription model and authentication. Every background model call appends model, token, cost, session, phase, and time metadata to `reports/model-usage.jsonl`; reports include a rolling seven-day usage summary. A retrospective is reused only while its proposal revision and full evidence digest are unchanged.

The local `permit`, `reject`, `rollback`, `keep`, and `delete` commands require both stdin and stdout to be interactive terminals when they require confirmation. Task `pause`, `resume`, and `inspect` are direct lifecycle operations keyed by run ID.

`go` persists the run before spawning a detached worker, writes worker output to the run's `worker.log`, and never occupies the current Pi conversation. When the OS component sandbox is unavailable, Evo never silently falls back: retry validation and each session-bound component activation ask for an explicit one-time direct-execution permission, scoped to that validation process or session and never persisted. `pause` suspends that worker and `resume` continues the same process; `delete` is a separate irreversible operation that kills the worker before removing its run directory. Every run phase is reflected in Pi's lower-left Evo status. Missing future evidence produces `awaiting-evidence`, not rejection. When component Canary trials are enabled, a component-selection candidate stops at `awaiting-canary-approval`; `/evo inspect` shows the exact diff, evaluation, current/candidate digests, ABI, and rollback plan. The user may start the frozen Canary, set a custom minimum session count and maximum duration, or explicitly confirm direct activation after a second warning. Direct activation still revalidates the exact candidate, records a `human-direct-keep` audit event, preserves the stable parent, and remains rollbackable. When Canary offers are disabled, the candidate remains pending for normal review.

## Initial resource migration

The default Evo root is inside the Pi agent directory, so first-time `init` automatically checks that agent directory for these conventional sources:

| Source | Bundle target |
|---|---|
| `SYSTEM.md` | `prompts/system.md` |
| `APPEND_SYSTEM.md` | `prompts/append-system.md` |
| First existing `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, or `CLAUDE.MD` | `memory/global-context.md` |
| Valid skills under `skills/` | `skills/<skill-name>/SKILL.md` |

Migration accepts regular, non-executable UTF-8 Markdown data. Skill discovery must match Pi's loader exactly, and a skill containing `SKILL.md` may not carry support code or other files. Symlinks, executable files, ambiguous skills, unsupported files, path collisions, and sources that change while being read fail initialization.

Library callers can declare additional sources explicitly. Migrated prompt, memory, and preference directories must contain direct Markdown files; skill directories must satisfy the same data-only rules. Evo-managed durable preferences use the separately validated `memory/preferences.json` schema:

```ts
await service.init(undefined, {
	agentDirectory: "/path/to/pi-agent",
	systemPromptDirectories: ["/path/to/prompts"],
	skillDirectories: ["/path/to/skills"],
	memoryDirectories: ["/path/to/memory"],
	preferenceDirectories: ["/path/to/preferences"],
});
```

Each migrated asset records its canonical source root, relative source path, bundle target, and source digest in `policy.managedSources`. While an original source still exists, runtime activation verifies it against that digest and fails closed on drift: the bundle is disabled and all tools are blocked rather than mixing an out-of-band edit with registry state. If the original source is deleted, its immutable bundle copy continues to supply the prompt, context, or skill; this is the supported handoff after checking the migrated seed. Runtime replacement also avoids injecting unchanged host resources twice.

## Evolution workflow

1. The Recorder pins every foreground session event stream to the selected bundle digest, backfills missing user turns when a session is resumed, and writes a compact derived session digest. A cheap phrase matcher may copy likely durable instructions to the inbox only as unclassified candidates; it never decides that a feature request is a preference.
2. The trusted `/evo preference` path directly materializes an exact user-authored instruction without model calls. ResearchPlanner classifies ambiguous natural-language candidates as `preference`, `request`, `note`, or `task-local`. Open inferred preferences and requests remain visible across evidence-cursor advances; merely reviewing an item does not consume it.
3. Sol Ultra writes immutable `runs/<id>/plan.md` and `experiment.json`. The experiment is frozen before implementation and may reference only fixed check profiles, never model-selected shell commands.
4. Terra Max returns one exact data change or edits a run-scoped Builder worktree. Data compiles to an immutable bundle; the host renders code edits with Git, preserves the generated patch in the run, and stages and validates it in a separate proposal worktree pinned to the same repository commit.
5. Terra XHigh evaluates the frozen experiment, then runs a second adversarial pass in a fresh context. Existing T2 generate-only replay retains its stated limitations.
6. Deterministic release policy may apply verified T0 data directly or start a reversible data trial when standing policy allows. A pre-defined component ABI enters focused human approval, where the user may use the default Canary, customize its bounds, or explicitly bypass Canary and activate the validated component directly. New ABI, arbitrary code, capability-expanding, and control-boundary changes remain pending for explicit review.
7. Kept preference candidates become structured `memory/preferences.json`; kept requests become fulfilled. Rollback reopens linked inputs. Terminal inbox payloads are garbage-collected after a digest-bearing tombstone is written, while active preferences remain in the bundle.
8. The evidence cursor advances only after the complete cycle succeeds. For a private project, create `.pi/evo-private` to suppress recording entirely.

The sequence is intentionally fixed rather than a model-generated DAG. Users may edit `${PI_CODING_AGENT_DIR}/evo/workflow.md`; the model cannot edit that trusted file during an evolution run.

The proposal card is the approval boundary. A revision produces a new diff and new approval context; confirmation of an older revision cannot approve it. Questions, answers, revision requests/results, deferrals, and reopens are retained in the proposal approval log.

## Human and standing approval tiers

Evo-Pi derives `kind` and tier from candidate contents rather than trusting a model. `evo/config.json` controls standing automatic T0 application, reversible data trials, and whether validated component candidates may be offered for explicit Canary approval. Disable those booleans to require the normal review path for every activation. A model may only make review stricter.

| Tier | Behavior |
|---|---|
| T0 | Deterministically low-risk data changes: proven reorder-only changes, legacy verbatim memory additions, or append-only `memory/preferences.json` entries whose instruction and source quote are verified against a recorded user event. Standing policy may advance `registry/stable` directly; otherwise explicit approval is required. |
| T1 | Other non-core data changes. The proposal requires an independent Evaluator artifact. Standing policy or explicit approval starts a trial rather than permanently accepting the candidate. |
| T2 data | Core data or policy changes. The proposal requires Evaluator review, generate-only counterfactual replay, and exact approval-context confirmation. A pre-defined ABI component may enter a standing-policy trial; a new ABI cannot. |
| T2 code | Every ordinary code proposal. The proposal requires isolated-worktree L1 validation, Evaluator review, generate-only `code-patch-hypothesis` replay, and exact approval-context confirmation. It remains isolated for explicit source integration. |

Changes to `managedSources`, `enabledTools`, or `enabledFeatures` are always core T2 data changes because they alter the runtime trust or executable-capability boundary.

For a managed-source T2 data replay, Evo-Pi uses the Recorder's original `systemPromptOptions` to reconstruct the parent and candidate bases, preserves other extension wrappers, and excludes targets already consumed by semantic prompt/context/skill replacement. Missing or ambiguous reconstruction fails the replay instead of evaluating a duplicated prompt.

For T1 and T2 proposals, `permit` can ask grounded follow-up questions before a decision. T2 proposals can also be revised from explicit constraints. A revision reruns applicable staging, validation, replay, and Evaluator work. Pending proposals can be deferred and later reopened without losing their approval transcript.

Final confirmation binds the displayed revision and diff plus a canonical digest of the current review, replay, and validation references. For code, the approval context also binds the repository, base commit, and exact staged diff, rather than treating the patch text as portable between repositories or commits.

Bundle `validation.requiredChecks` is a closed schema and currently accepts only `bundle-compile`; it cannot inject model-selected shell commands. Code proposals always use the package's fixed check-and-related-test profile.

## Code proposal isolation

Each code revision uses its own branch and worktree:

```text
branch:    evo/<proposal-id>/r<revision>
worktree:  <evo-root>/worktrees/<proposal-id>/r<revision>
```

Evo-Pi applies the patch to the worktree index, rejects unsafe paths, dependency/lockfile edits, binary changes, symlinks, submodules, and modifications to its judging or apply/rollback boundary. The default L1 profile runs `npm run check` plus mapped related tests in a disposable private copy inside a supported OS sandbox. Validation output is not retained, and any command that changes the copied candidate fails the proposal. Approval revalidates the unchanged parent bundle, base commit, branch, staged diff, and L1 result.

Code replay does not load or execute the candidate, restore its workspace, or expose tool schemas. It supplies the proposed patch JSON to the model only as quoted evaluation data and predicts a speculative first response or intended first action; this is a hypothesis artifact, not evidence of end-to-end candidate behavior.

Code approval leaves the branch ref at the recorded base commit and the exact candidate staged in the worktree index. It does not commit, merge, cherry-pick, install dependencies, or modify the caller's main worktree. Review and commit it explicitly:

```bash
cd <evo-root>/worktrees/<proposal-id>/r<revision>
git status --short
git diff --cached
git commit -m "approved Evo-Pi change"
```

After that commit, integrate the branch through the repository's normal review and merge process.

## Data trials and rollback

Approving a T1 or T2 data proposal performs a crash-recoverable registry transition that points `registry/stable` at the candidate and writes `registry/trial.json`. New Pi sessions use that pinned bundle and record its digest with their evidence.

During a trial:

1. Use Pi normally; every completed pinned session joins the baseline or candidate cohort automatically.
2. After 10 candidate sessions or 7 days by default, the background loop writes an immutable automatic comparison and retrospective. `/evo retrospect` remains available to refresh it manually.
3. Review the comparison through `/evo show <proposal>` and run `/evo keep` or `/evo rollback`. New evidence makes the prior memo stale, so keeping refreshes the evidence check.

Bundles are immutable and content-addressed. Rollback accepts only a digest recorded as committed stable history that is also an ancestor of the current stable manifest chain; the current digest, a pending candidate, or a detached historical bundle is rejected. A successful rollback changes the registry pointer and current proposal lifecycle status without rewriting historical bundles, revision artifacts, approval logs, or recorded evidence.

## Background evolution cadence

Evo-Pi reflects on its own schedule with no external setup. The Pi extension runs the guarded scheduled-improve loop inside live sessions: shortly after a session starts, and periodically while it stays open, it makes one guarded attempt at the configured cadence. The user only sees the result — a status-bar entry and notification when new proposals are staged for approval.

The cadence persists in `registry/schedule.json` and is controlled with `/evo schedule`:

- `/evo schedule` shows the cadence, the last background run, and the next eligible day (interactively it also offers the presets).
- `/evo schedule daily | 3d | weekly | every <n>d` reflects at most once every N local days (default: every 3 days).
- `/evo schedule manual` disables automatic evolution entirely; explicit `/evo go` tasks remain available.

Every attempt — in-session or external — passes the same guards: pause state, cadence (`interval-not-elapsed` until N days after the last completed run), optional quiet hours (`null` by default, meaning any time), recent session-log activity from *other* sessions (the running session's own log is excluded), the per-day run limit, and an atomically published heartbeating directory lease that excludes concurrent runs. Torn trailing run-journal records are repaired, started/completed/failed events are recorded, and a failed run does not push back the cadence, so the next eligible day retries.

While a scheduled run is active, Evo-Pi monitors pause state through its `AbortSignal` and checks pause again while holding the registry lock before it records completion. A pause cannot race a final successful completion into the journal.

`evo-pi-admin go --scheduled` remains available as a one-shot guarded attempt for cron, systemd, launchd, or another external scheduler; it honors the same persisted schedule (`scheduled-improve` is a deprecated alias). For example, an hourly cron entry lets Evo-Pi's own guards select at most one eligible run:

```cron
0 * * * * evo-pi-admin go --scheduled
```

Library callers can pass `quietHours` (or `null`), `inactivityMinutes`, `dailyRunLimit`, `everyDays`, and `lockStaleMs` to `runScheduledImprove`, or use `runConfiguredImprove` to honor `registry/schedule.json`; their `improve(signal)` callback must honor the supplied `AbortSignal`. An external scheduler must provide the same `PI_CODING_AGENT_DIR`, model authentication, working directory, and runtime environment as interactive Pi.

## Host-defined component ABIs

A bundle may select a content-addressed implementation only for an ABI registered by the host. The first supported ABI is `compaction/v1`; unknown ABI names and versions fail bundle compilation. A selection binds surface, component id, ABI, artifact digest, and JSON configuration:

```json
{
  "components": {
    "compaction": {
      "id": "hierarchical-summary",
      "abi": "compaction/v1",
      "artifactDigest": "<sha256>",
      "config": {}
    }
  }
}
```

Component artifacts contain an immutable `manifest.json` and `.mjs` JSONL process entrypoint. Loading verifies the complete artifact identity, ABI activation boundary, configuration schema, and requested capabilities against the ABI ceiling. Generated components run out-of-process with no inherited credentials and, when available, a networkless Linux bubblewrap launcher. Without that sandbox, execution remains blocked until the user grants a one-time validation- or session-scoped direct-execution permission. The runtime validates every invocation input and output. A failed compaction component falls back to Pi's default compaction and is visible to the Recorder.

The host predefines slots, not implementations. Evo may research and prepare a T2 patch for a new ABI, but an unknown ABI cannot declare itself and activate in the same cycle.

## Runtime feature gates

The pinned bundle may select `enabledTools`, `components`, and `modelRouting.worker`. A worker route is either `provider/model` or a bare model ID that must be unique. Bundle loading, managed-source verification, route resolution, and model activation are fail-closed: a failure clears bundle features, blocks all tools, and restores the pre-bundle model when possible. Session replacement and shutdown restore the original model and tool set.

Code merged into the package can remain dormant by registering it through `createEvoExtension({ codeFeatures })`. Each definition receives a restricted `EvoCodeFeatureAPI` containing only guarded `on` and `registerTool` methods:

```ts
import { createEvoExtension } from "@ch1nyzzz/pi-evo";

export default createEvoExtension({
	codeFeatures: [
		{
			id: "experimental-path",
			setup(feature) {
				feature.on("before_agent_start", (event) => ({
					systemPrompt: `${event.systemPrompt}\n\nUse the reviewed experimental path.`,
				}));
			},
		},
	],
});
```

The policy runtime registers first, pins `enabledFeatures` to the selected bundle and session ID, removes dormant feature-owned tools from the active set, and rechecks every wrapped hook and tool invocation. `setup` necessarily runs during extension loading to register those wrappers and should have no side effects beyond registration; its wrapped callbacks remain dormant.

A T2 data proposal can activate an already-merged feature by adding its ID to `enabledFeatures`. Rollback leaves the current session pinned but disables the feature for the next session; resume and reload retain the session's recorded bundle.

Component approval is a human override boundary, not a standing model policy. The focused Inspector offers the frozen Canary, a custom Canary bounded to 1–10,000 candidate sessions and 1–365 days, and direct activation with a second confirmation. During an active Canary, opening the status item shows the full validation, evaluation, progress, and rollback plan; the user can end evidence collection and keep the component immediately with another two-step confirmation. Custom controls are persisted in `registry/trial.json` and drive the actual retrospective deadline; either direct path records `human-direct-keep`, preserves the parent lineage, and remains reversible through `/evo rollback`.

The exported `guardEvoFeature`, `isEvoFeatureEnabled`, and `createEvoFeatureHandler` helpers remain available for other session-aware code. Unscoped lookups fail closed unless exactly one session is active for the Evo root.

This is an enforced boundary only for callbacks registered through `EvoCodeFeatureAPI`. Evo-Pi cannot, without a coding-agent core change, intercept a third-party extension that directly uses the original `ExtensionAPI`, retains a raw API reference, subscribes through another channel, or performs side effects at module load. Commands, shortcuts, providers, other registrations, and `setup` side effects are also outside the restricted wrapper. Such code must be rejected during human review; feature gating is not a sandbox against arbitrary same-user code.

## Data directory and audit trail

By default, data is stored under `${PI_CODING_AGENT_DIR:-~/.pi/agent}/evo/`:

```text
log/<session-id>.jsonl                    Recorder events
session-digests/<session-id>.json         Derived per-session metrics and evidence references
artifacts/sha256/<digest>                 Large message, tool-output, and diff payloads
components/sha256/<digest>/               Immutable ABI component artifacts
runs/<run-id>/{run.json,plan.md,...}      Fixed evolution-cycle state and artifacts
workflow.md                               Trusted user-editable workflow instructions
config.json                               Trusted role routes and standing release policy
inbox/                                    Active unclassified/preference/request/note payloads
bundles/<digest>/memory/preferences.json  Structured active preference instructions and provenance
bundles/<digest>/                         Immutable compiled data bundles
registry/stable                           Active bundle digest
registry/trial.json                       Active data trial, when present
registry/transition.json                  In-flight crash-recovery after-images, when present
registry/receipts.jsonl                   Append-only operation completion receipts
registry/history.jsonl                    Append-only decisions and pointer changes
registry/inbox-history.jsonl              Inbox classification, lifecycle, and GC tombstones
registry/improve-runs.jsonl               Scheduled-run started/completed/failed events
registry/review-cursor.json               Last successfully reviewed incremental evidence
registry/paused                           Pause marker
registry/intents/                         State-bound service operation intents
proposals/<proposal-id>/proposal.json     Current proposal revision and state
proposals/<proposal-id>/approval.jsonl     Questions, answers, revisions, deferrals, and reopens
proposals/<proposal-id>/revisions/<n>/     Revision snapshot, exact artifacts, and code metadata
proposals/<proposal-id>/revisions/<n>/change.json
proposals/<proposal-id>/revisions/<n>/comparisons/<digest>.{json,md}
proposals/<proposal-id>/revisions/<n>/retrospectives/<digest>.md
reports/*.md                              Generated observation and evidence reports
reports/model-usage.jsonl                 Append-only background model usage journal
worktrees/<proposal-id>/r<n>/              Isolated code candidates
locks/                                    Proposal, registry, code, and scheduler locks
```

Registry decisions use a durable after-image transition record. Initialization and every mutating registry operation finish any pending transition before starting another; history entries carry stable event IDs so recovery cannot append a decision twice. A state that matches neither the recorded before-image nor after-image fails closed instead of being overwritten.

Approve, reject, defer, reopen, keep, and rollback use durable state-bound intents plus append-only operation receipts. A retry with the same payload is reused only while the registry state still matches, so a lost response does not repeat a committed transition and a later state creates a new operation. Append-only journals repair only an incomplete final line and reject earlier corruption.

Managed Evo-Pi directories use mode `0700`, atomically written state uses `0600`, published bundle files use read-only mode, and evaluation-artifact paths are write-once.

Evaluation artifacts are write-once, content-digested, and bound to the proposal revision and diff digest. Each revision snapshot records the latest lifecycle state for that revision and may be refreshed; exact evaluation artifacts and append-only approval/history logs retain the immutable audit evidence.

## Current limits

- Automatic `init` migration covers only conventional agent-global `SYSTEM.md`, `APPEND_SYSTEM.md`, the first `AGENTS.md`/`CLAUDE.md` context, and data-only skills, plus explicitly declared library sources. It does not infer arbitrary settings, project-local instructions, dependencies, or executable skill support files.
- Replay is generate-only. Data replay compares a first response or intended first action; code replay uses the patch as quoted hypothesis data and predicts a speculative first response or action. Neither restores a workspace, loads candidate code or tool schemas, executes tools, or establishes end-to-end behavior.
- Ordinary source-patch approval is not deployment. Evo-Pi never automatically commits, merges, cherry-picks, installs dependencies, or changes the main worktree. Only artifacts implementing a pre-defined ABI may enter the isolated component trial path.
- Low-level registry and service APIs are trusted host-integration surfaces and are not model tools. ResearchPlanner receives read-only local tools plus allowlisted public research tools. Data and component Builders remain read-only; a code Builder receives edit/write tools rooted at a run-scoped Git worktree, while the host generates and validates the patch. Generated components run through validated JSONL RPC and, on supported Linux hosts, a no-network `bwrap` sandbox; explicit one-time direct execution has ordinary user permissions when that sandbox is unavailable. A process already running as the same Unix user can still edit Evo-Pi files or automate a pseudo-terminal, so this is not a hard security boundary against a malicious same-user process.
- The local CLI's TTY check prevents ordinary non-interactive mutation but cannot prove that a real human controls the terminal. Protect the host account and Evo-Pi directory accordingly.
- Protected-path checks guard the current judge prompts and registry implementation; path checks cannot prove the semantics of arbitrary code, so human review must reject patches that introduce alternate approval or registry-write paths.
- In-session background evolution only runs while a Pi session is open; a machine that never runs Pi needs cron, systemd, launchd, or another external trigger for `evo-pi-admin go --scheduled`. Both paths honor the persisted `/evo schedule` cadence.
- Controlled `codeFeatures` gating covers only hooks and tools registered through `EvoCodeFeatureAPI`. Direct raw `ExtensionAPI` use, retained API references, other registration channels, commands, shortcuts, providers, and module or `setup` side effects remain outside the wrapper.
- The default code validator requires a supported OS sandbox and a fixed related-test mapping. Unsupported platforms or unmapped candidates fail closed and require workflow/code changes rather than reduced validation.
