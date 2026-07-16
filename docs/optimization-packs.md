# Optimization Packs — a shareable contract for harness improvements

Status: **implemented v1**. Companion to `docs/host-abis.md` (the ABI sockets a
pack's components plug into).

## Goal

Let people share improvements to their Evo-Pi harness — prompts, skills, tools,
memory systems, behaviors, and multi-agent workflows — as a single
self-contained unit, the way a skill is shared, and install them with one
command:

```bash
evo-pi import ./my-optimization
```

Data-type improvements install with zero friction (they are just data, like a
skill). Code-type improvements are gated by an **automated, human-in-the-loop
approval** built on Evo-Pi's existing proposal pipeline — the agent writes any
required code; the human only approves.

## Core principles

1. **One envelope for everything.** A pack can carry prompts, skills, memory,
   and code components together, described by a single `pack.json`.
2. **Data is zero-friction; code is gated — but the agent writes the code.**
   Sharing must not require anyone to hand-write ABIs or wiring. When a pack
   needs code the local harness cannot yet host, Evo-Pi's Builder generates the
   necessary patch as a proposal; the human approves it.
3. **Community flows on standard ABIs.** Components declare a *standard* ABI from
   the set in `docs/host-abis.md` (`tool/v1`, `instructions/v1`, `context/v1`,
   `guard/v1`, `generation/v1`, `control/v1`, `memory/v1`, `workflow/v1`). Like
   USB, shared parts only interoperate against common sockets. A pack that names
   an unregistered ABI is routed to the Builder for a cold T2 host-wiring
   proposal.
4. **Trust-boundary changes get strong review; within-boundary parts get
   light review.** Adding a tool under an existing `tool/v1` does not expand the
   capability ceiling, so it can be a light Canary approval. Introducing a *new*
   ABI opens a new capability boundary and always requires explicit human
   confirmation, even though the agent authored the code.
5. **Content-addressed integrity.** Every pack and every component artifact is
   sha256-addressed; import stages only from a private, re-verified snapshot
   after the complete pack has passed preflight.

## Pack layout

```
my-optimization/
├── pack.json                 # manifest (below)
├── prompts/                  # data: system / append-system fragments (like a skill)
│   └── git-review.md
├── skills/                   # data: data-only skills (SKILL.md)
│   └── git-triage/SKILL.md
├── memory/                   # data: durable preference fragments (optional)
│   └── preferences.json
├── components/               # code: sandboxed ABI components
│   └── git-blame-summary/
│       ├── manifest.json     # evo component manifest (abi, entrypointSha256, capabilities, ...)
│       └── component.mjs     # JSONL-RPC entrypoint, runs sandboxed
└── workflows/                # code: imperative multi-agent orchestration components
    └── deep-review/
        ├── manifest.json     # abi: workflow/v1, capabilities: ["spawn-agent"]
        └── component.mjs      # imperative orchestration script, runs sandboxed
```

## `pack.json`

```json
{
  "packFormat": 1,
  "name": "better-git-workflow",
  "version": "1.0.0",
  "author": "friend-handle",
  "description": "Sharper git review prompts plus a blame-summary tool.",
  "contents": {
    "prompts": [
      { "target": "append-system", "file": "prompts/git-review.md" }
    ],
    "skills": [
      { "name": "git-triage", "dir": "skills/git-triage" }
    ],
    "memory": [
      { "file": "memory/preferences.json" }
    ],
    "components": [
      {
        "surface": "tool",
        "abi": "tool/v1",
        "id": "git-blame-summary",
        "artifact": "components/git-blame-summary",
        "capabilities": ["read-file"]
      }
    ],
    "workflows": [
      {
        "id": "deep-review",
        "trigger": "/deep-review",
        "abi": "workflow/v1",
        "artifact": "workflows/deep-review",
        "capabilities": ["spawn-agent"]
      }
    ]
  },
  "requiresAbis": ["tool/v1", "workflow/v1"],
  "requiresCapabilities": ["read-file", "spawn-agent"],
  "integrity": "sha256:<digest-of-canonical-pack>"
}
```

- `contents` lists what the pack installs, split by kind. Every field is
  optional; a data-only pack omits `components`/`workflows`.
- `workflows` are **imperative** multi-agent orchestration components (arbitrary
  scripts using `agent()`/`parallel()`/`pipeline()`), sandboxed like any
  component, implementing `workflow/v1`, and invoked by their `trigger`.
- `requiresAbis` — standard ABIs the code parts need; import checks them against
  the local ABI registry.
- `requiresCapabilities` — the union of host-brokered capabilities the pack's
  code parts request (e.g. `read-file`, `exec`, `http-fetch`, `infer`,
  `spawn-agent`). Surfaced once at import so the user sees, up front, exactly
  what powers the pack is asking the host to grant.
- `integrity` — a content digest over the canonical pack, so a pack cannot be
  silently modified in transit.

## `evo-pi import <pack>` flow

```
1. Parse pack.json, verify integrity (sha256 over canonical contents), copy all
   referenced content into a private snapshot, and verify that snapshot again.
2. Split contents into data-type and code-type, then preflight every data
   change, registered artifact, policy transition, and unknown-ABI Builder
   request before publishing an artifact or staging a target proposal.
3. Data-type (prompts / skills / memory):
     → stage as a data proposal on the existing T0/T1 path.
     → merge memory through the structured preference schema.
     → activate into the immutable bundle only after approval; remain
       reversible via trial/rollback.
4. Code-type parts (components AND workflows — same path), per part, by ABI status:
     a. ABI already registered locally (e.g. tool/v1, workflow/v1):
          → stage a component-selection proposal.
          → light human-in-the-loop: Canary trial + focused confirm.
          → HOT: no host rebuild; runs out-of-process, sandboxed.
     b. ABI not registered locally:
          → Evo-Pi's Builder auto-generates a code proposal that defines the
            ABI (an EvoAbiDefinition) and wires the host surface.
          → strong human-in-the-loop: T2 code review + explicit confirm.
          → COLD: approval leaves a staged patch; commit + rebuild + restart,
            then the part can activate via (a).
5. Any part requesting a capability the user has not granted stops at an explicit
   grant prompt (surfaced up front from `requiresCapabilities`); `infer` and
   `spawn-agent` are off by default and always require an explicit grant.
6. Every activation is reversible (trial → keep / rollback).
```

Import and registry install only stage proposals. Neither command implicitly
activates code. The unknown-ABI Builder callback runs only after full pack
preflight and before target staging; if it fails, the importer leaves no
pack-owned artifact or proposal behind.

## Export and discovery

```bash
evo-pi export <directory> [name] [version]
evo-pi search [query]
evo-pi install <name> [version]
```

- Export writes the active bundle's prompts, skills, structured memory, selected
  components, tools, and workflows as a new content-addressed v1 pack.
- Discovery reads strict local registry-source and trusted-signer configuration.
  Signed entries bind pack identity, version, source, integrity, and signer.
- Search reports provenance, trust, ABI requirements, and capability
  requirements. Search can report untrusted metadata, but untrusted entries are
  not installable.
- Install downloads through bounded HTTPS/git/gist provenance handling,
  re-verifies the inspected integrity, previews exact grants, and then runs the
  same staging path as local import.

## Approval mapping (reuses existing Evo tiers)

| Pack part | Evo tier | Human-in-the-loop | Hot / cold |
|---|---|---|---|
| prompt / skill / memory (data) | T0 / T1 | light (or standing policy) | hot |
| component on existing standard ABI | Canary trial | light: focused confirm | hot |
| new ABI + host wiring (agent-written) | T2 code | strong: explicit review of the new capability boundary | cold (rebuild) |

The key property: **the agent does the coding in every row; the human only ever
approves.** The strength of the review scales with whether the trust boundary
expands, not with who wrote the code.

## Standard ABIs (the community sockets)

The code parts of a pack plug into the standard ABI set defined in
`docs/host-abis.md`: `tool/v1`, `instructions/v1`, `context/v1` (subsumes
compaction), `guard/v1`, `generation/v1`, `control/v1`, `memory/v1`, and
`workflow/v1`. These are the "USB sockets" — defined once in the host, shared by
everyone. Extension points that require live host objects (UI renderers,
commands, shortcuts, providers, session control) are intentionally out of scope
for sandboxed packs; they stay as locally authored extensions.

## Sandbox reality

Components run in a no-network sandbox with no credentials. A pure-compute part
works directly. Anything that needs the filesystem, network, model inference, or
subagents reaches them only through a **host-brokered capability** over RPC —
never ambient. See `docs/host-abis.md` for the capability broker and its
authorization/audit model. `infer` (host-mediated model inference) and
`spawn-agent` (host-mediated subagents, used by `workflow/v1`) are the
load-bearing capabilities and are always granted explicitly at approval time.

## Implementation

The v1 envelope, local import/export, all eight host ABIs, capability broker,
memory/tool/workflow runtimes, unknown-ABI Builder path, and signed discovery
flow are implemented. `docs/implementation-plan.md` records the completed stage
and acceptance mapping.
