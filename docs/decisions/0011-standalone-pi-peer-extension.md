# 0011 Standalone Pi-Peer Extension

Date: 2026-08-05

## Status

Accepted

Supersedes the packaging, eligibility, and storage-namespace portions of
`0009-peer-session-talk.md` and `0010-peer-talk-history-count.md`. The
protocol and history contracts in those decisions are unchanged.

## Context

Peer talk (decisions `0009`/`0010`) was originally built inside the pi-roo
subagent extension at `pi-extension/subagents/talk/`. That host bundled many
unrelated product surfaces: batch delegation (`call_agents`,
`subagents_list`, `subagent_resume`), agent configuration, loop workflows,
mux spawning, and the persistent advisor.

The peer runtime itself is self-contained — Herdr workspace identity,
filesystem mailboxes, bounded event history, and versioned send-only
message envelopes. It has no runtime dependency on any delegation, loop, or advisor
module. Packaging it inside pi-roo forced every peer session to carry the
entire subagent/loop/advisor surface just to use the talk tools, and disabling
talk still left the rest of the host extension registered.

## Decision

Extract peer talk into a dedicated standalone package, `pi-peer`:

- **Dedicated package.** The runtime lives at `pi-extension/pi-peer/` with its
  own entrypoint (`index.ts`) that registers exactly three tools
  (`talk_sessions`, `talk_latest`, `talk_to`) and nothing else — no commands,
  no renderers, no widgets.
- **No source dependency on the host.** The standalone runtime imports no
  subagent, loop, or advisor module. Its only seams are the Pi extension API
  and the Herdr environment (env vars + CLI).
- **Generic opt-out.** `PI_PEER_DISABLED=1` is the opt-out: the entrypoint
  returns before registering anything. No host feature gate is required; any
  host can use the same env var.
- **New namespace, clean-break migration.** Storage moves to
  `<agent-dir>/pi-peer/talk/<workspace-id>/` (agent-dir is
  `PI_CODING_AGENT_DIR` or `~/.pi/agent`). There is **no dual-read** of the
  legacy `pi-roo/talk` namespace: cutover is a clean break, and all peers must
  reload to re-register. This supersedes the storage path implied by `0009`/
  `0010`.
- **Standalone public repo.** The package's canonical home is the new public
  repository `github.com/sting8k/pi-peer`; this branch is the extraction seed
  it was exported from (install: `git:github.com/sting8k/pi-peer`), not a
  wholesale merge into pi-roo main. The pi-roo product line remains a
  separate concern.

## Alternatives Considered

1. **Keep talk inside pi-roo.** Rejected: every peer carries the full
   subagent/loop/advisor surface; feature gates leak into a shared runtime.
2. **Dual-read both namespaces during migration.** Rejected: adds migration
   surface and stale-artifact risk. The artifacts are rebuildable from each
   peer's own lineage, so a clean break with a reload is simpler and safe.
3. **Wholesale merge of the branch into pi-roo main.** Rejected: this is a
   standalone package with its own lifecycle; pi-roo main is a different
   product.

## Consequences

Positive:

- Independent install; peers carry only the talk runtime.
- Clean namespace isolation; no mixing with legacy `pi-roo/talk` artifacts.
- Generic `PI_PEER_DISABLED=1` opt-out works for any host.

Tradeoffs:

- Existing pi-roo users must disable talk (`features.talk=false`) before a dual
  install, and all peers must reload to re-register in the new namespace.
- The public repository `github.com/sting8k/pi-peer` is the canonical home;
  the current package metadata is public `@sting8k/pi-peer` version `2.1.0`,
  with npm and GitHub distribution.
- The live new-namespace Herdr cutover has been executed (slice 7): two live
  Pi panes in one workspace discovered each other and exchanged send-only
  `talk_to` messages (marker `PI_PEER_3WAY_OK`), with reverse discovery/read
  passes and version-2 history artifacts that never publish thinking. Proof
  is recorded in `docs/TEST_MATRIX.md` and story `US-010`; POSIX live runtime
  and full live peer-chat coverage remain unverified.

## Follow-Up

- ~~Execute a live two-session Herdr cutover in the `pi-peer/talk` namespace~~
  (story `US-010`) — **done** (slice 7, live pass recorded).
- ~~Perform the clean-history initial `main` push to `github.com/sting8k/pi-peer`~~
  — **done**: this clean-history root commit is the initial `main` release;
  install instructions target `git:github.com/sting8k/pi-peer`.
- ~~Refresh package metadata at release~~ — **done** (slice 10): metadata
  targets `sting8k/pi-peer` with public npm/GitHub distribution.
- User-facing peer identity is the public id `peer-<last 3 chars of session
  id>` (slice 8): `talk_sessions` returns it, examples lead with it, and
  target resolution accepts the public id or a unique display name, failing
  closed on ambiguous public ids. Raw full session ids and id prefixes are
  not targets. The full session id remains the internal identity for artifact
  paths, routes, inbox/reply addressing, and history correlation.
- ~~Verify the public-id format with two live peers~~ (slice 9) — **done**: live
  discovery by public id, `talk_latest`/`talk_to` by public id, inbound
  `peer_id` match, raw-id rejection, and full-session-id-keyed artifacts all
  passed (see `US-010` validation).
