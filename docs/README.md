# Docs

Operating manual for the **pi-peer** repository: the generic Harness process
plus the product contract for the standalone pi-peer extension (peer-to-peer
Pi communication over a HerdR workspace).

## Current Project

- Product: standalone pi-peer extension. Three tools (`talk_sessions`,
  `talk_latest`, `talk_to`), no delegation/loop/advisor surfaces.
- Implementation: TypeScript under `pi-extension/pi-peer/` (7 files).
- Proof: `test/peer/` (unit) + `test/integration/` (mocked two-peer lifecycle);
  `npm test`, `npm run test:integration`, `npm run typecheck`.
- Decisions: `docs/decisions/0009`, `0010`, `0011`.
- Stories: `docs/stories/epics/E06-peer-talk/US-009` (implemented),
  `docs/stories/epics/E07-pi-peer-standalone/US-010` (in progress).

## Harness CLI Status

The `scripts/bin/harness-cli` binary is **absent** in this checkout, so durable
init/intake/story/decision/backlog/trace commands are unavailable until the
binary is restored. Harness policy docs (`docs/HARNESS.md`,
`docs/CONTEXT_RULES.md`, `docs/FEATURE_INTAKE.md`) remain the expected
contract, and this repository's validation relies on the executable proof in
`docs/TEST_MATRIX.md` (see `US-010` for the CLI-absent note).

## Main Files

### Harness rules

- `docs/HARNESS.md` — current project context, source hierarchy, validation
  ladder, and Harness rules.
- `docs/CONTEXT_RULES.md` — rules for working inside this repo.
- `docs/FEATURE_INTAKE.md` — feature intake workflow.
- `docs/TRACE_SPEC.md` — trace schema and commands.
- `docs/HARNESS_BACKLOG.md` — Harness improvement backlog.
- `docs/HARNESS_COMPONENTS.md` — Harness components and audit results.
- `docs/HARNESS_MATURITY.md` — maturity ladder.

### Product contract

- `README.md` — public entrypoint for pi-peer.
- `docs/product/overview.md` — product overview (tools, semantics, runtime).
- `docs/TEST_MATRIX.md` — validation matrix.

### Stories

- `docs/stories/README.md` — how stories work and where they live.
- `docs/stories/backlog.md` — backlog of unsliced work.
- `docs/stories/epics/E06-peer-talk/US-009-session-talk.md` — implemented peer
  talk.
- `docs/stories/epics/E07-pi-peer-standalone/US-010-standalone-pi-peer-extension/` —
  in-progress high-risk story for the standalone extraction.

### Decisions

- `docs/decisions/README.md` — decision log.
- `docs/decisions/0001`–`0006` — generic Harness decisions.
- `docs/decisions/0009-peer-session-talk.md` — peer protocol decision.
- `docs/decisions/0010-peer-talk-history-count.md` — history contract.
- `docs/decisions/0011-standalone-pi-peer-extension.md` — standalone package
  decision (supersedes packaging/eligibility/storage portions of 0009/0010).

### Data

- `harness.db` — durable harness state (when the CLI is available).

## Current State

- The pi-roo subagent/loop/advisor product is out of scope; its docs, stories,
  and decisions (`0007`, `0008`, `US-004`–`US-008`) were retired in the
  standalone docs cutover (2026-08-05, story `US-010`).
- Code, package, and tests for the standalone extraction are done; the live
  new-namespace HerdR cutover passed (slice 7). The `pi-peer` branch is not
  pushed.
- Harness CLI is absent from this checkout, so durable rows are unavailable;
  docs and story state are the source of truth until the CLI is present.

## Validation Commands

```sh
npm test
npm run test:integration
npm run typecheck
scripts/bin/harness-cli query matrix   # when CLI is available
```

## Reading Order

1. `README.md`
2. `docs/HARNESS.md`
3. `docs/FEATURE_INTAKE.md`
4. `docs/ARCHITECTURE.md`
5. `docs/CONTEXT_RULES.md`
6. `docs/product/overview.md`
7. `docs/TEST_MATRIX.md`
