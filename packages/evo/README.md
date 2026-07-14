# @earendil-works/pi-evo

Evo-Pi is a self-evolving Pi coding-agent workflow. It records session evidence, proposes grounded data or code changes, evaluates them independently, and requires a human decision before anything becomes active or ready for integration.

The implementation covers the complete data and isolated-code evolution loop: T0/T1/T2 risk tiers, revision-bound approval, trials and rollback, code worktrees, one-shot scheduled reflection, and runtime feature gates.

## Install

```bash
pi install npm:@earendil-works/pi-evo
```

The package installs a Pi extension with one `/evo` command and the `evo-pi` local CLI.

Initialize the immutable seed bundle before running improvement workflows:

```text
/evo init
/evo status
```

On first initialization, Evo-Pi automatically imports supported global Pi data from the agent directory into the seed bundle: `SYSTEM.md`, `APPEND_SYSTEM.md`, the first available `AGENTS.md`/`CLAUDE.md` context, and valid data-only skills. If none exists, initialization creates a policy-only seed.

Then use Pi normally. The Recorder writes session evidence without making live optimization decisions. Run reflection when enough evidence exists:

```text
/evo report
/evo improve
/evo list
/evo show <proposal-id>
/evo permit <proposal-id>
```

Pending proposals appear in the Pi status bar; startup never opens an approval dialog. In an idle interactive TUI, `Ctrl+Alt+E` applies the exact first pending T0 proposal without entering `/evo permit`. The same deterministic eligibility, revision, and artifact checks still run; non-T0 proposals require the normal review flow.

## Commands

| Pi command | Local CLI | Purpose |
|---|---|---|
| `/evo help` | `evo-pi help` | Show command help. |
| `/evo init` | `evo-pi init` | Migrate supported agent-global data into an immutable seed, or create a policy-only seed, and initialize `registry/stable`. Safe to run again. |
| `/evo status` | `evo-pi status` | Show the stable digest, active trial, pending/deferred counts, and pause state. |
| `/evo report` | `evo-pi report` | Generate a read-only evidence report covering the window since the last successful improve. |
| `/evo improve` | `evo-pi improve` | Run the Reflector, grounding checks, L1 validation, and applicable Critic/replay steps; stage up to two proposals. |
| `/evo scheduled-improve` | `evo-pi scheduled-improve` | Make one guarded scheduled-reflection attempt at the configured cadence, then exit. |
| `/evo schedule [cadence]` | `evo-pi schedule [cadence]` | Show or set the reflection cadence: `daily`, `3d`, `weekly`, `every <n>d`, or `manual`. |
| `/evo list` | `evo-pi list` | List proposals, revisions, and statuses. |
| `/evo show <id>` | `evo-pi show <id>` | Show the proposal card, exact diff, evidence, validation, review, replay, and retrospective when present. |
| `/evo note <text>` | `evo-pi note <session-id> <text>` | Add an explicit `NOTE:` inbox item. |
| `/evo request <text>` | `evo-pi request <session-id> <text>` | Add an explicit `REQUEST:` inbox item. |
| `/evo permit <id>` | `evo-pi permit <id>` | Ask questions, request an eligible revision, defer/reopen, reject, or approve the displayed proposal revision. |
| `/evo reject <id> <reason>` | `evo-pi reject <id> <reason>` | Reject a pending or deferred proposal and journal the reason. |
| `/evo rollback [digest] [reason]` | `evo-pi rollback [digest] [reason]` | Restore the active trial parent; without a trial, restore the stable bundle's manifest parent. An explicit target must be a previously committed stable ancestor. |
| `/evo retrospect` | `evo-pi retrospect` | Generate and display a retrospective for the active data trial. |
| `/evo keep [reason]` | `evo-pi keep [reason]` | Generate or reuse the current evidence-bound retrospective, ask for confirmation, then keep the active data trial. |
| `/evo pause [reason]` | `evo-pi pause [reason]` | Pause proposal-generating improve and scheduled-improve runs. Recording, reports, and trial review continue. |
| `/evo resume [reason]` | `evo-pi resume [reason]` | Resume improvement/reflection runs. |

