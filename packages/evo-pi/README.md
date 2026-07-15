# Evo-Pi

Evo-Pi is a local-first, self-evolving coding agent based on Pi. The `evo-pi` command includes the complete Pi terminal agent and loads the Evo extension automatically.

## Install

Requires Node.js 22.19 or newer.

```bash
npm install -g --ignore-scripts @earendil-works/evo-pi
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
```

Use `evo-pi-admin <command>` for non-interactive administration or external scheduling. See [`../evo/README.md`](../evo/README.md) in the source repository for the complete command and architecture reference.

## License

MIT
