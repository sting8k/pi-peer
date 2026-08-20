# Execution Plan: pi-peer hardening + Herdr pane label

Date: 2026-08-19

## Status

Complete — 2026-08-20

## Outcome

1. A queued peer message is never silently deleted or silently duplicated because of a
   transient file-system error or a slow host turn.
2. A peer's own transcript history is never silently dropped because one JSONL line in the
   session file is unparsable.
3. A pane split in Herdr shows the peer's display name on the pane border, without
   overwriting a label the user set by hand.

## Context

- Review source: two independent read-only reviews (19 findings) plus a third
  confirmation pass using `srcwalk` and `ast-grep`. 5 findings were rejected as false
  positives, 2 had correct symptoms but wrong stated mechanism. Only confirmed items are
  in this plan; the rejected ones are recorded in `## Decisions` so they are not
  re-litigated.
- Behaviour authority already in the repo:
  - `docs/decisions/0012-*`, `docs/decisions/0013-*` — delivery-once and
    "never requeue into a live host".
  - `docs/patterns/encoding-invariants.md`.
  - `pi-extension/pi-peer/service.ts:290-302` — the comment block that defines when a
    pending claim may be committed.
- Reference only, **must not be edited**: `../pi/`, `../herdr/`.
- Verified Herdr CLI behaviour used by Task 7 (run against a live instance):
  - `herdr pane get <pane_id>` returns `result.pane.label` only when a manual label is
    set; the key is absent otherwise.
  - `herdr pane rename <pane_id> <label>` returns `result.pane.label` and only trims the
    label; it does not truncate or otherwise normalise it.
  - `herdr pane rename <pane_id> --clear` removes the label.
  - The CLI writes a single line of pure JSON to stderr on failure, even under
    `RUST_LOG=debug`.

## Scope

In scope:

- `pi-extension/pi-peer/storage.ts`
- `pi-extension/pi-peer/service.ts`
- `pi-extension/pi-peer/history.ts`
- `pi-extension/pi-peer/protocol.ts`
- `pi-extension/pi-peer/herdr.ts`
- `test/peer/*.test.ts`

Out of scope:

- Any change under `../pi/` or `../herdr/`.
- Renaming or re-ordering existing exports.
- Reworking the delivery state machine beyond the single gap in Task 2.
- Changing `PeerRecord.schemaVersion`.

## Approach

Seven independent tasks, ordered by severity. Each task is self-contained: implement it,
add its tests, run `npm run typecheck && npm run test:focused`, then move on. Do not batch
all seven and validate once.

Every task below gives the current code verbatim. Re-read the file before editing — line
numbers may shift as earlier tasks land. Anchor on the code text, not the line number.

---

### Task 1 — `readJson` must not report an I/O failure as "corrupt" (P0)

**Problem.** `readJson` collapses every failure into `null`. Its only destructive caller
treats `null` as "malformed, delete it". A transient `EBUSY` / `EPERM` / `EACCES` (Windows
AV scan, indexer, concurrent writer) therefore deletes a valid queued message with no log
and no recovery path.

`pi-extension/pi-peer/storage.ts:24-30`:

```ts
export function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}
```

`pi-extension/pi-peer/service.ts:461-466` (inside `drainInbox`):

```ts
      const message = readJson(path);
      if (!isPeerMessage(message) || message.to !== current.record.sessionId) {
        // Malformed or misaddressed: cannot be delivered. There is no reply
        // surface anymore, so drop it rather than block a valid sibling.
        rmSync(path, { force: true });
        continue;
      }
```

**Change.**

1. In `storage.ts`, keep `readJson` exactly as it is (5 other callers depend on the
   `null`-means-unusable contract and none of them delete). Add a second, narrower export
   next to it:

   ```ts
   /**
    * Read JSON, distinguishing an unusable *file* from an unusable *read*.
    *
    * `readJson` collapses both into `null`, which is right for callers that only
    * need a value and wrong for callers that delete on failure: a transient
    * `EBUSY`/`EPERM`/`EACCES` (Windows AV, indexer, concurrent writer) is not
    * evidence that the file is corrupt. Callers that destroy data must use this.
    */
   export function readJsonChecked(path: string): { ok: true; value: unknown } | { ok: false; retryable: boolean } {
   ```

   - `ENOENT` → `{ ok: false, retryable: false }` (the file is gone; nothing to keep).
   - `SyntaxError` from `JSON.parse` → `{ ok: false, retryable: false }` (genuinely
     corrupt).
   - any other error → `{ ok: false, retryable: true }`.
   - success → `{ ok: true, value }`.

   Classify by `error.code` for the fs errors and by `error instanceof SyntaxError` for
   the parse error. Do not enumerate a Windows-only allowlist of codes: default to
   `retryable: true` for anything that is not `ENOENT` and not a `SyntaxError`, so an
   unknown code fails safe (keeps the file).

2. In `drainInbox`, use it:

   ```ts
      const read = readJsonChecked(path);
      if (!read.ok) {
        // A transient read failure is not evidence the message is corrupt.
        // Leave it queued and let a later tick retry; deleting here loses it.
        if (read.retryable) continue;
        rmSync(path, { force: true });
        continue;
      }
      const message = read.value;
      if (!isPeerMessage(message) || message.to !== current.record.sessionId) {
        rmSync(path, { force: true });
        continue;
      }
   ```

   Keep the existing comment about malformed/misaddressed on the second branch.

**Do not** change `ensureRecord`, `removeOwnedRecord`, `loadRecords`, `readHistory` or the
`record` lambda in `bindRuntime`. They were checked with
`srcwalk trace callers readJson --scope pi-extension`: none of them delete on `null`.
`removeOwnedRecord` is guarded by `isPeerRecord(current) && current.registrationId === ...`
so `null` is already inert there.

