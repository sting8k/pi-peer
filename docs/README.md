# Docs

Operating map for the **pi-peer** repository. `AGENTS.md` and
`docs/WORKFLOW.md` carry the process; everything here is the product contract
and the proof that backs it.

## Current Product

- Standalone pi-peer extension: peer-to-peer Pi communication over a Herdr
  workspace, exposing three tools (`talk_sessions`, `talk_latest`, `talk_to`).
- Implementation: TypeScript under `pi-extension/pi-peer/`.
- Proof: `test/peer/` (unit) and `test/integration/` (mocked two-peer
  lifecycle).

## Map

- `WORKFLOW.md` — request shape, planning, judgment, validation, completion.
- `ARCHITECTURE.md` — runtime boundaries, peer chat flow, storage layout.
- `TEST_MATRIX.md` — validation matrix and commands.
- `product/` — the product contract for the extension.
- `decisions/` — lasting choices future work must inherit.
- `plans/` — one durable document per change that spans sessions.
- `patterns/encoding-invariants.md` — turning accepted rules into native
  mechanical validation.
- `templates/` — optional decision, plan, runbook, and harness-improvement
  structures.

## Validation

```sh
npm test
npm run test:integration
npm run typecheck
```

## Reading Order

1. `README.md`
2. `docs/WORKFLOW.md`
3. `docs/ARCHITECTURE.md`
4. `docs/product/overview.md`
5. `docs/TEST_MATRIX.md`

## History

Protocol v1 — the SQLite control plane, `harness-cli`, the story packets under
`docs/stories/`, and the `HARNESS_*` / `CONTEXT_RULES` / `FEATURE_INTAKE` /
`TRACE_SPEC` process documents — reached end of life on 2026-08-10 and was
removed from this tree on 2026-08-20. Git history retains all of it. It is
absent here so search and agent retrieval return current authority.