`report`, `improve`, `scheduled-improve`, `retrospect`, and `keep` may invoke the configured Pi subscription model and authentication. Every background model call appends model, token, cost, session, phase, and time metadata to `reports/model-usage.jsonl`; reports include a rolling seven-day usage summary. A retrospective is reused only while its proposal revision and full evidence digest are unchanged.

The local `permit`, `reject`, `rollback`, `keep`, `pause`, and `resume` commands require both stdin and stdout to be interactive terminals and fail closed for piped input. The decision flow asks for explicit confirmation before the corresponding state or pointer transition.

`pause` blocks new interactive improve runs and aborts an in-flight scheduled-improve through its `AbortSignal`. An interactive improve that already passed its start check is not polled; stop that foreground command directly if needed.

## Initial resource migration

The default Evo root is inside the Pi agent directory, so first-time `init` automatically checks that agent directory for these conventional sources:

| Source | Bundle target |
|---|---|
| `SYSTEM.md` | `prompts/system.md` |
| `APPEND_SYSTEM.md` | `prompts/append-system.md` |
| First existing `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, or `CLAUDE.MD` | `memory/global-context.md` |
| Valid skills under `skills/` | `skills/<skill-name>/SKILL.md` |

Migration accepts regular, non-executable UTF-8 Markdown data. Skill discovery must match Pi's loader exactly, and a skill containing `SKILL.md` may not carry support code or other files. Symlinks, executable files, ambiguous skills, unsupported files, path collisions, and sources that change while being read fail initialization.

Library callers can declare additional sources explicitly. Prompt, memory, and preference directories must contain direct Markdown files; skill directories must satisfy the same data-only rules:

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

1. The Recorder pins each session event stream to the selected bundle digest. Explicit notes and requests are stored in the inbox with their source session ID.
2. The Reflector reads a bounded incremental evidence corpus with independent bundle, history, inbox, and session quotas, and may return at most two proposals. It always writes a grounded observation artifact, even when it proposes nothing, and advances `registry/review-cursor.json` only after the complete run succeeds. Reports, permit review, and retrospectives use a full corpus.
3. Data changes are compiled into immutable content-addressed bundles. Code patches are staged in the index of a proposal-specific Git worktree whose branch starts at the current commit.
4. Evo-Pi determines the actual kind and risk tier, runs the fixed deterministic L1 profile, and adds the required Critic or replay artifacts.
5. A human reviews one exact revision. Approval fails if the revision, diff, canonical review/replay/validation references, bundle parent, code base commit, repository identity, or worktree integrity no longer matches.
6. Approved T0 data becomes stable immediately; T1/T2 data starts a reversible trial; approved code remains isolated for manual integration.

The proposal card is the approval boundary. A revision produces a new diff and new approval context; confirmation of an older revision cannot approve it. Questions, answers, revision requests/results, deferrals, and reopens are retained in the proposal approval log.

## Human approval tiers

Evo-Pi derives `kind` and tier from the candidate contents rather than trusting the model's requested tier. A model may only make the tier stricter.

| Tier | Behavior |
|---|---|
| T0 | Deterministically low-risk data changes, currently proven reorder-only changes or one verbatim preference captured by the explicit-feedback recorder event. Approval advances `registry/stable` and marks the proposal kept without a trial. |
| T1 | Other non-core data changes. The proposal requires a Critic artifact. Approval starts a trial rather than permanently accepting the candidate. |
| T2 data | Core data or policy changes. The proposal requires Critic review, generate-only counterfactual replay, and exact approval-context confirmation. Approval starts a trial. |
| T2 code | Every code proposal. The proposal requires isolated-worktree L1 validation, Critic review, generate-only `code-patch-hypothesis` replay, and exact approval-context confirmation. Approval records the staged worktree as ready for an explicit human commit and normal integration; it does not alter the stable bundle or main worktree. |

Changes to `managedSources`, `enabledTools`, or `enabledFeatures` are always core T2 data changes because they alter the runtime trust or executable-capability boundary.

For a managed-source T2 data replay, Evo-Pi uses the Recorder's original `systemPromptOptions` to reconstruct the parent and candidate bases, preserves other extension wrappers, and excludes targets already consumed by semantic prompt/context/skill replacement. Missing or ambiguous reconstruction fails the replay instead of evaluating a duplicated prompt.

For T1 and T2 proposals, `permit` can ask grounded follow-up questions before a decision. T2 proposals can also be revised from explicit constraints. A revision reruns applicable staging, validation, replay, and Critic work. Pending proposals can be deferred and later reopened without losing their approval transcript.

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

1. Use Pi normally and collect evidence.
2. Run `/evo retrospect` to inspect an immutable pre/post memo bound to the proposal revision and the current full evidence digest.
3. Run `/evo keep` to reuse that snapshot only if the evidence digest is still current, or `/evo rollback` to restore the parent immediately. New evidence makes the prior memo stale, so generate and review another retrospective before keeping.

Bundles are immutable and content-addressed. Rollback accepts only a digest recorded as committed stable history that is also an ancestor of the current stable manifest chain; the current digest, a pending candidate, or a detached historical bundle is rejected. A successful rollback changes the registry pointer and current proposal lifecycle status without rewriting historical bundles, revision artifacts, approval logs, or recorded evidence.

## Background reflection cadence

Evo-Pi reflects on its own schedule with no external setup. The Pi extension runs the guarded scheduled-improve loop inside live sessions: shortly after a session starts, and periodically while it stays open, it makes one guarded attempt at the configured cadence. The user only sees the result — a status-bar entry and notification when new proposals are staged for approval.

The cadence persists in `registry/schedule.json` and is controlled with `/evo schedule`:

- `/evo schedule` shows the cadence, the last background run, and the next eligible day (interactively it also offers the presets).
- `/evo schedule daily | 3d | weekly | every <n>d` reflects at most once every N local days (default: every 3 days).
- `/evo schedule manual` disables automatic reflection entirely; only explicit `/evo improve` runs the Reflector.

Every attempt — in-session or external — passes the same guards: pause state, cadence (`interval-not-elapsed` until N days after the last completed run), optional quiet hours (`null` by default, meaning any time), recent session-log activity from *other* sessions (the running session's own log is excluded), the per-day run limit, and an atomically published heartbeating directory lease that excludes concurrent runs. Torn trailing run-journal records are repaired, started/completed/failed events are recorded, and a failed run does not push back the cadence, so the next eligible day retries.

While a scheduled run is active, Evo-Pi monitors pause state through its `AbortSignal` and checks pause again while holding the registry lock before it records completion. A pause cannot race a final successful completion into the journal.

`evo-pi scheduled-improve` remains available as a one-shot guarded attempt for cron, systemd, launchd, or another external scheduler; it honors the same persisted schedule. For example, an hourly cron entry lets Evo-Pi's own guards select at most one eligible run:

```cron
0 * * * * evo-pi scheduled-improve
```

Library callers can pass `quietHours` (or `null`), `inactivityMinutes`, `dailyRunLimit`, `everyDays`, and `lockStaleMs` to `runScheduledImprove`, or use `runConfiguredImprove` to honor `registry/schedule.json`; their `improve(signal)` callback must honor the supplied `AbortSignal`. An external scheduler must provide the same `PI_CODING_AGENT_DIR`, model authentication, working directory, and runtime environment as interactive Pi.

## Runtime feature gates

The pinned bundle may select `enabledTools` and `modelRouting.worker`. A worker route is either `provider/model` or a bare model ID that must be unique. Bundle loading, managed-source verification, route resolution, and model activation are fail-closed: a failure clears bundle features, blocks all tools, and restores the pre-bundle model when possible. Session replacement and shutdown restore the original model and tool set.

Code merged into the package can remain dormant by registering it through `createEvoExtension({ codeFeatures })`. Each definition receives a restricted `EvoCodeFeatureAPI` containing only guarded `on` and `registerTool` methods:

```ts
import { createEvoExtension } from "@earendil-works/pi-evo";

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

