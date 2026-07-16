# Evo-Pi Host ABIs — the evolvable, shareable component interfaces

Status: **implemented v1**. Companion to `docs/optimization-packs.md` (the
sharing contract). This document defines the sockets; packs are how components
move between people.

## What an ABI is, and how it relates to extensions

Three layers, from most-trusted to most-shareable:

```
ExtensionAPI            host's full extension surface — full permissions
  └── evo extension     one privileged extension; uses hooks to schedule components
        └── ABI components   sandboxed, content-addressed, evolvable & shareable
```

- An **extension** is a same-process TS module with full permissions (fs, net,
  creds, live TUI, session control). Great for personal/trusted customization;
  **not safely shareable**.
- An **ABI component** is an out-of-process, sandboxed, JSONL-RPC artifact that
  implements one host-defined ABI. Pure data in/out (plus host-brokered
  capabilities). Evo can evolve it; friends can share it.
- Every ABI is the **safe, shareable subset** of an ExtensionAPI extension
  point. Its host wiring lives *inside* the evo extension (e.g. `compaction` is
  wired at the `session_before_compact` hook in `bundle/runtime.ts`). Extension
  points that need live host objects (UI renderers, commands, providers,
  session control) never become ABIs.

## Design principle

An ABI carves the harness along an **essential data-transform point of the agent
loop**, never along a feature. The model conditions on exactly three channels
(system prompt, message history, tool set); two more points carry data the loop
reads back (the tool-call boundary, the between-turn supervisor); plus generation
output and the persistent memory subsystem. That is the whole set.

Test for "does this deserve an ABI": *does a component here take JSON in and
return JSON the loop acts on?* If it only observes, it stays on the event bus. If
it must hold a live host object, it stays a native extension.

## The ABI set (8)

Seven ABIs carve the single-agent **turn loop**; the eighth (`workflow/v1`) sits
one layer above it, orchestrating multiple agents.

