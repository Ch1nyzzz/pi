# Evo-Pi Sharing System — Implementation Plan & Status

Living status + plan for the shareable optimization-pack system and the host ABI
set. Design is frozen in `docs/optimization-packs.md` (the pack envelope) and
`docs/host-abis.md` (the 8 ABIs + capability broker). This document tracks what
is built, what is in progress, and what remains.

## Status at a glance

| Stage | What | State |
|---|---|---|
| S0 | Design frozen (pack.json v1 + 8-ABI blueprint) | ✅ done |
| S1 | Data packs — import skills/prompts (Milestone A) | ✅ done |
| S2 | Empty-ceiling ABIs on today's runtime | 🔨 in progress (context/v1 defined; wiring next) |
| S3 | Capability broker + `infer` | ⬜ not started |
| S4 | Thinking components (memory, tools, workflows) | ⬜ not started |
| S5 | Discovery / registry | ⬜ not started |

Implementation commits so far: `354084f0b` (blueprint) → `e7109d564` (pack
parser) → `fd7a767c5` (pack data mapping) → `07ecda36a` (Milestone A) →
`42552cc35` (context/v1 ABI). 27 tests passing across pack + context-abi suites.

---

## Completed

### S0 — Design frozen (`354084f0b`)
- `pack.json v1` envelope: contents `prompts/skills/memory/components/workflows`,
  `requiresAbis`, `requiresCapabilities`, content-addressed `integrity`.
- 8-ABI blueprint in `host-abis.md`: `tool`, `instructions`, `context`, `guard`,
  `generation`, `control`, `memory`, `workflow` (imperative). Capability broker +
  `infer`/`spawn-agent` authorization model. Staged landing roadmap.
- Tasks #8, #9, #10.

### S1 — Data packs, Milestone A (`e7109d564`, `fd7a767c5`, `07ecda36a`)
- `packages/evo/src/pack/pack.ts` — `parseEvoPackManifest` (fail-closed, path-safe)
  + content-addressed `computeEvoPackIntegrity`/`verifyEvoPackIntegrity` +
  `loadEvoPack`.
- `packages/evo/src/pack/import.ts` — `buildPackDataChanges` (skills → `skills/
  <name>/SKILL.md`, prompts → `prompts/<name>.md`) + `importPackData` (verify
  integrity → stage a reversible data proposal against stable bundle via the
  existing proposal/trial/rollback pipeline).
- **Milestone A proven end-to-end**: seed bundle → import a pack with a skill +
  prompt → data proposal staged → candidate bundle actually contains the imported
  assets; tampered pack rejected on integrity mismatch.
- Key finding: skills/prompts auto-load from the bundle `skills/`/`prompts/`
  directories, so import needs no policy edit and adds zero new security surface.
- Tasks #11, #12, #13.

### S2 (part) — `context/v1` ABI defined (`42552cc35`)
- `packages/evo/src/components/registry.ts` — `CONTEXT_V1_ABI` registered
  alongside (unchanged) `compaction/v1`. Two modes:
  - `transform` — ephemeral view rewrite `{messages,…}` → `{messages}`.
  - `checkpoint` — durable summary, byte-compatible with `compaction/v1`.
- Empty capability ceiling. 10 tests; compaction untouched (backward compatible).
- Task #14 (definition portion).

---

## In progress

### S2 #14 (rest) — wire `context/v1 transform` into the runtime
- **Goal:** at the runtime context point (each LLM call), invoke a selected
  `context/v1` transform component and use its returned messages.
- **Approach (low-risk):** read the existing `compaction` wiring in
  `packages/evo/src/bundle/runtime.ts` as the template (select from
  `policy.components`, spawn `EvoComponentProcess`, `invoke`, validate output).
  Add the `context` surface *alongside* it without touching the working
  compaction path.
- **Acceptance:** a `context/v1` transform component selected in a bundle rewrites
  the message view for a turn; compaction still works unchanged.

---

## Remaining

### S2 — rest of the empty-ceiling ABIs (no broker needed)
Each reuses the compaction/context wiring pattern; all have an empty ceiling.

