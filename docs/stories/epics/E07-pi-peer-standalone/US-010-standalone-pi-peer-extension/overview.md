# Overview — US-010 Standalone Pi-Peer Extension

## Prior Behavior

Peer talk lives inside the pi-roo subagent extension
(`pi-extension/subagents/talk/`), mixed with the delegation, loop, and advisor
product surfaces. Docs, stories, and decisions describe the whole pi-roo
subagent product, including `call_agents`, agent config, loop workflows, mux
spawning, and the persistent advisor. Storage uses the legacy
`pi-roo/talk/<workspace-id>/` namespace.

## Target Behavior

The repo describes and ships only the standalone **pi-peer** package:

- Runtime at `pi-extension/pi-peer/` — exactly three tools
  (`talk_sessions`, `talk_latest`, `talk_to`), no commands/renderers/widgets.
- `PI_PEER_DISABLED=1` generic opt-out at the entrypoint.
- Storage namespace `<agent-dir>/pi-peer/talk/<workspace-id>/` — clean break
  from `pi-roo/talk`, no dual-read.
- Public docs (`README.md`, `docs/product/*`, `docs/ARCHITECTURE.md`,
  `docs/TEST_MATRIX.md`) describe only pi-peer; retired product docs/stories/
  decisions are removed.
- ADR `0011` records the standalone packaging decision; story `US-010` tracks
  the extraction.

## Affected Users

- Pi users installing peer-to-peer talk between Herdr sessions (primary).
- pi-roo extension users migrating: must set `features.talk=false` before dual
  install and reload all peers.
- Future maintainers of the pi-peer package.

## Affected Product Docs

- `README.md`
- `docs/product/overview.md`
- `docs/ARCHITECTURE.md`
- `docs/TEST_MATRIX.md`
- `docs/decisions/0009`, `0010`, `0011`
- `docs/stories/epics/E06-peer-talk/US-009-session-talk.md`
- `docs/HARNESS.md`, `docs/HARNESS_COMPONENTS.md`, `docs/HARNESS_MATURITY.md`,
  `docs/CONTEXT_RULES.md`, `docs/README.md`, `docs/stories/README.md`

## Non-Goals

- No delegation, agent-config, loop, or advisor features in the standalone
  package.
- No dual-read migration between `pi-roo/talk` and `pi-peer/talk`.
- No npm publishing: the package is `private: true` and distributed from
  GitHub only (`author`/`repository`/`version` refreshed in slice 10).
- Live Herdr E2E was executed in slice 7 (two live Pi panes in one workspace)
  and the pass is recorded in this story's validation and `docs/TEST_MATRIX.md`;
  abort/session-switch/fail-closed remain mocked-only.