3. Guard both `rmSync` calls in `drainInbox` (added 2026-08-19, see below):

   ```ts
        // A corrupt entry that cannot be removed must not block the queue: the
        // tick would throw on the same entry forever and starve every message
        // behind it.
        try {
          rmSync(path, { force: true });
        } catch {
          // fall through: skip it this tick
        }
        continue;
   ```

   This applies to the non-retryable branch **and** the malformed/misaddressed branch.
   `force: true` only suppresses `ENOENT`; `EISDIR`, `EPERM` and `EBUSY` still throw, and
   the tick's `try/catch` at `service.ts:576-590` logs and returns, so the next tick fails
   on the same entry. That is a permanent head-of-line block on the whole inbox.

**Tests** (`test/peer/peer-talk.test.ts`, near the other storage tests):

- `readJsonChecked` returns `retryable: false` for a file containing `"{not json"`.
- `readJsonChecked` returns `retryable: false` for a missing path.
- `readJsonChecked` returns `ok: true` for a valid JSON file.
- `drainInbox` keeps the `.json` file when the read is retryable **and still drains the
  entry behind it**. Drive this through the existing standalone harness in
  `test/peer/standalone.test.ts`: make the inbox entry a **directory** named
  `msg-trap.json`. `readFileSync` on a directory throws `EISDIR` — neither `ENOENT` nor
  `SyntaxError` — so the entry must survive the tick.

  **The `existsSync(trap) === true` assertion alone is not a valid proof.** Verified by
  mutation on 2026-08-19: with the fix reverted the test still passed, because
  `rmSync(dir, { force: true })` throws `ERR_FS_EISDIR`, so the old code also failed to
  delete the directory. The test must therefore also write a valid `msg-valid.json`
  (`isPeerMessage`-shaped, `to === sessionId`) into the same inbox. `drainInbox` sorts with
  `localeCompare`, so `msg-trap.json` is processed first; the old code throws there on
  every tick and the valid sibling is never delivered. Assert `sentMessages.length === 1`.
- `drainInbox` still deletes a genuinely malformed `.json` file (regression guard for the
  existing behaviour).

**Mutation check required before commit.** Revert the `drainInbox` hunk, run the test, and
confirm it goes **red**; restore the hunk and confirm it goes green. A test that passes
against the unfixed code proves nothing.

---

### Task 2 — an expired claim whose turn did start must not be redelivered (P0)

**Problem.** `TURN_START_TIMEOUT_MS = 10_000` (`service.ts:82`). If the host takes longer
than that to emit `agent_start` — the documented case is compaction running an LLM
summarisation before the turn — `expireTurnStartLatch` marks the claim `expired` and
releases the latch. When `agent_start` finally arrives, `commitTriggeredDeliveries` skips
every `expired` claim, so the `.processing` file is never added to `inFlightClaims` and
never removed at `agent_settled`. At the next `session_start` it is requeued and the
message runs a **second** time.

The skip is deliberate — `service.ts:296-302` says an expired claim "belongs to an earlier
turn the host never engaged". The bug is that this assumption is only true when no turn
follows. It is false for the first `agent_start` that arrives after the deadline.

`service.ts:316-322`:

```ts
  const commitTriggeredDeliveries = (): void => {
    for (const [processingPath, pending] of [...pendingDeliveries]) {
      if (pending.steer || pending.expired) continue;
      takePendingDelivery(processingPath);
      commitPendingDelivery(processingPath, pending);
    }
  };
```

**Change.** Adopt an expired non-steer claim **only** on the first `agent_start` after it
expired, and only if no unexpired non-steer claim is a better match.

1. Add a module-scope helper inside `registerTalkTools`, next to
   `commitTriggeredDeliveries`:

   ```ts
   // A claim that expired only because the host was slow (compaction can hold a
   // turn past the deadline) is still the injection this turn was started for.
   // Adopting it here is what keeps agent_settled from leaking the claim to disk,
   // where session_start would requeue an already-processed message. An unexpired
   // claim always wins: it is the unambiguous trigger for this turn.
   const commitTriggeredDeliveries = (): void => {
     const entries = [...pendingDeliveries].filter(([, pending]) => !pending.steer);
     const fresh = entries.filter(([, pending]) => !pending.expired);
     const chosen = fresh.length > 0 ? fresh : entries.slice(0, 1);
     for (const [processingPath, pending] of chosen) {
       takePendingDelivery(processingPath);
       commitPendingDelivery(processingPath, pending);
     }
   };
   ```

   `pendingDeliveries` is a `Map`, so `[...pendingDeliveries]` preserves insertion order
   and `entries.slice(0, 1)` is the oldest expired non-steer claim — FIFO, matching the
   inbox sort order.

2. Update the comment block at `service.ts:296-302` so it states the new rule. The
   existing wording claims expired claims are always left for `session_start` recovery;
   that is no longer true.

**Explicitly preserved invariants.** Do not touch `expireTurnStartLatch`: the claim must
still stay pending (not requeued) when no `agent_start` ever arrives — that is ADR 0013
and `standalone.test.ts:225` asserts it.

**Tests** (`test/peer/delivery-once.test.ts`):

- New: `BUG#6 agent_start after the turn-start deadline commits the claim exactly once`.
  Build the runtime with `deliveryAckTimeoutMs: 5` (the dep already exists,
  `service.ts:235-240`), inject one non-steer message, `await` past the deadline so
  `expireTurnStartLatch` runs, then emit `agent_start` followed by `agent_settled`. Assert
  the `.processing` file no longer exists and no `.json` twin was recreated.
- New: `an expired claim with no following agent_start still survives for session_start`.
  Same setup but never emit `agent_start`; assert the `.processing` file still exists.
  This pins the ADR 0013 half of the contract.
- The existing `standalone.test.ts:225` test must still pass unchanged.

---

### Task 3 — one bad JSONL line must not erase the whole published history (P1)

