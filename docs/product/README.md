# Product Docs — pi-peer

This folder is the current product contract for the standalone **pi-peer**
extension (peer-to-peer Pi communication over a Herdr workspace). It describes
only pi-peer; the pi-roo subagent/loop/advisor product is out of scope here.

## Files

- `overview.md` — purpose, user-facing model, the three tools, semantics, and
  runtime requirements.
- `docs/TEST_MATRIX.md` — validation matrix and commands for the peer-talk
  surface.

## Source Relationship

| Artifact | Location |
| --- | --- |
| Public entrypoint | `README.md` |
| Runtime (ships in package) | `pi-extension/pi-peer/*` |
| Executable proof | `test/peer/`, `test/integration/`, `npm test`, `npm run typecheck` |
| Decisions | `docs/decisions/0009`–`0013` |
| Durable plans | `docs/plans/` (none active) |

## Process

1. Product truth lives here; executable proof must pass before a contract
   change is done.
2. Work spanning sessions gets one document in `docs/plans/active/`, moved to
   `docs/plans/completed/` only after validation.
3. Durable decisions land in `docs/decisions/` as numbered ADRs.
4. `docs/WORKFLOW.md` carries the process; it references this folder as the
   product source of truth.

When the product contract changes, update this folder first, then the proof and
the decision that captures the change.
