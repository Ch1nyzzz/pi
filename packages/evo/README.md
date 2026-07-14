# @earendil-works/pi-evo

Evo-Pi records Pi coding-agent sessions, analyzes grounded evidence with separate model runs, and stages reversible data-bundle improvements for human approval.

The current implementation covers the M0–M3 data-evolution workflow. See [Current limits](#current-limits) for functionality that is intentionally not available yet.

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

Then use Pi normally. The Recorder writes session evidence without making live optimization decisions. Run reflection manually when enough evidence exists:

```text
/evo report
/evo improve
/evo list
/evo show <proposal-id>
/evo permit <proposal-id>
```

Pending proposals appear only in the Pi status bar; Evo-Pi does not open approval dialogs on startup.

## Commands

| Pi command | Local CLI | Purpose |
|---|---|---|
| `/evo help` | `evo-pi help` | Show command help. |
| `/evo init` | `evo-pi init` | Create an empty data-only seed bundle and initialize `registry/stable`. Safe to run again. |
| `/evo status` | `evo-pi status` | Show the stable digest, active trial, pending count, and pause state. |
| `/evo report` | `evo-pi report` | Generate a read-only evidence report without staging changes. |
| `/evo improve` | `evo-pi improve` | Run the Reflector, grounding checks, tiering, and applicable Critic/replay steps; stage up to two proposals. |
| `/evo list` | `evo-pi list` | List proposals and statuses. |
| `/evo show <id>` | `evo-pi show <id>` | Show the proposal card, diff, evidence, review, replay, and retrospective when present. |
| `/evo note <text>` | `evo-pi note <session-id> <text>` | Add an explicit `NOTE:` inbox item. |
| `/evo request <text>` | `evo-pi request <session-id> <text>` | Add an explicit `REQUEST:` inbox item. |
| `/evo permit <id>` | `evo-pi permit <id>` | Review and approve the exact displayed proposal digest. |
| `/evo reject <id> <reason>` | `evo-pi reject <id> <reason>` | Reject a pending proposal and journal the reason. |
| `/evo rollback [digest] [reason]` | `evo-pi rollback [digest] [reason]` | Restore the active trial parent, or an explicitly selected compiled bundle. |
| `/evo retrospect` | `evo-pi retrospect` | Generate and display a retrospective for the active trial. |
| `/evo keep [reason]` | `evo-pi keep [reason]` | Generate and display a fresh retrospective, ask for confirmation, then keep the trial. |
| `/evo pause [reason]` | `evo-pi pause [reason]` | Pause improvement/reflection runs. Recording continues. |
| `/evo resume [reason]` | `evo-pi resume [reason]` | Resume improvement/reflection runs. |

`report`, `improve`, `retrospect`, and `keep` use the configured Pi subscription model and authentication. The local `permit` command requires an interactive terminal; it never approves from piped or otherwise non-interactive input.

## Human approval tiers

Evo-Pi determines `kind` and tier from the actual candidate contents rather than trusting model output.

| Tier | Current behavior |
|---|---|
| T0 | Deterministically low-risk data changes, such as proven reorder-only changes or directly cited preferences. Pi and the local CLI ask for confirmation. Approval applies and immediately keeps the immutable bundle. |
| T1 | Other non-core data changes. The proposal card includes the diff and Critic review. Approval starts a trial rather than permanently accepting the candidate. |
| T2 | Core data changes and all code proposals. Approval requires typing the complete displayed `approvalDigest`; the service checks that the proposal, L1 artifacts, parent bundle, and exact digest have not changed since confirmation. T2 data changes also require replay evidence. |

Changing one byte changes the approval digest and invalidates the confirmation. Code proposals remain blocked as described below.

## Trial and rollback

Approving a T1 or T2 data proposal atomically points `registry/stable` at the candidate and writes `registry/trial.json`. Normal Pi sessions then use that pinned bundle and record its digest with the evidence.

During a trial:

1. Use Pi normally and collect evidence.
2. Run `/evo retrospect` to inspect a pre/post evidence memo.
3. Run `/evo keep` to generate a fresh memo and explicitly keep the candidate, or `/evo rollback` to restore the parent immediately.

Bundles are immutable and content-addressed. Rollback changes the registry pointer; it does not rewrite historical bundles or evidence.

## Data directory

By default, data is stored under `${PI_CODING_AGENT_DIR:-~/.pi/agent}/evo/`:

```text
log/<session-id>.jsonl        Recorder events
artifacts/sha256/<digest>     Large message, tool-output, and diff payloads
inbox/                        Explicit notes and requests
bundles/<digest>/             Immutable compiled data bundles
registry/stable               Active bundle digest
registry/trial.json           Active trial, when present
registry/history.jsonl        Append-only decisions and pointer changes
registry/paused               Pause marker
proposals/<proposal-id>/      Proposal, observations, review, replay, retrospective
reports/                      Read-only reports
locks/                        File-operation locks
worktrees/                    Reserved for the unimplemented M4 code workflow
```

## Current limits

- The implemented scope is M0–M3 data evolution: recording, reporting, grounded data proposals, Critic/replay evidence, human approval, trials, retrospective, keep, and rollback.
- Code requests can be recorded and staged as fixed-T2 proposals, but the M4 isolated-worktree and code-L1 workflow is not implemented. Such proposals fail L1 and are never automatically applied, committed, or merged.
- Current T2 review shows the complete proposal card and requires exact-digest confirmation. The design section 4.6 follow-up-question and live-revision loop is not implemented.
- There is no nightly or quiet-hours scheduler. Run `/evo improve` or `evo-pi improve` manually.
- Counterfactual replay is generate-only. It does not restore a workspace snapshot or execute tools, so it evaluates the first response or intended first action rather than full task completion.
- Evo-Pi does not install dependencies or merge code proposals.