**Problem.** `getNewEntries` maps `JSON.parse` over every line. One unparsable line throws,
and the only caller swallows it:

`pi-extension/pi-peer/history.ts:229-233`:

```ts
export function getNewEntries(sessionFile: string, afterLine: number): SessionEntry[] {
  const raw = readFileSync(sessionFile, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim());
  return lines.slice(afterLine).map((line) => JSON.parse(line) as SessionEntry);
}
```

`pi-extension/pi-peer/history.ts:259-269`:

```ts
export function publishHistoryFromOwnSession(runtime: HistoryRuntime, ctx: any): void {
  const sessionFile = ctx.sessionManager?.getSessionFile?.();
  if (typeof sessionFile !== "string" || !sessionFile) return;
  try {
    const entries = getCurrentLineageEntries(getNewEntries(sessionFile, 0));
    const events = entriesToTalkEvents(entries);
    publishHistory(runtime, events);
  } catch {
    // A missing or incomplete local session file must not block peer registration.
  }
}
```

Net effect: a single truncated trailing line — the normal state of a JSONL file that is
being appended to, or the result of a crash mid-write — makes `talk_latest` return nothing
for that peer, with no diagnostic.

Two triggering inputs, both verified:

- A trailing partial line: `JSON.parse` throws `SyntaxError`.
- A UTF-8 BOM: `JSON.parse("\uFEFF{...}")` throws. Note the mechanism precisely —
  `String.prototype.trim()` **does** strip `U+FEFF` (it is in the spec's `WhiteSpace`
  production), but the code only trims inside `.filter(...)` and then parses the
  **untrimmed** `line`, so the BOM survives into `JSON.parse`.

**Change.**

```ts
export function getNewEntries(sessionFile: string, afterLine: number): SessionEntry[] {
  const raw = readFileSync(sessionFile, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim());
  const entries: SessionEntry[] = [];
  for (const line of lines.slice(afterLine)) {
    // A session file is appended to while it is read, so the trailing line can be
    // a partial write, and an editor can leave a BOM on the first line. Skipping
    // the unusable line keeps the rest of the transcript publishable; failing the
    // whole read makes talk_latest silently empty.
    try {
      entries.push(JSON.parse(line.trim()) as SessionEntry);
    } catch {
      continue;
    }
  }
  return entries;
}
```

`line.trim()` is what removes the BOM; the `try` is what contains the partial line. Both
are required.

**Do not** widen the `catch {}` in `publishHistoryFromOwnSession` or add logging there —
it is intentional and covered by existing tests.

**Tests** (`test/peer/peer-talk.test.ts`, in the history describe block):

- A session file whose last line is truncated still yields every complete earlier entry.
- A session file whose first line carries a BOM still parses that first entry.
- A file of only unparsable lines yields `[]` rather than throwing.
- Existing history tests must pass unchanged.

---

### Task 4 — `readdirSync` after `existsSync` must not throw (P1)

**Problem.** Two check-then-use pairs. The directory can be removed between the two calls
by `sweepDeadSessions` or by a peer shutting down.

`service.ts:202-208`:

```ts
function inboxCount(root: string, sessionId: string): number {
  const dir = inboxDir(root, sessionId);
  if (!existsSync(dir)) return 0;
  // Count only still-queued `.json` messages. In-flight `.processing` claims
  // are already injected into the current turn, so they are not "queued".
  return readdirSync(dir).filter((name) => name.endsWith(".json")).length;
}
```

`service.ts:453-456` (inside `drainInbox`) — the same pattern, and the more serious of the
two, because an exception here escapes into the delivery tick rather than into a single
tool call:

```ts
    if (!existsSync(dir)) return;
    const pending = readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort((left, right) => left.localeCompare(right));
```

**Change.** Add one shared helper near `inboxCount` and use it in both places:

```ts
/**
 * List a directory that another process may delete concurrently
 * (`sweepDeadSessions`, peer shutdown). The existsSync guard cannot close that
 * window, so absence is a normal result, not an error.
 */
function listDirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
```

`inboxCount` becomes `return listDirSafe(dir).filter(...).length;` and `drainInbox` becomes
`const pending = listDirSafe(dir).filter(...).sort(...)`. Keep the `existsSync` early
returns — they are still the cheap common path — and keep both comments.

**Tests** (`test/peer/standalone.test.ts`):

- `inboxCount` returns `0` for a path that does not exist.
- A delivery tick against a missing inbox directory does not throw.

---

### Task 5 — `sealPeerMessageBody` must defang all spellings of the tag (P1)

**Problem.** The seal is literal and lowercase-only, so a sender can emit
`</PEER_MESSAGE>` or `</peer_message >` and close the wrapper early, then forge a second
`<peer_message from="..." peer_id="...">` header attributed to another peer.

`pi-extension/pi-peer/protocol.ts:425-427`:

```ts
function sealPeerMessageBody(body: string): string {
  return body.replaceAll("</peer_message>", "&lt;/peer_message&gt;").replaceAll("<peer_message", "&lt;peer_message");
}
```

**Change.**

```ts
function sealPeerMessageBody(body: string): string {
  // Case- and whitespace-tolerant: the receiving agent reads the wrapper as
  // markup, so any spelling a reader would accept as a tag must be defanged, not
  // only the exact bytes this module emits.
  return body
    .replace(/<\s*\/\s*peer_message\s*>/gi, "&lt;/peer_message&gt;")
    .replace(/<\s*peer_message(?=[\s>/]|$)/gi, "&lt;peer_message");
}
```

The lookahead keeps `<peer_messages_are_fun` untouched while still catching
`<peer_message`, `<peer_message>`, `<peer_message\n` and `<peer_message/>`.