| ABI | Essential axis | In → Out | Activation | Capabilities |
|---|---|---|---|---|
| `tool/v1` | a callable the LLM can invoke | `invoke{params}` → `AgentToolResult` | session | empty default; `read-file`/`write-file`/`list-dir`/`exec`/`http-fetch`/`infer` |
| `instructions/v1` | the standing frame (system prompt) | `BuildSystemPromptOptions`-shaped record → `{systemPrompt}` or `{sections[]}` | turn | empty; optional `read-file`, consumes memory recall |
| `context/v1` | the conversation view the model reads | `transform`: `{messages,…}` → `{messages}`; `checkpoint` (== today's compaction): `{conversation,…}` → `{summary,firstKeptEntryId,…}` | session | empty for prune/redact; `retrieve`/`infer` for RAG & abstractive summary |
| `guard/v1` | the boundary every tool call crosses | `before{toolName,args}` → `{block?,args?}` (host re-validates); `after{result}` → `{content?,isError?,terminate?}` | **session** (state across calls) | empty |
| `generation/v1` | the assistant message just produced | `{message}` → `{message?,redo?,stopReason?}` | turn | empty; `infer` for critique/redo |
| `control/v1` | between-turn supervision | `{turnIndex,message,toolResults,usage?,model?,reasoning?}` → `{stop?,model?,reasoning?,memoryDeltas?}` | session | empty for routing/stop; `memory-write` for deltas |
| `memory/v1` | the persistent memory subsystem (episodic + semantic) | `recall{query}` → `{fragments}`; `encode{turnDigest}` → `{writes,updates,forgets}`; `consolidate{candidates}` → `{merged,insights,forget}` | session | `memory-read`/`memory-write`, `retrieve`, `infer` |
| `workflow/v1` | **meta-layer**: imperative multi-agent orchestration (above the turn loop) | `run{trigger, args}` → orchestration result | invocation | `spawn-agent` with bounded model/tools; `memory-read`/`memory-write` for persistent workflow state (goals, progress) across invocations |

`workflow/v1` is different in kind from the other seven: they replace a
data-transform point *inside* one agent's turn loop; `workflow/v1` is an
imperative script (`agent()`/`parallel()`/`pipeline()`) that orchestrates *many*
agents from *above*. It is user-invoked by a `trigger` (e.g. `/deep-review`),
runs sandboxed like any component, and reaches subagents only through the
host-brokered `spawn-agent` capability. The host constrains the model, turns,
output, and trusted tool allowlist. It is the highest-ceiling ABI and landed
last.

Notes:
- **compaction** is `context/v1` in `checkpoint` mode — one policy on the
  history-view axis, byte-identical to today's `compaction/v1` contract.
- **context roles are closed in v1:** transformed output may contain only
  `user`, `assistant`, `toolResult`, `bashExecution`, `custom`,
  `branchSummary`, and `compactionSummary`. A component must map or filter
  extension-only roles; adding another pass-through role requires a new ABI
  version.
- **generation replacement is bounded:** a component may replace text/thinking
  content and `stopReason`; the host preserves provider, model, usage, IDs,
  diagnostics, errors, and timestamp. Generated tool calls are forbidden.
- **procedural memory** (the agent's own instructions/skills) is *not* `memory/v1`;
  it is what evo already evolves into the bundle. `memory/v1` owns episodic
  (what happened) + semantic (facts/preferences) with a full write→recall→
  consolidate→forget lifecycle, so one component is a whole memory system.
- **storage vs policy split:** the host owns the memory store (persistence,
  namespace isolation, audit, trial/rollback); the component owns the policy
  (what to encode, how to score/retrieve, how to consolidate). The component
  reaches the store only through `memory-read`/`memory-write` capabilities.

## The capability broker (the load-bearing infrastructure)

`process-runtime.ts` supports bidirectional RPC. Mid-`invoke`, a component can
emit a correlated `capability-request`; the host authorizes, services, and
audits it, then replies with a `capability-result`. The sandbox still binds a
read-only `/component` and unshares the network — the component never gets
ambient fs/net/creds; the host performs and audits each brokered call. JSONL
frames and aggregate process output are byte-bounded, concurrent capability
requests are capped, and protocol failure tears down the complete execution
with bounded TERM→KILL escalation. Native and bwrap launches use process-group
signals; Docker fallback uses a unique container identity plus daemon-side
kill, wait, and forced removal.

`infer` is the highest-value and hardest capability:

- **Why it matters:** a real memory system, abstractive compaction, semantic
  tools, an LLM-judge, a fact extractor — all *think*, i.e. call a model. Without
  `infer`, every "smart" component degrades to string manipulation.
- **Why broker, not direct creds:** minimum privilege (grant "one inference", not
  "the network + my key"); components process untrusted data (conversation, tool
  output → prompt-injection surface), so a trusted-but-buggy component must not
  hold the key; the key never leaves the host and every call is audited.
- **Authorization model:** every capability requires a per-component grant.
  Import derives the exact grants (with default budgets) from the pack's
  declared capabilities and previews them before staging; whether staging also
  requires interactive confirmation is controlled by the Evo control config
  `grants.approval` (`"auto"`, the default, stages the previewed grants without
  prompting; `"prompt"` requires explicit confirmation). The selected artifact
  is bound to those grants. A deterministic authority ID binds the artifact
  digest to its exact canonical grant set, so concurrently pinned sessions
  cannot overwrite one another's authority.
- **Budget model:** the broker reserves and accounts for calls, input/output/
  total tokens, cost, output per call, allowed models, and the `spawn-agent`
  tool allowlist. Successful budgeted services must report usage within their
  reservation; failures without exact usage are charged the full reservation.
- **Audit model:** grant changes, requests, denials, reservations, results, and
  usage are written to the append-only capability audit.

The `exec` service accepts only configured absolute-command aliases and granted
working roots, strips the ambient environment, bounds time and output, and
terminates the full POSIX process group. It is unavailable where process-tree
teardown cannot be guaranteed.

Grant tiers, restating the trust spectrum:
- **empty-ceiling component** → light approval (pure compute, no new powers).
- **brokered-capability component** → you explicitly grant each capability at
  approval; the host mediates and audits it.
- **full trust** → write a normal extension instead (not sandboxed).

## Relationship to optimization packs

A pack (`docs/optimization-packs.md`) carries data-type parts (prompts/skills/
memory-data, zero-friction) and code-type parts (components implementing an ABI
above). `evo-pi import` routes each part: data → bundle via T0/T1; component on a
registered ABI → Canary trial; component needing an unregistered ABI → evo's
Builder auto-writes the ABI + wiring as a T2 code proposal (agent writes, human
approves, rebuild).

## Landing roadmap

Implemented in dependency order. The pre-broker stages landed without granting
sandboxed components ambient authority.

**Stage 0 — freeze the design (implemented).** This doc +
`optimization-packs.md`.

**Stage 1 — data packs (implemented).** `pack.json` + `evo-pi import/export` for
prompts/skills/memory-data only. No components, no sandbox. This established
the first community exchange path.

**Stage 2 — initial empty-ceiling ABIs (implemented).** Generalize + wire, each
reusing the compaction wiring pattern (select in `policy.components` →
`validateSelection` → spawn `EvoComponentProcess` → `invoke` at the hook →
validate → apply):
1. `context/v1` — rename/generalize the existing `compaction` surface; add the
   `transform` mode. Highest value, lowest cost (mostly a rename + one mode).
2. `guard/v1` — wire `beforeToolCall`/`afterToolCall`; make it session-lived;
   add arg re-validation. Immediate safety win.
3. `instructions/v1` — wire `before_agent_start.systemPrompt` (bundle-region
   splice already exists).
4. `generation/v1` — safely replace `message_end` content and `stopReason`
   while preserving host-owned message metadata.
5. `control/v1` (routing/stop only) — wire `prepareNextTurn`/post-turn.

**Stage 3 — the capability broker + `infer` (implemented).** The bidirectional
RPC frame, exact grants, reservation/accounting model, audit log, derived host
services, and bounded `spawn-agent` host form the security boundary.

**Stage 4 — thinking components (implemented).**
- `memory/v1` — full lifecycle (`memory-read/write`, `retrieve`, `infer`).
- `tool/v1` — the fs/exec/net/infer tool class.
- `context/v1` RAG (`retrieve`) and abstractive checkpoint (`infer`).
- `control/v1` memory-writing variants (`memory-write`).
- `workflow/v1` — imperative multi-agent orchestration (`spawn-agent`). Highest
  ceiling; landed last because it depends on the broker plus `spawn-agent`.
- Auto-authored ABIs: when a pack needs an unregistered ABI, evo's Builder writes
  the ABI + wiring as a T2 proposal (agent writes, human approves, rebuild).

**Stage 5 — discovery (implemented).** Strict registry configuration, signed
entries, trusted inspection/install, git/gist/HTTPS provenance, bounded
transport, and search/install commands.

## First runnable milestones

- **Milestone A (Stage 1, implemented):** `evo-pi import ./pack` stages a prompt
  and skill; after approval, the candidate bundle supplies them next session.
  This proves the pack envelope end-to-end with zero sandbox risk.
- **Milestone B (Stage 2.1, implemented):** a shared `context/v1` `transform`
  component is imported and activated via Canary. This proves the full import →
  sandbox component → activate → rollback loop.