- **#15 `guard/v1`** — wire `beforeToolCall`/`afterToolCall`; **session-lived**
  (state across calls for rate-limit/dedup); host re-validates patched args
  against the tool schema. Acceptance: a guard blocks/rewrites a tool call and
  post-processes its result.
- **#16 `instructions/v1`** — wire `before_agent_start.systemPrompt` (bundle
  splice exists). Input the pre-read prompt-build options; output text/sections.
- **#17 `generation/v1`** — wire the existing `message_end.message` replacement.
  Input the finalized assistant message; output `{message?, redo?}` (redo needs
  `infer`, deferred to S4).
- **#18 `control/v1`** (routing/stop) — wire `prepareNextTurn`/post-turn; output
  `{stop?, model?, reasoning?}`; output contract forbids returning `messages`
  (keeps it orthogonal to `context/v1`).
- **#19 Milestone B** — a shared `context/v1` transform component: `evo-pi
  import` → Canary trial activation → rollback. Proves the full import → sandbox
  component → activate → revert loop on the real runtime. *Blocked by #14.*

### S3 — Capability broker + `infer` (security centerpiece)
- **#20** Bidirectional RPC frame: mid-`invoke`, a component emits a
  `capability-request`; the host services + audits it and replies. Sandbox still
  unshares net and grants no ambient fs/creds.
- **#21** `infer` authorization/budget/audit model: off by default, granted at
  approval; per-component budget (calls/tokens/cost), full prompt/response log,
  optional model restriction. Design against `infer` first — the hardest case.
- **#22** Derived capabilities on the broker: `read-file`/`write-file`/`list-dir`/
  `exec`/`http-fetch`/`retrieve`/`memory-read`/`memory-write`/`spawn-agent`.
  *Blocked by #20.*

### S4 — Thinking components (on the broker)
- **#23 `memory/v1`** — full lifecycle `recall`/`encode`/`consolidate`; host owns
  the store (namespace-isolated, trial/rollback), component owns policy;
  capabilities `memory-read/write`, `retrieve`, `infer`. *Blocked by #20, #21.*
- **#24 `tool/v1`** — full fs/exec/net/infer tool class (pure-compute tools can
  precede the broker). *Blocked by #20, #21.*
- **#25 `context/v1` RAG + abstractive checkpoint** — add `retrieve`/`infer`.
- **#26 `control/v1` memory-writing** — add `memoryDeltas` + `write-memory`.
- **#27 `workflow/v1`** — imperative multi-agent orchestration component;
  `spawn-agent` capability. Highest ceiling, lands last. *Blocked by #22.*
- **#28** Import of an unregistered ABI → evo's Builder auto-writes the ABI +
  wiring as a T2 code proposal (agent writes, human approves, rebuild).

### S5 — Discovery
- **#29** Lightweight registry (git/gist convention) + provenance/signing, once
  packs are really moving between people.

---

## Critical path

```
#8 pack.json v1  ──►  S1 data import (DONE)
                 └─►  #14 context/v1 ──► #19 Milestone B
#20 broker + #21 infer  ──►  S4 all thinking components (#23 #24 #25 #26)
#22 spawn-agent  ──►  #27 workflow/v1
```

Two gating investments: `#8` (envelope, done) and `#20+#21` (broker + infer) —
before the broker, components can only run heuristics; after it, they can think.

## Deferred within completed stages

- **Structured memory merge** in data packs: pack `memory/preferences.json` is
  currently reported as `skippedMemory` (not written), because merging into
  active preferences needs schema-aware logic. Follow-up in S1/S4.
- **`evo-pi export`** and **CLI command wiring** (`evo-pi import <dir>`): the
  library function `importPackData` exists and is tested; the user-facing CLI
  command and `export` are not yet wired.
- **`generation/v1` redo** and **`context/v1` abstractive/RAG**: need `infer`/
  `retrieve`, deferred to S4.

## References
- `docs/optimization-packs.md` — pack.json v1 envelope + import flow.
- `docs/host-abis.md` — the 8 ABIs, capability broker, landing roadmap.
- Project todo (task tracker) — per-task status and dependencies.