**Tests** (`test/peer/peer-talk.test.ts` — extend the existing
`"neutralizes peer_message delimiters in the body so a sender cannot forge ..."` test
rather than adding a new one): assert `</PEER_MESSAGE>`, `</peer_message >`,
`< /peer_message>` and `<PEER_MESSAGE ` are all escaped, and assert a benign token such as
`<peer_messages>` is left alone.

---

### Task 6 — small hardening (P2)

Three independent one-liners. Each needs a test.

**6a. `resolveTarget` display-name match is case-sensitive.** `PEER_NAME_POOL` is
TitleCase (`"Zhang"`, `"Gizmo"`) but Herdr renders agent names in lowercase, so an agent
that reads a name off the Herdr UI and calls `talk_to({ target: "zhang" })` gets
`Peer session not found: zhang`.

`protocol.ts:360-368`. After the existing exact-name block and before the final `throw`,
add a case-insensitive pass that keeps the same fail-closed semantics:

```ts
  const folded = target.toLowerCase();
  const looseName = records.filter((record) => record.name.toLowerCase() === folded);
  if (looseName.length === 1) return looseName[0];
  if (looseName.length > 1) throw new Error(`Peer name is ambiguous: ${target}`);
```

Exact match must still be attempted first so an exact hit can never be turned into an
ambiguity error. Do not make the public-peer-id comparison case-insensitive — that id is
generated, not typed from a UI.

Test: extend `"resolves public peer ids and unique display names while rejecting raw ids
and prefixes"` with a TitleCase record resolved by a lowercase target, and add a case where
two records differ only by case so the ambiguity throw is covered.

**6b. `withRegistrationLock` releases the lock before an async action settles.**

`protocol.ts:166-168`:

```ts
  try {
    return action();
  } finally {
```

`return action()` is not awaited, so a `Promise`-returning action would let `finally` delete
the lock directory immediately. This is **latent**, not live: the signature is
`action: () => T` and `srcwalk trace callers withRegistrationLock` shows exactly one
caller, `service.ts:515`, which passes a synchronous lambda (confirmed with
`ast-grep -p 'withRegistrationLock($ROOT, async $$$)'` → no match). Fix the trap now so a
later async caller cannot silently break mutual exclusion:

- widen the signature to `action: () => T | Promise<T>`;
- change the body to `return await action();`.

Test: call `withRegistrationLock` with an async action that resolves after a tick, and
assert the lock directory still exists while the action is in flight and is gone after it
resolves.

**6c. `executeTalkTo` ignores an abort that lands during `liveRecords`.** After the
`await liveRecords(...)` in `service.ts:127-140`, add `signal?.throwIfAborted?.();` before
the `writeAtomic` so an aborted call does not still enqueue into a peer's inbox.

Test: abort the signal before the write and assert no file appears in the target inbox.

---

### Task 7 — pane border title via agent metadata (P2)

**Problem.** In Herdr a split shows a border title per pane. That title comes from
`Terminal::border_label()` (`herdr/src/terminal/state.rs:2112`), whose chain is
`effective_title → manual_label → (agent labels, if enabled)`. It does **not** read
`agent_name`. pi-peer only sets `agent_name` (via `herdr agent rename`) and the tab label
(via `herdr tab rename`, gated to `paneCount === 1`), so after a split neither pane shows
the peer name.

**Do not write `manual_label`.** `herdr pane rename` writes the same field the user writes
when renaming a pane by hand, so pi-peer would fight the user for one slot and would need
an ownership rule to arbitrate. Every ownership scheme considered failed or added state
with its own lifecycle (see `## Decisions`).

**Use the metadata title slot instead.** `herdr pane report-metadata` writes
`effective_title`, a **separate** field that outranks `manual_label` on the border. Herdr
added it for exactly this purpose — `herdr/CHANGELOG.md:541`: "so user hooks can customize
pane titles … *without taking over integration-owned lifecycle or session state*".

Verified against a live Herdr instance:

```
$ herdr pane report-metadata wZ:p1 --source pi-peer-test --title "ZHANG-TITLE"
$ herdr pane get wZ:p1     →  label='zhang'   title='ZHANG-TITLE'   # label untouched
$ herdr pane report-metadata wZ:p1 --source pi-peer-test --clear-title
$ herdr pane get wZ:p1     →  label='zhang'   title=<absent>        # label reappears
```

**The rule is stateless.** pi-peer never writes `manual_label`, so a non-empty `label`
always means "not pi-peer" and must be deferred to. No comparison against a remembered
previous value is needed, therefore no new persisted state:

```
on each identity sync:
  label = herdr pane get <paneId> → result.pane.label     // key absent when unset
  if label is non-empty:  herdr pane report-metadata <paneId> --source pi-peer --clear-title
  else:                   herdr pane report-metadata <paneId> --source pi-peer --agent pi \
                                                     --title <appliedName> --seq <n>
```

1. `herdr.ts` — add next to `renameSinglePaneTabAsync`:

   ```ts
   /**
    * Fixed, never-derived source id. `--clear-title` only clears the title for the
    * source that set it, so deriving this from a session id or peer name would strand
    * the previous run's title forever with no way to clear it.
    */
   const HERDR_METADATA_SOURCE = "pi-peer";
   ```

   plus `readHerdrPaneLabelAsync` (wraps `herdr pane get`) and
   `publishHerdrPaneTitleAsync` implementing the rule above. Reuse `herdrRunAsync` /
   `decodeHerdrJson`; do not add a new exec helper.

   - Always pass `--agent pi`. Herdr hides a metadata report once
     `effective_agent_label()` returns `None`, which happens as soon as
     `recent_agent_process_exit` is set (`herdr/src/terminal/state.rs:1798-1809`). That is
     free cleanup when pi dies: no shutdown hook and no GC pass are needed.
   - Pass a monotonic `--seq` from an in-process counter. It only has to order calls within
     one process lifetime, so it must **not** be persisted.
   - Never pass `--ttl-ms`.
   - Never pass a source beginning with `herdr:` — those are Herdr's own integration
     sources (`is_official_agent_source`, `herdr/src/agent_resume.rs:227-243`).

