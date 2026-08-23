# Product Docs — pi-peer

This folder is the current product contract for the standalone **pi-peer**
extension (peer-to-peer Pi communication over a Herdr workspace). It describes
only pi-peer; the pi-roo subagent/loop/advisor product is out of scope here.

## Files

- `overview.md` — purpose, user-facing model, the three tools, semantics, and
  runtime requirements.
- `docs/TEST_MATRIX.md` — validation matrix and commands for the peer-talk
  surface (kept at repo root of `docs/` alongside other Harness docs).

## Source Relationship

| Artifact | Location |
| --- | --- |
| Public entrypoint | `README.md` |
| Runtime (ships in package) | `pi-extension/pi-peer/*` |
| Executable proof | `test/peer/`, `test/integration/`, `npm test`, `npm run typecheck` |
| Decisions | `docs/decisions/0009`, `0010`, `0011` |
| Stories | `docs/stories/epics/E06-peer-talk/US-009`, `docs/stories/epics/E07-pi-peer-standalone/US-010` |

## Process

1. Product truth lives here; a change to the contract is a story.
2. Stories carry a proof plan; executable proof must pass before a story is
   done.
3. Durable decisions land in `docs/decisions/` as numbered ADRs.
4. Harness context (`docs/HARNESS.md`, `docs/CONTEXT_RULES.md`,
   `docs/HARNESS_COMPONENTS.md`) references this folder as the source of truth.

When the product contract changes, update this folder first, then the story and
the decision that captures the change.