The exported `guardEvoFeature`, `isEvoFeatureEnabled`, and `createEvoFeatureHandler` helpers remain available for other session-aware code. Unscoped lookups fail closed unless exactly one session is active for the Evo root.

This is an enforced boundary only for callbacks registered through `EvoCodeFeatureAPI`. Evo-Pi cannot, without a coding-agent core change, intercept a third-party extension that directly uses the original `ExtensionAPI`, retains a raw API reference, subscribes through another channel, or performs side effects at module load. Commands, shortcuts, providers, other registrations, and `setup` side effects are also outside the restricted wrapper. Such code must be rejected during human review; feature gating is not a sandbox against arbitrary same-user code.

## Data directory and audit trail

By default, data is stored under `${PI_CODING_AGENT_DIR:-~/.pi/agent}/evo/`:

```text
log/<session-id>.jsonl                    Recorder events
artifacts/sha256/<digest>                 Large message, tool-output, and diff payloads
inbox/                                    Explicit notes and requests
bundles/<digest>/                         Immutable compiled data bundles
registry/stable                           Active bundle digest
registry/trial.json                       Active data trial, when present
registry/transition.json                  In-flight crash-recovery after-images, when present
registry/receipts.jsonl                   Append-only operation completion receipts
registry/history.jsonl                    Append-only decisions and pointer changes
registry/improve-runs.jsonl               Scheduled-run started/completed/failed events
registry/review-cursor.json               Last successfully reviewed incremental evidence
registry/paused                           Pause marker
registry/intents/                         State-bound service operation intents
proposals/<proposal-id>/proposal.json     Current proposal revision and state
proposals/<proposal-id>/approval.jsonl     Questions, answers, revisions, deferrals, and reopens
proposals/<proposal-id>/revisions/<n>/     Revision snapshot, exact artifacts, and code metadata
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
- Code approval is not deployment. Evo-Pi never automatically commits, merges, cherry-picks, installs dependencies, or changes the main worktree.
- Low-level registry and service APIs are trusted host-integration surfaces and must not be exposed as model tools. Built-in model runs disable all tools, and generated code remains isolated until a human manually commits and integrates it. A process already running as the same Unix user can import these APIs, edit Evo-Pi files, or automate a pseudo-terminal, so this is not a hard security boundary against a malicious same-user process.
- The local CLI's TTY check prevents ordinary non-interactive mutation but cannot prove that a real human controls the terminal. Protect the host account and Evo-Pi directory accordingly.
- Protected-path checks guard the current judge prompts and registry implementation; path checks cannot prove the semantics of arbitrary code, so human review must reject patches that introduce alternate approval or registry-write paths.
- In-session background reflection only runs while a Pi session is open; a machine that never runs Pi needs cron, systemd, launchd, or another external trigger for `evo-pi scheduled-improve`. Both paths honor the persisted `/evo schedule` cadence.
- Controlled `codeFeatures` gating covers only hooks and tools registered through `EvoCodeFeatureAPI`. Direct raw `ExtensionAPI` use, retained API references, other registration channels, commands, shortcuts, providers, and module or `setup` side effects remain outside the wrapper.
- The default code validator requires a supported OS sandbox and a fixed related-test mapping. Unsupported platforms or unmapped candidates fail closed and require workflow/code changes rather than reduced validation.
