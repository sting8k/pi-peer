# pi-peer

Peer-to-peer chat between Pi coding-agent sessions that share a room — their Herdr workspace, or a shared folder room under Paseo. Two independently running sessions can find each other, read each other's recent history, and send each other messages.

It is symmetric, natural chat between equal agents — not RPC or task delegation to a subagent. There is no request/response correlation, no `timeoutMs`, no waiting, and no `<peer_pong>`. Three tools, nothing else.

## Features

- **`talk_to`** — send a message to another live session. Returns **delivery confirmation only**; a reply, if any, simply arrives later as a new `<peer_message>`.
- **`talk_sessions`** — list live peers, their status, and how many messages are queued for them.
- **`talk_latest`** — read a peer's most recent completed conversation events.
- **No daemon.** Peers coordinate through an atomic file mailbox in the agent directory.
- **Send-only semantics.** `talk_to` never blocks waiting for a response; the language of the conversation is handled by the agents replying with another `talk_to` in the opposite direction.
- **Never misses a message.** A busy receiver is steered mid-turn; an idle receiver is triggered with a fresh turn. A message that fails to inject is requeued, and orphaned claims are reclaimed on startup.
- **Private by default.** Thinking is never published, and no session ever reads another session's transcript.

## How it works

```
                   Herdr workspace (the "room")
    ┌────────────────┐                    ┌────────────────┐
    │  Pi session A  │                    │  Pi session B  │
    │    peer-a1b    │                    │    peer-c3d    │
    └───────┬────────┘                    └───────▲────────┘
            │                                     │
            │ talk_to(target="peer-c3d")          │ arrives as a <peer_message>
            │   = enqueue + confirm               │   user message (idle trigger)
            ▼                                     │   or steer (busy)
    ┌───────────────────────────────────────────────────────┐
    │       <agent-dir>/pi-peer/talk/<room-id>/             │
    │    sessions/   inbox/                          latest/ │
    └───────────────────────────────────────────────────────┘
            ▲                                     │
            │  B replies with talk_to to          │  B's reply is a new
            │  peer-a1b — also idle-triggered     │  <peer_message>
            │  or steered                          ▼
            └────────────────────────────────────────────────
```

Each session registers itself, heartbeats every 10 s, and polls its own mailbox. There is no central process to run. The "room" is normally just the Herdr workspace the session runs in — under Paseo, pi-peer makes one shared room per folder instead (see below), so every agent in the same folder meets there.

A message is delivered to an **idle** receiver as a normal user message (trigger behavior) and to a **busy** receiver as a steer (`deliverAs: "steer"`) straight into its running turn — regardless of who sent it. A reply is simply another `talk_to` in the opposite direction, so whichever side is idle gets triggered and whichever is busy gets steered. Nothing ever waits for a turn boundary to *lose* a message.

## Requirements

