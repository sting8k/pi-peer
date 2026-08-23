# Exec Plan — US-010 Standalone Pi-Peer Extension

## Goal

Ship the peer-talk runtime as a standalone **pi-peer** package on the
`pi-peer` branch (base `c27229f`), with docs/Harness context describing only
pi-peer. Extraction ends with this clean-history root commit published to
`github.com/sting8k/pi-peer` as the initial `main` release.

## Scope

In scope:

- Standalone runtime at `pi-extension/pi-peer/` (extraction done in slices
  1–2).
- Package metadata: `name: pi-peer`, `version: 1.0.0`, `author: sting8k`,
  `private: true`, `repository`/`homepage`/`bugs` → `github.com/sting8k/pi-peer`,
  `files` allowlist `pi-extension/pi-peer` (slices 1–2 extraction; slice 10
  metadata refresh).
- Docs cutover (slice 3): README, docs/product, ARCHITECTURE, TEST_MATRIX,
  GLOSSARY, docs README, HARNESS context, decisions 0009–0011, story
  US-009/US-010; retire obsolete product docs/stories/decisions.
- Verification: `npm test`, `npm run test:focused`, `npm run test:integration`,
  `npm run typecheck`, `npm pack --dry-run`, markdown link/path scan,
  `git diff --cached --check`.

Out of scope:

- Push/release of the `pi-peer` branch (local commits after independent review are allowed).
- Live new-namespace Herdr cutover execution: **done** in slice 7 (live pass
  recorded in `docs/TEST_MATRIX.md` and validation below).
- npm publishing stays out of scope (`private: true`, GitHub-only).
- Any pi-roo main merge, delegation/loop/advisor features, or dual-read
  migration.

## Risk Classification

Risk flags:

- **Public contracts** — the three tool signatures and protocol v1 are the
  public API; changing them breaks peers.
- **Existing behavior** — peer protocol, history, and abort semantics must
  survive the move byte-for-byte.
- **Data model** — storage namespace changes (`pi-roo/talk` → `pi-peer/talk`);
  chosen as a clean break, no migration code.
- **Weak proof** — no live Herdr E2E available; mocked two-peer lifecycle only.
  (Resolved in slice 7: live two-pane cutover passed; abort/session-switch/
  fail-closed remain mocked-only.)

Hard gates:

- `npm test`, `npm run test:integration`, `npm run typecheck`, `npm pack
  --dry-run`, and `git diff --check` must pass before the story is done.
- No runtime/test edits outside the extraction unless a factual mismatch is
  found and reported first.

## Work Phases

1. **Discovery** — map pi-roo talk internals, storage namespace, registration
   surface. (done)
2. **Extraction** — standalone `pi-extension/pi-peer/*`, 3-tool entrypoint,
   `PI_PEER_DISABLED` gate, namespace switch, package `files` allowlist.
   (done, slices 1–2)
3. **Docs cutover** — rewrite living docs, retire obsolete product
   docs/stories/decisions, add ADR `0011` and this story. (this slice)
4. **Verification** — full suite + pack dry-run + link/diff checks. (this
   slice)
5. **Live cutover (done)** — ran two live Pi panes in a Herdr workspace and
   confirmed talk under the new namespace, including reload re-registration.
   Pass recorded in slice 7 (see `docs/TEST_MATRIX.md` and validation below).
6. **Release: initial `main` publish — pass** — this clean-history root commit
   is the initial `main` release of `github.com/sting8k/pi-peer`. Install docs
   target `git:github.com/sting8k/pi-peer` and package metadata was refreshed
   in slice 10; npm publishing stays out of scope.

## Stop Conditions

Pause for human confirmation if:

- Product behavior is ambiguous (tool semantics, queueing, abort, history).
- Data migration or deletion risk appears (e.g. keeping dual-read, or touching
  legacy `pi-roo/talk` artifacts).
- Validation requirements need to be weakened (e.g. skipping `npm test`).
- Architecture direction changes (e.g. merging into pi-roo main instead of a
  standalone package).