2. `service.ts` — call it from the identity sync path after the agent rename succeeds.
   On failure, `console.error` and continue, matching the tab-rename branch. It must never
   fail the sync.

3. `syncCurrentHerdrIdentityAsync` (`herdr.ts:328-353`) keeps its current shape: agent
   rename first, and the title publish only runs when the agent rename succeeded, for the
   reason already in the comment at `herdr.ts:342-343` — do not advertise a name the agent
   panel refused. Replace the `renameSinglePaneTabAsync` call with
   `publishHerdrPaneTitleAsync`; keep the `try/catch` + `console.error` so it can never
   fail the sync. There is no second concurrent call any more, so no `Promise.allSettled`.

4. Remove tab renaming **in this task**. It cannot be deferred: `tsconfig.json:8` sets
   `noUnusedLocals`, and each deletion orphans the next symbol down, so `tsc` stays red
   until the whole chain is gone. Verified reference counts in `herdr.ts`:

   | symbol | refs | why it dies |
   | --- | --- | --- |
   | `renameSinglePaneTabAsync` | decl only, once the call site moves | TS6133 |
   | `HerdrTabRenameResult` (`:49`) | decl only | TS6196 |
   | `getHerdrTabAsync` (`:240`) | decl only — sole caller was `renameSinglePaneTabAsync` | TS6133 |
   | `herdrTabFrom` (`:181`) | decl + one use, inside `getHerdrTabAsync` | orphans next |
   | `HerdrTabInfo` (`:43`) | decl + uses at `:181,183,189,244`, all inside the two above | orphans next |

   `shouldMirrorPeerNameToSinglePaneTab` (`:192`) and `AUTO_TAB_LABEL_PATTERN` (`:60`) do
   **not** die on their own: the former is `export`ed (never flagged) and keeps the latter
   alive. It takes an inline object type, not `HerdrTabInfo`. Delete both explicitly,
   together with the import and assertions in `test/peer/peer-talk.test.ts:15,220-228`.

   Also fix the JSDoc on `syncCurrentHerdrIdentityAsync` (`herdr.ts:327`) — "agent and
   auto-named single-pane tab" is wrong the moment the call site moves.

   Keep, and do not touch: `HerdrPeerContext.tabId` (`:25`), `HerdrPane.tab_id` (`:35`),
   the assignment at `:257`, `herdrPeerIdentityMatches` (`:355`), `PeerRecord.tabId`
   (`protocol.ts:31`), its validator (`protocol.ts:199`), the read at `protocol.ts:417`,
   and every `tabId:` in test fixtures. Those are identity and reporting — `tabId` feeds
   `getPeerStatus` and appears in `talk_sessions` output. Removing them would change the
   tool's public surface, which is out of scope.

   After this task, `rg -n "tab.*rename|SinglePaneTab|AUTO_TAB_LABEL" pi-extension test`
   must return nothing.

   State plainly in the commit message: **this is the commit where pi-peer stops renaming
   tabs**, and why (see `## Decisions`).

**Test seam.** `herdr.ts` has no seam for the exec layer today, and Task 7's whole risk
surface is *which argv is emitted*. Add one, following the `TalkDeps` precedent
(`service.ts:227-229`):

```ts
/** Injectable for tests only; production always uses the real CLI. */
export type HerdrRunner = (args: string[], socketPath: string, options: HerdrRunAsyncOptions) => Promise<string>;
```

Give `publishHerdrPaneTitleAsync` an optional trailing `run: HerdrRunner = herdrRunAsync`
parameter. Do not thread it through unrelated functions.

**Tests** (`test/peer/peer-talk.test.ts`):

- Pure decision function: absent label → publish; empty-string label → publish;
  non-empty label → clear.
- Captured argv for the publish case contains `--source pi-peer`, `--agent pi`, and
  `--title <name>`; it contains no `--ttl-ms` and no `rename`.
- Captured argv for the clear case contains `--source pi-peer` and `--clear-title`.
- No emitted argv ever starts with `["tab", "rename"]`. The behaviour change lands here, so
  its guard belongs here — Task 8 is only dead-code removal and cannot regress it.
- **Per-source regression guard:** two calls with *different* peer names emit the *same*
  `--source` value. This is the test for the trap recorded in `## Decisions`.
- `--seq` strictly increases across successive calls.
- The whole flow never emits a `["pane", "rename", ...]` argv under any input.
- The existing `"syncs Herdr visible identity at startup and on each prompt"` test
  (`standalone.test.ts:451`) injects `syncVisibleIdentity`, so it does not exercise the CLI
  and must keep passing **unchanged**. If it needs edits, something was wired wrong.

**Accepted limitation, document in `docs/`:** a pane whose `label` was set by an applied
layout (`herdr/src/app/api/layouts.rs:490`) or a plugin pane manifest
(`herdr/src/app/api/plugins/panes.rs:39,278`) starts non-empty, so pi-peer will silently
never title that pane. Correct under the rule — it destroys nothing — but surprising.

---

### Task 8 — merged into Task 7

Kept here only as the rationale record for *why* tab renaming was removed; the edits live
in Task 7 step 4. See `## Decisions` for why the split was abandoned.

**Why the feature was removed rather than fixed.** Herdr's tab API cannot support a correct
implementation:

- There is **no separate slot**. `herdr tab rename` writes `custom_name`, the same field
  the user writes. Unlike the pane, there is no metadata-title equivalent.
- There is **no undo**. `Tab::set_custom_name` (`herdr/src/workspace.rs:1092-1094`) is
  `self.custom_name = Some(name)` with no path back to `None`, `handle_tab_rename`
  (`herdr/src/app/api/tabs.rs:158`) is its only caller, and `herdr tab rename` has no
  `--clear` (contrast `herdr pane rename [OPTIONS] <PANE_ID> [LABEL]...  --clear`).
  Verified live: `herdr tab rename wZ:t2 ""` yields `label=''`, a *blank* tab, not a
  restored automatic one. The transition is one-way.
