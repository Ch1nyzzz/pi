# Evo-Pi Sharing System — Implementation Plan & Status

Implementation status for the shareable optimization-pack system and host ABI
set. The contracts are defined in `docs/optimization-packs.md` and
`docs/host-abis.md`.

## Status at a glance

| Stage | What | State |
|---|---|---|
| S0 | Design frozen (`pack.json` v1 + 8 host ABIs) | implemented |
| S1 | Data and code pack import/export | implemented |
| S2 | Turn-loop ABI definitions and runtime wiring | implemented |
| S3 | Capability broker, `infer`, and `spawn-agent` | implemented |
| S4 | Memory, tools, workflows, and unknown-ABI Builder | implemented |
| S5 | Signed discovery registry and install flow | implemented |

The implementation plan is complete. Verification is performed through the
repository checks and focused suites; this document does not track transient
test counts.

## Implemented stages

### S0 — Design frozen (#8, #9, #10)

- `pack.json` v1 defines prompts, skills, structured memory, components, and
  workflows in one content-addressed envelope.
- The standard sockets are `tool/v1`, `instructions/v1`, `context/v1`,
  `guard/v1`, `generation/v1`, `control/v1`, `memory/v1`, and `workflow/v1`.
- Sandboxed components receive no ambient filesystem, network, credentials, or
  subagents. All authority is explicit and host-brokered.

### S1 — Optimization-pack exchange (#11, #12, #13)

- Pack parsing is fail-closed: strict manifests, safe relative paths, regular
  files only, symlink rejection, and canonical sha256 integrity.
- Import copies referenced content into a private re-verified snapshot and
  preflights every data/code part before target artifacts or proposals exist.
- Import stages prompts, skills, and schema-aware memory merges through the
  reversible proposal/trial pipeline.
- Registered components and workflows use the same code-import path. Their
  exact capability grants are previewed before staging and persisted with the
  candidate selection.
- Unregistered ABIs are routed to the Builder as T2 host-wiring proposals.
- `evo-pi import <directory>` and `evo-pi export <directory> [name] [version]`
  expose the exchange flow without implicit activation.
- Milestone A is implemented: a prompt-and-skill pack reaches a candidate
  bundle and remains reversible.

### S2 — Turn-loop ABIs and Milestone B (#14–#19)

- The default registry contains the eight standard ABI definitions while
  retaining `compaction/v1` as a compatibility contract.
- `context/v1` supports per-turn `transform` and durable `checkpoint` modes.
  Legacy compaction continues to take precedence when both paths are selected.
- `context/v1` output is closed to the seven v1 host message roles. Components
  must map or filter extension-only roles; supporting new roles requires a new
  ABI version.
- `guard/v1` is session-lived across before/after tool hooks; rewritten
  arguments are revalidated against the host tool schema.
- `instructions/v1` transforms the built system prompt.
- `generation/v1` can replace final assistant content and `stopReason` while
  preserving host-owned message metadata, or request one bounded redo without
  duplicating the visible or persisted response.
- `control/v1` applies between-turn stop, model, and reasoning decisions.
- Milestone B is implemented: a shared `context/v1` component can be imported,
  activated as a Canary trial, and rolled back.

### S3 — Capability broker (#20, #21, #22)

- Component RPC is bidirectional: a component can issue a nested
  `capability-request` during `invoke`, and the host returns a correlated
  `capability-result`.
- The broker enforces declared ABI ceilings and exact per-artifact grants.
  Deterministic authority IDs isolate concurrently pinned exact grant sets.
  `infer` and `spawn-agent` additionally reserve and account for call, model,
  token, output, cost, and tool budgets, charging conservative reservations on
  failures without exact usage.
- Grant changes, requests, denials, reservations, results, and usage are
  append-only audited through a crash-recoverable outbox; orphaned in-flight
  reservations are reconciled and conservatively charged.
- Host services cover `read-file`, `write-file`, `list-dir`, `exec`,
  `http-fetch`, `retrieve`, `memory-read`, `memory-write`, `infer`, and
  `spawn-agent`.
- Component JSONL frames and lifetime output are bounded; failed native or
  Docker components are hard-terminated, and `exec` descendants use bounded
  process-group teardown.
- `spawn-agent` runs a real isolated Agent with a fixed host prompt, trusted
  tool allowlist, explicit model route, bounded turns/output, and abort-aware
  authentication.

### S4 — Thinking components (#23–#28)

- `memory/v1` implements `recall`, `encode`, and `consolidate` against a
  host-owned, namespace-isolated store.
- Memory state follows bundle lifecycle under one shared lock: trial creation,
  idempotent promotion, ancestor checkpoints, rollback across lineage changes,
  removal when the target omits an artifact, legacy audit-verified backfill,
  and same-digest reactivation. A durable transaction outbox keeps namespace
  pointers and lifecycle audit entries consistent across crashes.
- `tool/v1` exposes sandboxed tools through the session tool surface.
- `workflow/v1` exposes trigger-based orchestration through the bounded
  `spawn-agent` service.
- `context/v1` supports `retrieve`/`infer`; `control/v1` supports guarded
  `memoryDeltas`; `generation/v1` supports the bounded critique/redo seam.
- Unknown ABIs trigger an auto-authored T2 Builder proposal rather than
  silently widening the host boundary.

### S5 — Discovery and trusted install (#29)

- A strict local discovery config lists registry sources and trusted Ed25519
  signers.
- Registry entries are signed and bind pack identity, version, source,
  integrity, and signer provenance.
- HTTPS, git-host raw URLs, and gist sources are normalized through a bounded
  transport with a strict redirect policy plus timeout, file-count, and byte
  limits.
- Search reports trust and requirements; trusted inspection verifies the
  manifest before install.
- Install pins the inspected integrity through download and import, previews
  exact grants, and only stages proposals. It never activates a pack.
- `/evo search`, `/evo install`, `evo-pi search`, and `evo-pi install` expose
  the discovery flow.

## Acceptance invariants

- Integrity and trust are verified before staging.
- Capability grants never exceed the component declaration or ABI ceiling.
- Sandboxed code receives authority only through the audited broker.
- Data, component selection, capability grants, and memory state move together
  through trial, keep, and rollback.
- Imports and registry installs stage reviewable proposals and never activate
  code implicitly.
- Unknown host boundaries remain cold T2 changes requiring explicit review,
  rebuild, and restart.

## References

- `docs/optimization-packs.md` — pack v1 envelope, exchange, and discovery flow.
- `docs/host-abis.md` — the eight ABIs and capability broker.
