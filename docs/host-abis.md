# Evo-Pi Host ABIs — the evolvable, shareable component interfaces

Status: design blueprint. Companion to `docs/optimization-packs.md` (the sharing
contract). This document defines the sockets; packs are how components move
between people.

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
| `control/v1` | between-turn supervision | `{turnDigest,usage,model}` → `{stop?,model?,reasoning?}` | session | empty for routing/stop |
| `memory/v1` | the persistent memory subsystem (episodic + semantic) | `recall{query}` → `{fragments}`; `encode{turnDigest}` → `{writes,updates,forgets}`; `consolidate{candidates}` → `{merged,insights,forget}` | session | `memory-read`/`memory-write`, `retrieve`, `infer` |
| `workflow/v1` | **meta-layer**: imperative multi-agent orchestration (above the turn loop) | `run{trigger, args}` → orchestration result | invocation | `spawn-agent` (transitively `infer`/`tool`) |

`workflow/v1` is different in kind from the other seven: they replace a
data-transform point *inside* one agent's turn loop; `workflow/v1` is an
imperative script (`agent()`/`parallel()`/`pipeline()`) that orchestrates *many*
agents from *above*. It is user-invoked by a `trigger` (e.g. `/deep-review`),
runs sandboxed like any component, and reaches subagents only through the
host-brokered `spawn-agent` capability — which itself consumes `infer` and the
active tool set. It is the highest-ceiling, latest-to-land ABI.

Notes:
- **compaction** is `context/v1` in `checkpoint` mode — one policy on the
  history-view axis, byte-identical to today's `compaction/v1` contract.
- **procedural memory** (the agent's own instructions/skills) is *not* `memory/v1`;
  it is what evo already evolves into the bundle. `memory/v1` owns episodic
  (what happened) + semantic (facts/preferences) with a full write→recall→
  consolidate→forget lifecycle, so one component is a whole memory system.
- **storage vs policy split:** the host owns the memory store (persistence,
  namespace isolation, audit, trial/rollback); the component owns the policy
  (what to encode, how to score/retrieve, how to consolidate). The component
  reaches the store only through `memory-read`/`memory-write` capabilities.

## The capability broker (the load-bearing infrastructure)

Today `process-runtime.ts` is a strictly one-way host→component RPC
(`initialize/invoke/health/shutdown`). Every capability above needs a **new
bidirectional frame**: mid-`invoke`, the component emits a `capability-request`
on stdout; the host services and audits it and replies with a `capability-result`.
The sandbox still binds a read-only `/component` and unshares the network — the
component never gets ambient fs/net/creds; the host performs and audits each
brokered call.

`infer` is the highest-value and hardest capability:

- **Why it matters:** a real memory system, abstractive compaction, semantic
  tools, an LLM-judge, a fact extractor — all *think*, i.e. call a model. Without
  `infer`, every "smart" component degrades to string manipulation.
- **Why broker, not direct creds:** minimum privilege (grant "one inference", not
  "the network + my key"); components process untrusted data (conversation, tool
  output → prompt-injection surface), so a trusted-but-buggy component must not
  hold the key; the key never leaves the host and every call is audited.
- **Authorization model (to design):** `infer` is *off by default*, granted
  explicitly at approval time (like `exec`). When granted, the host enforces a
  per-component budget (calls, tokens, cost), logs every prompt/response, and may
  restrict which model the component may request. This audit/budget model is the
  single most important safety design in the system.

Grant tiers, restating the trust spectrum:
- **empty-ceiling component** → light approval (pure data, no new powers).
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

Ordered by dependency, value, and risk. Every stage before the broker ships on
today's runtime with **zero new security surface**.

**Stage 0 — freeze the design.** This doc + `optimization-packs.md`. (done)

**Stage 1 — data packs.** `pack.json` + `evo-pi import/export` for
prompts/skills/memory-data only. No components, no sandbox. Fastest path; the
community starts moving immediately. ~days.

**Stage 2 — empty-ceiling ABIs (no broker needed).** Generalize + wire, each
reusing the compaction wiring pattern (select in `policy.components` →
`validateSelection` → spawn `EvoComponentProcess` → `invoke` at the hook →
validate → apply):
1. `context/v1` — rename/generalize the existing `compaction` surface; add the
   `transform` mode. Highest value, lowest cost (mostly a rename + one mode).
2. `guard/v1` — wire `beforeToolCall`/`afterToolCall`; make it session-lived;
   add arg re-validation. Immediate safety win.
3. `instructions/v1` — wire `before_agent_start.systemPrompt` (bundle-region
   splice already exists).
4. `generation/v1` — wire the existing `message_end.message` replacement.
5. `control/v1` (routing/stop only) — wire `prepareNextTurn`/post-turn.

**Stage 3 — the capability broker + `infer`.** Add the bidirectional RPC frame
and design its authorization/budget/audit model against `infer` first; then
`read-file`/`exec`/`retrieve`/`memory-*`/`spawn-agent` fall out cheaply. This is
the security centerpiece — design before shipping any brokered ceiling.

**Stage 4 — thinking components (on the broker).**
- `memory/v1` — full lifecycle (`memory-read/write`, `retrieve`, `infer`).
- `tool/v1` — the fs/exec/net/infer tool class.
- `context/v1` RAG (`retrieve`) and abstractive checkpoint (`infer`).
- `control/v1` memory-writing variants (`memory-write`).
- `workflow/v1` — imperative multi-agent orchestration (`spawn-agent`). Highest
  ceiling; lands last because it depends on the broker plus `spawn-agent`.
- Auto-authored ABIs: when a pack needs an unregistered ABI, evo's Builder writes
  the ABI + wiring as a T2 proposal (agent writes, human approves, rebuild).

**Stage 5 — discovery.** Once packs really move between people: a lightweight
registry (even a git/gist convention) + provenance/signing.

## First runnable milestones

- **Milestone A (Stage 1):** `evo-pi import ./pack` installs a prompt + skill into
  the bundle and it shows up next session. Proves the pack envelope end-to-end
  with zero sandbox risk.
- **Milestone B (Stage 2.1):** a shared `context/v1` `transform` component (e.g. a
  heuristic token-budget pruner) imported and activated via Canary. Proves the
  full import → sandbox component → activate → rollback loop, reusing the
  compaction runtime that already works.