- There is **no ownership signal**. `tab_info` never serialises `custom_name` — verified
  live, the payload is `{agent_status, focused, label, number, pane_count, tab_id,
  workspace_id}`. So `shouldMirrorPeerNameToSinglePaneTab` (`herdr.ts:182-193`) always
  falls through to `AUTO_TAB_LABEL_PATTERN` (`herdr.ts:60`, `/^[1-9]\d*$/`).

That last point is a **live defect**, not a hypothetical: once pi-peer renames a tab to a
peer name, the label stops matching the numeric pattern, so pi-peer can never update that
tab again. Observed in the running instance — `wZ:t2` sat at `label='pooh'` after Pooh's
session had ended, unreachable by any later peer. Keeping the feature means keeping a
write that cannot be corrected, undone, or re-applied.

---

### Task 9 — registration lock survives a vanished parent; integration test stops racing (P0)

Found by running the full suite 20 times: **4 failures**, always the same test,
`test/integration/peer-two-peer.test.ts:83` ("talk_to returns promptly …"), always
`error: 'Peer session not found: peer-eta'`. Not noise — ~20%, with two independent causes,
one of them in production code. Fix both.

**9a — production: `withRegistrationLock` cannot recover if its parent directory
disappears.** `pi-extension/pi-peer/protocol.ts:138-163`:

```ts
mkdirSync(sessionDir(root), { recursive: true, mode: 0o700 });   // :142 — once, OUTSIDE the loop
for (;;) {
  let createdLock = false;
  try {
    mkdirSync(lockPath, { mode: 0o700 });                        // :147
    ...
    break;
  } catch (error) {
    ...
    if (!isAlreadyExistsError(error)) throw error;               // ENOENT escapes here
    ...
    await new Promise((resolve) => setTimeout(resolve, REGISTRATION_LOCK_RETRY_MS));  // :162 — yield
  }                                                              // continue → back to :147
}
```

The `await` at `:162` is a yield point. Anything that removes `<root>/sessions` in that
window makes the next `mkdirSync(lockPath)` fail with `ENOENT`, which is not
`isAlreadyExistsError`, so it is thrown and registration dies permanently instead of
self-healing. Observed in the failing runs:

```
pi-peer session bind failed Error: ENOENT: no such file or directory,
  mkdir '...\pi-peer-test-cEGard\sessions\.registration-lock'
    at withRegistrationLock (protocol.ts:147:7)
    at async bindRuntime (service.ts:564:20)
```

Same class as Task 4: a filesystem call assuming a directory still exists after a yield.

**Change.** Move the `sessionDir` ensure to the top of **each** loop iteration so every
attempt is self-contained:

```ts
for (;;) {
  // Re-ensure on every attempt: the retry below yields, and the tree can be
  // removed underneath us in that window. Recreating here is what makes a
  // vanished parent self-healing instead of fatal.
  mkdirSync(sessionDir(root), { recursive: true, mode: 0o700 });
  let createdLock = false;
  ...
}
```

Do **not** additionally treat `ENOENT` as retryable in the `catch`. With the ensure inside
the loop, `mkdirSync(lockPath)` is adjacent to it with no yield between, so that `ENOENT` is
no longer reachable in-process; making it retryable would only add an unbounded spin if the
root became permanently unwritable. A genuinely broken root now surfaces from
`mkdirSync(sessionDir, ...)` as a non-`ENOENT` error and still propagates.

**9b — test: registration is started but never awaited.** `startPeers`
(`test/integration/peer-two-peer.test.ts:69-74`) invokes the `session_start` handlers and
discards the promises; every test then sleeps a fixed 20 ms
(`:90,123,159,196,229,309`) and assumes `bindRuntime` finished. On a loaded Windows box it
often has not, and `resolveTarget` throws `Peer session not found`.

**Change.** Make `startPeers` `async`, `await Promise.all(...)` over the handler results,
then await the observable postcondition — that every peer resolves as live — with the
`waitUntil` helper already in the file (`:16`). Update call sites to `await`.

Review each fixed sleep individually; do not blanket-delete. The 20 ms sleeps exist to cover
registration and become dead once `startPeers` awaits it, but `POLL_MS + 100` at `:289`
waits for a delivery tick — a different postcondition. Leave it, or convert it to a
`waitUntil` on what it actually needs. State in the commit which sleeps were removed and why
each survivor stays.

**Validation — one green run proves nothing for a flake.** Required, in a scratch export,
not the working tree:

1. Before the fix, run the integration file 20× and record the failure count; expect ~4/20.
2. After the fix, run it 20× and require **0** failures.
3. Repeat step 2 under CPU contention to confirm the fix is not just a faster machine.
4. Mutation, per hunk and separately: revert 9a only, then revert 9b only. If reverting 9b
   alone does not reproduce failures in 20 runs, say so rather than claiming coverage.

---

**Note for the user-facing docs:** a tab that pi-peer already renamed keeps that name.
pi-peer cannot restore it, because Herdr has no clear. Recovering it is a manual
`herdr tab rename <tab_id> <number>` — setting it back to its position string restores both
the appearance and the automatic-looking state.

---

## Risks And Recovery

- **Task 2 is the only change to the delivery state machine.** If the new selection rule
  is wrong the failure mode is a duplicate delivery, which is exactly what ADR 0013 exists
  to prevent. Both halves of the contract are pinned by the two tests in Task 2; do not
  land the task with only one of them.
- **Task 1 changes a deletion path.** The safe direction is to keep files: an unknown error
  code must fall into `retryable: true`. A message that is kept can be retried; a message
  that is deleted is gone.
