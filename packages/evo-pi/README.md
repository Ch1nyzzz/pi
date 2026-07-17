# Evo-Pi

Evo-Pi is a local-first, self-evolving coding agent based on Pi. The `evo-pi` command includes the complete Pi terminal agent and loads the Evo extension automatically.

## Install

Requires Node.js 22.19 or newer.

```bash
npm install -g --ignore-scripts @ch1nyzzz/evo-pi
evo-pi
```

Authenticate with `/login`, then initialize your local evolution state once:

```text
/evo init
/evo status
```

No separate Pi or Evo extension installation is required. Upgrade the installed product with `evo-pi update --self`.

## What is installed

The npm package contains only shared product code:

- Pi's terminal coding-agent runtime, tools, providers, and session UI
- the Evo recorder, bundle runtime, proposal workflow, evaluation, approval, trial, and rollback machinery
- default workflow templates and data schemas

It does not contain any user's sessions, preferences, memory, bundles, proposals, reports, or generated candidates.

## Local personal state

Evo-Pi stores personal evolution state under:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/evo/
```

This includes session evidence, durable preferences, memory, immutable bundles, proposals, evaluations, trials, reports, and generated candidates. Durable preferences live inside the active local bundle at `bundles/<digest>/memory/preferences.json`; they are never published back into the npm package or this repository.

Project-owned configuration such as `AGENTS.md` remains separate from personal evolution state. Add `.pi/evo-private` to a project root to disable Evo recording for that project.

## Privacy boundary

Personal evolution state is persisted locally and Evo-Pi has no hosted synchronization database. Local does not mean that data can never leave the device: normal conversations and the selected evidence needed by ResearchPlanner, Builder, or Evaluator are sent to the model provider chosen by the user. Provider authentication and transport are inherited from Pi.

## Core commands

```text
/evo help
/evo status
/evo report
/evo go <goal>
/evo inspect
/evo list
/evo show <proposal-id>
/evo permit <proposal-id>
/evo rollback
/evo packs init <template>   # write a bundled workflow pack (deep-review, deep-research, deepcode)
/evo workflows               # active workflow components and their triggers
/evo grants                  # capability budgets and live usage per component
/evo history                 # bundle keep/rollback audit trail
/evo triage now              # scan new session digests for improvement hypotheses
/evo usage 7d                # background model cost by phase
```

In the interactive TUI, a dedicated final status line names the active Canary component. Press Down at the end of a draft to enter Evo activity, then use the configured selection keys and Enter to open the selected run, trial, or proposal; internal IDs are not shown. `/evo inspect` opens the same activity list. Component approval offers the default Canary, custom session/time bounds, or an explicitly confirmed direct activation that remains rollbackable. An active Canary can also be expanded from the status item and kept immediately through the same two-step human override.

Use `evo-pi-admin <command>` for non-interactive administration or external scheduling. See [`../evo/README.md`](../evo/README.md) in the source repository for the complete command and architecture reference.

## License

MIT
