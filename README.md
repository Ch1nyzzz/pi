<p align="center">
  <h1 align="center">Evo-Pi</h1>
  <p align="center">A local-first coding agent that learns from your own work.</p>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@ch1nyzzz/evo-pi"><img alt="npm" src="https://img.shields.io/npm/v/@ch1nyzzz/evo-pi?style=flat-square" /></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" /></a>
</p>

Evo-Pi combines the Pi terminal coding agent with a built-in evolution engine. It records local session evidence, proposes narrow improvements, evaluates them independently, and activates them through deterministic policy or explicit review. Every active personal configuration is an immutable local bundle with rollback history.

## Install

Requires Node.js 22.19 or newer.

```bash
npm install -g --ignore-scripts @ch1nyzzz/evo-pi
evo-pi
```

Authenticate and initialize once:

```text
/login
/evo init
/evo status
```

The `evo-pi` executable includes the coding agent and loads Evo automatically. There is no separate Pi installation or `pi install` step. Upgrade later with `evo-pi update --self`.

## Product and personal-data boundary

The published npm packages contain shared product code only:

- terminal UI, model providers, authentication, sessions, and coding tools
- Recorder, immutable bundle runtime, proposal workflow, evaluation, approval, trials, and rollback
- default workflow templates, schemas, and host-defined component ABIs

Personal evolution state is created at runtime and remains outside the installed package:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/evo/
├── log/                 session evidence
├── session-digests/     derived local metrics
├── inbox/               preference, request, and note candidates
├── bundles/             immutable personal prompts, skills, memory, and preferences
├── proposals/           candidate changes and approval records
├── reports/             local reports and model-usage journal
├── runs/                background evolution runs
├── worktrees/           isolated code candidates
└── registry/            active digest, trials, history, and rollback state
```

Durable preferences are stored in the active local bundle at `bundles/<digest>/memory/preferences.json`. User sessions, preferences, memory, bundles, reports, and generated candidates are never included in npm releases or committed back to this repository by Evo-Pi.

Project-owned instructions such as `AGENTS.md` are separate from personal evolution state and may be shared through the project's own Git repository. Add `.pi/evo-private` to a project root to disable recording for that project.

### Privacy statement

Evo-Pi has no hosted synchronization database; personal evolution state is persisted locally. Model execution still sends the current conversation and selected evidence required for a requested evolution run to the model provider chosen by the user. "Local-first" describes storage and ownership, not offline-only inference.

## Evolution loop

```text
local evidence
  → ResearchPlanner: grounded research plan and frozen experiment
  → Builder: one data, component, or isolated code candidate
  → Evaluator: independent evaluation and adversarial review
  → deterministic release policy or explicit human approval
  → reversible trial, keep, or rollback
```

Useful commands:

```text
/evo help
/evo report
/evo go <research goal>
/evo inspect
/evo list
/evo show <proposal-id>
/evo permit <proposal-id>
/evo rollback
```

Use `evo-pi-admin <command>` for non-interactive local administration and external scheduling.

## Repository packages

| Package | Purpose |
|---|---|
| [`@ch1nyzzz/evo-pi`](packages/evo-pi) | One-command product distribution and `evo-pi` entry point |
| [`@ch1nyzzz/pi-evo`](packages/evo) | Evolution engine and embedded Pi extension |
| [`@ch1nyzzz/pi-coding-agent`](packages/coding-agent) | Pi terminal coding-agent runtime and SDK |
| [`@ch1nyzzz/pi-agent-core`](packages/agent) | Agent loop and state management |
| [`@ch1nyzzz/pi-ai`](packages/ai) | Multi-provider model API |
| [`@ch1nyzzz/pi-tui`](packages/tui) | Terminal UI library |

See [`packages/evo/README.md`](packages/evo/README.md) for the complete evolution architecture, approval tiers, command reference, and current limitations.

## Development

```bash
npm install --ignore-scripts
npm run build
npm run check
./test.sh
```

Create an isolated release install outside the repository:

```bash
npm run release:local -- --out /tmp/evo-pi-release --force
/tmp/evo-pi-release/node/evo-pi --help
/tmp/evo-pi-release/node/evo-pi --version
```

## Security

Evo-Pi has the same filesystem and process permissions as the user who launches it. Extensions and coding tools can execute code. Use a container or sandbox when stronger isolation is required. Generated ordinary code candidates remain in isolated worktrees and are not automatically merged or installed.

Report vulnerabilities according to [`SECURITY.md`](SECURITY.md).

## Upstream and license

Evo-Pi is based on [Pi](https://pi.dev). The repository is licensed under the [MIT License](LICENSE).