- **Task 7 adds a CLI call on a hot path.** If `herdr pane get` is slow or unavailable the
  identity sync must degrade to exactly today's behaviour, never block a turn. The
  `Promise.allSettled` shape plus the existing 5s `herdrRunAsync` timeout bound it.
- Rollback for Task 7 on a live session: `herdr pane rename <pane_id> --clear`.
- Each task is an independent commit. Revert one without touching the others.

## Progress

- [x] Task 1 — `readJsonChecked`, `drainInbox` stops deleting on transient read failure
- [x] Task 2 — expired claim adopted by the first following `agent_start`
- [x] Task 3 — per-line JSONL parse with BOM trim
- [x] Task 4 — `listDirSafe` for both `readdirSync` sites
- [x] Task 5 — case/whitespace-tolerant tag seal
- [x] Task 6a — case-insensitive display-name fallback in `resolveTarget`
- [x] Task 6b — `await action()` in `withRegistrationLock`
- [x] Task 6c — `throwIfAborted` after `liveRecords`
- [x] Task 7 — pane border title via `report-metadata`; removes tab renaming (absorbs Task 8)
- [x] Task 9 — registration lock re-ensures its parent; integration test awaits registration

## Decisions

- 2026-08-19: **Rejected as false positives.** Recorded so they are not re-opened.
  - *Assistant messages with `string` content are dropped by `history.ts`.* `pi`'s
    `AssistantMessage.content` is typed `(TextContent | ThinkingContent | ToolCall)[]`
    (`../pi/packages/ai/src/types.ts:427-429`). It is never a string, so the
    `Array.isArray` guard drops nothing.
  - *`writeAtomic` can collide on its temp filename.* `writeFileSync` and `renameSync` are
    synchronous, so two calls in one process cannot interleave, and two processes have
    different pids. Unreachable.
  - *`requeuePendingDeliveries` mutates the `Map` while iterating `keys()`.* Deleting the
    entry currently being visited is well defined in JS and does not skip the next entry;
    verified empirically. Style inconsistency only, not a defect.
  - *`herdrCliErrorCode` breaks when the CLI logs to stderr.* Not reproducible: `herdr`
    emits a single line of pure JSON on stderr, including under `RUST_LOG=debug`.
  - *`publicPeerId` can split a surrogate pair.* Session ids are ASCII UUIDs.
- 2026-08-19: **Two findings had the right symptom and the wrong mechanism**, and the plan
  encodes the corrected mechanism.
  - Task 3: `trim()` *does* strip `U+FEFF`; the defect is that the code trims only inside
    `filter` and parses the untrimmed line.
  - Task 1: on Windows, `renameSync` over an existing file succeeds
    (`MOVEFILE_REPLACE_EXISTING`); `EPERM` comes from an open handle on the target, not
    from the target merely existing. The `isAlreadyExistsError` `EEXIST`-only check in
    `requeueClaimedMessage` is therefore narrower than described. It is **not** in this
    plan: the surviving failure mode is an unhandled throw during recovery, which needs its
    own reproduction before a fix is designed.
- 2026-08-19: **A `readdirSync`/`rmSync` failure inside `drainInbox` is a queue-stalling
  defect, not a nuisance.** The tick's `try/catch` (`service.ts:576-590`) logs and returns,
  so a throw on the first sorted entry repeats every tick and starves every message behind
  it. Any per-entry failure in `drainInbox` must therefore `continue`, never propagate.
  This was found while mutation-testing Task 1 and is folded into Task 1 step 3.
- 2026-08-20: **Pane title uses the metadata slot, not `manual_label`.** Reviewed by three
  agents independently; unanimous. Rejected alternatives, in the order they failed:
  - *Track ownership in `PeerRecord.paneLabel`.* Broken. `recordPath` keys on `sessionId`
    (`protocol.ts:183`) and a plain `pi` relaunch mints a new one, so the record is always
    empty on restart while the pane still carries the previous label — pi-peer would read
    its own leftover label as user-owned and refuse to update it, forever. (A `--resume`
    run *does* preserve `sessionId` — `pi/packages/coding-agent/src/core/session-manager.ts:915`
    — which is the only path where this scheme accidentally worked.)
  - *Treat a label matching `PEER_NAME_POOL` as pi-peer's.* Rejected. The pool is ordinary
    human names (`Rex`, `Sam`, `Mario`, `Simba`, `Bella`, `Daisy`), so a collision silently
    steals a pane the user named, with no way for the user to know the pool. `pickPeerName`
    also emits suffixed names (`Mark-2`) the check would miss.
  - *Ownership file keyed by `paneId`.* Sound — public pane numbers are never reused
    (`herdr/src/workspace.rs:1241-1248`, invariant asserted at `:1515-1520`, direct test
    `pane_public_numbers_are_stable_and_not_reused_after_close` at `:1572-1590`, and the
    counter is restored via `max` in `herdr/src/persist/restore.rs:322-329`) — but it adds
    a state file with a lifecycle to garbage-collect, which is the class of complexity that
    produced the first failure. Unnecessary once the metadata slot removes the arbitration
    problem entirely.
- 2026-08-20: **The invariant is "non-empty `label` ⇒ not pi-peer", not "⇒ the user typed
  it".** Exhaustive audit of production writers of `manual_label`
  (`ast-grep -p '$X.set_manual_label($$$A)' -l rust`, test call sites excluded):
  `app/input/modal.rs:574` (rename dialog), `app/api/panes.rs:1180` (`herdr pane rename`),
  `app/api/layouts.rs:490` (layout apply), `app/api/plugins/panes.rs:39,278` (plugin pane),
  `persist/restore.rs:541,638` (snapshot replay of the previous four). The field defaults to
  `None` (`terminal/state.rs:166`) with no auto-generated value. None of these is pi-peer,
  which is all the rule requires.