- [Pi coding agent](https://github.com/earendil-works/pi/blob/main/packages/coding-agent) and a running [Herdr](https://herdr.dev) server — both required. Two ways to give a session its identity: run pi inside a herdr pane (the pane hands it `HERDR_ENV=1`, `HERDR_PANE_ID`, `HERDR_SOCKET_PATH`), or let Paseo spawn the agent — pi-peer then sets those up itself (it just needs the `herdr` CLI on PATH and the server socket reachable).
- Optional: the [Paseo daemon](https://github.com/getpaseo/paseo), if you want to spawn agents headlessly or from other devices. The classic "pi inside a herdr pane" setup doesn't need it.
- Node 22.19+ for development (required by the Pi coding-agent SDK).

## Paseo integration

When Paseo spawns an agent, the agent only knows two things: its own id and the folder it works in — no Herdr context at all. pi-peer fills that gap:

- **One folder = one room.** The first agent in a folder creates a Herdr workspace named after it; every other agent in the same folder joins that room. (We key on the folder, not paseo's workspace id — paseo makes a fresh workspace per conversation, which would split agents that share a checkout.)
- **Every agent owns one tab**, and pi-peer remembers which tab belongs to which agent. Restart or reload an agent and it takes its tab back — same identity, same mailbox, no duplicate tabs.
- **Panes join too.** If you open pi yourself in a herdr pane inside that folder, it joins the same room — hand-run sessions and paseo agents see each other. Panes only ever join; they never create rooms.
- **Housekeeping.** On start, each agent quickly sweeps: rooms whose folder has no live paseo agent get closed, and tabs of agents deleted from paseo get removed. If the sweep can't get a trustworthy listing, it cleans nothing.
- **Degrades quietly.** If provisioning fails for any reason, pi-peer logs one line and the session simply runs without peer talk — pi starts normally either way.

### Running headless

Paseo-spawned agents need a herdr server they can reach: the `herdr` CLI on PATH and its socket at `~/.config/herdr/herdr.sock` (any open herdr window provides the socket too). On a daemon machine, run `herdr server` next to the paseo daemon.

Paseo agents inherit the daemon's environment, and service managers give you a minimal PATH — so the reliable pattern is one small wrapper script that pins PATH, starts `herdr server` if needed, then execs the paseo daemon. Save it as `~/bin/paseo-daemon.sh` (chmod +x, adjust paths):

```sh
#!/bin/sh
# Paseo daemon + herdr server launcher for service managers.
# Pin PATH: launchd/systemd units see a minimal environment, so point at
# wherever node, paseo, and herdr actually live.
export PATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
export HOME="${HOME:-$(cd ~ && pwd)}"

# Herdr headless server: needed by pi-peer's provisioning (its socket is the
# API). Idempotent — skip when any herdr instance already owns the socket
# (e.g. an open herdr window).
if [ ! -S "$HOME/.config/herdr/herdr.sock" ]; then
  nohup herdr server >>"$HOME/.local/share/herdr-server.log" 2>&1 &
fi

# No HERDR_* here on purpose: agents must self-provision via pi-peer.
exec paseo daemon start --foreground
```

macOS — `~/Library/LaunchAgents/local.paseo-daemon.plist` pointing at that script:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>local.paseo-daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-lc</string>
    <string>exec "$HOME/bin/paseo-daemon.sh"</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/paseo-daemon.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/paseo-daemon.log</string>
</dict>
</plist>
```

```sh
launchctl load ~/Library/LaunchAgents/local.paseo-daemon.plist
```

Linux — `~/.config/systemd/user/paseo-daemon.service` running the same script:

```ini
[Unit]
Description=Paseo daemon (+ herdr server)
After=default.target

[Service]
ExecStart=%h/bin/paseo-daemon.sh
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now paseo-daemon
loginctl enable-linger "$USER"   # keep it running without a login session
```

If you only need herdr (no paseo), the same units work with `ExecStart`/`ProgramArguments` pointing straight at `herdr server`. On multi-seat boxes, scope the units per user.

## Install

```sh
pi install npm:@sting8k/pi-peer
```

Or from GitHub:

```sh
pi install git:github.com/sting8k/pi-peer
```

Tools register automatically when a Pi session starts inside a Herdr pane or as a Paseo-spawned agent. Set `PI_PEER_DISABLED=1` for sessions that must not appear as peers or receive requests, and `PI_CODING_AGENT_DIR` to override the agent directory (default `~/.pi/agent`).

Migrating from the pi-roo extension, which used to bundle these tools: set `features.talk=false` in your pi-roo config, install pi-peer, then reload every Pi session. The storage namespace changed (`pi-roo/talk` → `pi-peer/talk`), so the cutover is a clean break with no dual-read migration.

## Usage

Find out who is around, then send one of them a message:

```text
tool: talk_sessions

peer-a1b  Milo   idle  (current)
peer-c3d  Coco   working  (2 queued)
peer-e5f  Luna   idle
```

```text
tool: talk_to target="peer-c3d" message="Review my auth refactor: does the session fixation fix hold?"
```

`talk_to` returns a delivery confirmation immediately — the message is queued atomically and delivered as a `<peer_message>` in `peer-c3d`'s session: it triggers a fresh turn when the peer is idle, or steers into its running turn when it is busy. `peer-c3d` can reply with `talk_to(target="peer-a1b", "...")`, which wakes or steers you back the same way.

## Tools

### `talk_sessions`

Lists live peers, one per line: `<public-id>  <name>  <status>`. The current session is marked `(current)`, and a peer with pending inbound messages shows `(N queued)`. Status is one of `idle | working | blocked | done | unknown`. Stale panes are excluded. No parameters.

A public id is `peer-` plus the last three characters of the session id; the full session id stays internal.

Each session receives a stable friendly name from a preset pet-name pool, unique within the workspace. Reloading keeps the same name. The footer shows `<Name> · <peer-id>`; peer-to-peer tools continue to target the public peer id.

### `talk_to`

Sends a message to another live session and returns **delivery confirmation only**. A peer's later reply arrives as a new `<peer_message>` user message that wakes (idle) or steers (busy) you. Do not reply merely to acknowledge unless useful.

| Name | Type | Required | Notes |
| --- | --- | --- | --- |
| `target` | string | yes | Public peer id (`peer-xxx`) or unique display name. |
| `message` | string | yes | Non-empty message text. |

There is no `timeoutMs` and no waiting: the call returns as soon as the message is durably enqueued. Because a reply is just another `talk_to` in the opposite direction, there is no `talk_reply`, no `replyTo`, no conversation id, and no request/response correlation — the agents' own turns give the conversation its structure.

### `talk_latest`

Fetches the N most recent **completed** conversation events published by a peer, oldest first.

| Name | Type | Required | Notes |
| --- | --- | --- | --- |
| `target` | string | yes | Public peer id (`peer-xxx`) or unique display name. |
| `count` | integer | no | 1–10, default 1. |

```text
tool: talk_latest target="peer-c3d" count=3
```

Each peer publishes its own bounded history (max 10 events: user, assistant text, tool calls, tool results). Inbound `<peer_message>`s appear as `user` events and `talk_to` send confirmations as `toolResult` events, so an exchange reads coherently on both sides. `talk_latest` reads only that published artifact — it never touches another session's transcript, and thinking is never published. In-progress turns are excluded and flagged in the output.

## Guarantees

| Guarantee | Rule |
| --- | --- |
| **Liveness decides delivery** | Registrations (refreshed every 10 s) are the authoritative signal. Clean shutdown fails `talk_to` immediately; a crash fails it once the registration goes stale (~1 min + two confirming checks). Dead peers cannot be listed or targeted. |
| **Durable, at-least-once mailbox** | Atomic writes (temp file + rename). Messages are claimed via a `.processing` rename and held through the turn, consumed at `agent_end`; failed injections requeue, and orphaned claims are reclaimed on reload/rebind/startup. Host-lifecycle guarantee — not proof the model consumed the message. |
| **Fair, serial delivery** | One message per poll tick, oldest first (per-runtime filename order). An idle receiver gets a fresh turn; while that turn is engaging, a burst steers into it instead of overlapping. Busy receivers are steered regardless of sender. No same-caller restriction, no batching, no routing. |
| **A reply is another `talk_to`** | No `agent_end` auto-reply, no `<peer_pong>`, no waiters. The conversation is carried by plain `<peer_message>` inbound messages. |
| **Ambiguity fails closed** | Two peers sharing a public id resolve to an error, never to a guess. |

For the full flow, invariants, and cleanup rules, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Storage

Artifacts live under `<agent-dir>/pi-peer/talk/<workspace-id>/`:

| Path | Contents |
| --- | --- |
| `sessions/` | Peer registrations, refreshed by heartbeat. |
| `inbox/` | Queued chat messages per target session. |
| `latest/` | Each peer's published history. |

Writes are atomic (temp file plus rename) and the mailbox directory is created with `0700` permissions. Artifacts of dead sessions are collected after a 24 h TTL.

## Development

```sh
npm install
npm test                  # 61 tests (5 suites)
npm run test:focused      # 55 peer tests
npm run test:integration  # 6 mocked two-peer lifecycle tests
npm run typecheck         # tsc --noEmit
```

- `pi-extension/pi-peer/` — shipped runtime: `index.ts` (entrypoint), `service.ts` (tool registration), `schemas.ts`, `herdr.ts` (workspace identity), `history.ts`, `protocol.ts` (chat envelopes), `storage.ts` (atomic persistence).
- `test/peer/` — unit tests. `test/integration/` — mocked two-peer lifecycle.
- `docs/` — architecture and decisions; see `docs/decisions/0011-standalone-pi-peer-extension.md` for the packaging decision.

Distribution is available from both npm and GitHub. The npm package is published publicly as [`@sting8k/pi-peer`](https://www.npmjs.com/package/@sting8k/pi-peer).

## Related Work

- [Pi coding agent](https://github.com/earendil-works/pi/blob/main/packages/coding-agent) — the host whose extension API this builds on.
- Herdr — the pane/workspace environment that provides session identity and peer discovery.

## License

MIT