- 2026-08-20: **Tab renaming is removed, not fixed.** Herdr's tab API has no separate slot,
  no clear, and no ownership signal (`workspace.rs:1092-1094`, `api/tabs.rs:158`,
  `tab_info` omits `custom_name` — all verified live). The existing heuristic therefore
  self-locks after its first successful write, which was observed in the running instance.
  A feature whose only write is irreversible and un-repeatable is worse than no feature.
  User decision, 2026-08-20: keep pane renaming only.
- 2026-08-20: **Task 8 merged into Task 7; the boundary does not exist.** `noUnusedLocals`
  (`tsconfig.json:8`) turns each deletion into a compile error for the next symbol down:
  moving the call site orphans `renameSinglePaneTabAsync`, deleting that orphans
  `HerdrTabRenameResult` and `getHerdrTabAsync`, deleting those orphans `herdrTabFrom`,
  and then `HerdrTabInfo`. The plan's claim that "TS6133 does not cascade" was wrong in
  effect: TypeScript does not propagate *reachability*, but "the sole caller was deleted"
  simply repeats at each level. Split attempted twice, failed at successive depths; what
  would have remained for Task 8 is two symbols and one test, which is not a review unit.
  Mutation discipline is unaffected — mutations are per hunk, not per commit.
  Rejected alternative: keep calling `renameSinglePaneTabAsync` alongside the new title
  publish until a later commit. That transitional state would keep performing the
  irreversible `custom_name` write this work exists to stop; a commit that actively does
  the harmful thing is worse than a larger commit.
- 2026-08-20: **`--clear-title` is per-source.** Clearing with a different `--source` than
  the one that set the title is a silent no-op; verified live. The source id must therefore
  be a hard-coded constant, never derived from a session id or peer name, or a run could
  never clear the title left by the previous run. Pinned by a test.

## Validation

- Focused proof: `npm run typecheck && npm run test:focused` after **each** task.
- Flaky-test proof: a fix for an intermittent failure needs a **repeat run** (20× minimum,
  plus once under CPU load), never a single green pass. Recorded because both a reviewer and
  the implementer independently dismissed this suite's ~20% failure as "machine load" after
  seeing one green rerun.
- Mutation proof: for every task, revert the source hunk, confirm the new tests go red,
  then restore. A green test against unfixed code is not evidence.
- **Mutate one hunk at a time.** When a commit contains two fixes, reverting both together
  can hide that neither test isolates either fix. Verified on Task 1: reverting
  `readJsonChecked` *and* the `rmSync` guard turned the test red, but reverting
  `readJsonChecked` alone left it green, because a directory trap makes "kept because
  retryable" and "delete attempted, threw, skipped" observationally identical.
- Run mutations in a scratch export (`git archive <ref> | tar -x -C /tmp/pp`), not in the
  working tree. Only one agent edits `pi-extension/` at a time; reviewers read only.
- Platform note for trap construction: `chmod 000` does **not** produce `EACCES` on Windows
  (verified — the read still succeeds), and symlink loops depend on Developer Mode. Neither
  is a portable way to force a retryable read failure. Use the `TalkDeps.readMessage`
  injection seam instead.
- Integration proof: `npm run test` once all tasks are in.
- Manual proof for Task 7, in a live Herdr session:
  1. `herdr pane rename <pane_id> --clear`, restart pi, split the pane, confirm both panes
     show their peer name on the border.
  2. Rename a pane by hand in Herdr, trigger a new turn, confirm the hand-set label is what
     stays on the border and that `herdr pane get` reports `title` absent.
  3. Clear the hand-set label, trigger a new turn, confirm the peer name returns.
  4. Quit pi in one pane and confirm the border stops showing the peer name without
     pi-peer having run any cleanup.
  5. Task 8: start a session in a tab whose label is a bare number and confirm the label is
     still that number after a turn — pi-peer must no longer rename tabs at all.
- Repository-required checks: `npm run typecheck`, `npm run test`.

## Result

All ten tasks landed in eleven commits, `37f9ae1..d34cb6c`, touching five production
files and four test files (939 insertions, 138 deletions). Nothing outside `pi-peer/` was
modified.

The three stated outcomes hold:

1. A queued peer message is no longer deleted on a transient read failure, and a corrupt
   entry that cannot be removed no longer stalls the whole inbox (Tasks 1, 4).
2. A single unparsable JSONL line no longer silently empties a peer's published history
   (Task 3).
3. A split pane shows the peer name via the metadata title slot, and a label set by anyone
   other than pi-peer is deferred to (Task 7).

Verification actually performed:

- `npm run typecheck` clean; full suite 92/92; full suite repeated 10× with 0 failures.
- Roughly 22 independent per-hunk mutations across the ten tasks, each turning exactly the
  intended test red and restored byte-identically (md5-checked) afterwards.
- Task 9 additionally validated 20× plain and 20× under eight-core CPU contention, both
  0 failures, against a ~20% pre-fix failure rate.
- Task 7's rule was exercised against a live Herdr instance, including the recovery path
  (`--clear-title` restoring a user's `manual_label` to the border).

Process notes worth carrying forward, because each cost a review cycle here:

- Three tests passed against unfixed code and had to be rebuilt: the Task 1 directory trap,
  its replacement after `readJsonChecked` short-circuited the `rmSync` path, and the Task 5
  match-counting assertion. Mutating one hunk at a time is what exposed all three.
- An intermittent failure was dismissed as "machine load" by two people independently
  before a 20× run identified it as a real production defect (Task 9a).
- The one item deliberately left undone: `isAlreadyExistsError` in `requeueClaimedMessage`
  only recognises `EEXIST`. On Windows `renameSync` over an existing file succeeds, so the
  surviving failure mode is an open handle on the target producing `EPERM`. That needs its
  own reproduction before a fix is designed; it is not in these commits.
