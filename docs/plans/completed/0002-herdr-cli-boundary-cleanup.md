# Execution Plan: collapse the two Herdr `pane get` paths behind one boundary

Date: 2026-08-20

## Status

Complete — 2026-08-20

## Outcome

One code path issues `herdr pane get`, one type models its response, and the seam that
makes the Herdr CLI substitutable in tests is carried in an options object instead of a
trailing positional parameter.

Behaviour must not change. Every existing test must keep passing **without being edited**,
except where a call signature it uses changes shape.

## Context

Plan `0001` (see `docs/plans/completed/`) added pane-title publishing. Reviewing the result
against `clean-code/` surfaced three defects introduced by that work. They are structural,
not functional — the shipped code is correct and covered.

The findings, in the order they matter:

1. **Duplication (`clean-code/chapters/17_smells_and_heuristics.md:140`, G5).** Two
   independent paths issue the same CLI command:

   ```
   herdr.ts:201   getHerdrPaneAsync        → herdrRunAsync → herdrPaneFrom → HerdrPane
   herdr.ts:277   readHerdrPaneLabelAsync  → run           → inline { pane?: { label?: string } }
   ```

   Same command, two decoders, two shapes for one payload. The book names this exact form:
   *"modules that have similar algorithms, but that don't share similar lines of code. This
   is still duplication."*

   The root cause is a gap in the model, not sloppy coding: `HerdrPane` (`herdr.ts:32-37`)
   declares only `pane_id`, `terminal_id`, `tab_id`, `workspace_id`. It has no `label`, so
   a second ad-hoc shape had to be invented to read one.

2. **Too many arguments (`clean-code/cheatsheet_rules.md`, F1).**
   `publishHerdrPaneTitleAsync(peer, appliedName, signal?, run = herdrRunAsync)` takes four.
   The guidance is 0–2 ideal, 3 with justification, 4+ needs an argument object. The cost is
   visible at every test call site, which must pass a positional hole:

   ```ts
   await publishHerdrPaneTitleAsync(peer, "zhang", undefined, run);
   //                                              ^^^^^^^^^ only to reach the next parameter
   ```

3. **Misleading comment (`clean-code/chapters/04_comments.md`, C2).**

   ```ts
   /** Injectable for tests only; production always uses the real CLI. */
   export type HerdrRunner = ...
   ```

   "for tests only" is attached to the wrong thing. `HerdrRunner` is the *contract of a
   runner*; production satisfies it with `herdrRunAsync` and flows through the same
   parameter. Only the act of injecting is test-specific.

**The seam itself is not a defect and must not be removed.** `clean-code/chapters/08_boundaries.md`
prescribes wrapping third-party code behind your own interface, `chapters/11_systems.md`
prescribes dependency injection, and `chapters/09_unit_tests.md:60` states plainly that
*"Test code is just as important as production code. It is not a second-class citizen."*
Without this seam the three constraints Task 7 depends on — a constant `--source`, a present
`--agent pi`, an absent `--ttl-ms` — are unverifiable.

This is design debt from plan `0001`, which specified the trailing-parameter shape and
failed to notice `getHerdrPaneAsync` already existed.

## Scope

In scope: `pi-extension/pi-peer/herdr.ts`, and only those call sites in
`test/peer/peer-talk.test.ts` whose signature changes.

Out of scope:

- Any change under `../pi/` or `../herdr/`; both are reference only.
- Behaviour changes of any kind, including argv emitted, error handling, and timeouts.
- Anything outside `pi-peer/`.
- Reinstating tab renaming, which plan `0001` removed deliberately.

## Approach

One task, landed as one commit, because the three findings share a single cause and fixing
them separately would mean changing the same signatures twice.

### Step 1 — model the field that is actually read

`herdr.ts:32-37`, add to `HerdrPane`:

```ts
  label?: string;
```

`herdrPaneFrom` (`:159-168`) returns `pane as HerdrPane` after validating `pane_id` and
`terminal_id`, so an optional field passes through with no further change. Keep the two
required-field checks exactly as they are.

Note for correctness: Herdr **omits** the `label` key when a pane has no manual label — it
is absent, not empty. `label?: string` models that precisely; do not default it to `""`.

### Step 2 — one options type carrying the seam

`herdrRunAsync` itself must keep taking `HerdrRunAsyncOptions` unchanged, since it consumes
`timeoutMs` (`:188`) and must not receive a `run` field it would ignore. Add a distinct type
for callers that go *through* a runner:

```ts
interface HerdrCallOptions extends HerdrRunAsyncOptions {
  /** Substitutes the Herdr CLI. Defaults to the real one; tests pass a fake. */
  run?: HerdrRunner;
}
```

Retarget the `HerdrRunner` doc comment at the contract rather than at who supplies it — for
example, that it is the boundary through which every Herdr CLI invocation passes. Do not
write "for tests only".

### Step 3 — collapse the duplicate path

`getHerdrPaneAsync` (`:196-203`) takes `HerdrCallOptions`, destructures
`{ run = herdrRunAsync, ...rest }`, and calls `run(["pane", "get", paneId], socketPath, rest)`.

`readHerdrPaneLabelAsync` (`:272-280`) is then deleted. Its caller reads the label from the
shared path:

```ts
const pane = await getHerdrPaneAsync(peer.paneId, peer.socketPath, options);
const action = decideHerdrPaneTitleAction(pane.label);
```

The inline `{ pane?: { label?: string } }` type disappears with it.

**Verify before relying on this**: `getHerdrPaneAsync` throws via `herdrPaneFrom` when
`pane_id` or `terminal_id` is missing, whereas the deleted function tolerated any shape. The
two remaining callers (`getCurrentHerdrPeerContextAsync:221`, `getHerdrPeerStatusAsync:367`)
already depend on that strictness. Confirm the test fakes for the title path return a
payload carrying `pane_id` and `terminal_id`; if they do not, update the fakes — that is a
fake that was under-specifying the real response, not a regression.

### Step 4 — options object instead of a positional hole

```ts
export async function publishHerdrPaneTitleAsync(
  peer: HerdrPeerContext,
  appliedName: string,
  options: HerdrCallOptions = {},
): Promise<void>
```

Production call site `herdr.ts:339` becomes `publishHerdrPaneTitleAsync(peer, appliedName, { signal })`.
Test call sites become `publishHerdrPaneTitleAsync(peer, "zhang", { run })` — the `undefined`
hole is gone.

## Risks And Recovery

- The only real risk is a silent behaviour change in emitted argv. The Task 7 tests already
  assert argv precisely and were mutation-proven, so they are the safety net; if they pass
  unedited, the refactor is faithful.
- `herdrAgentStatusFrom` and `herdrPeerIdentityMatches` also consume `HerdrPane`. Adding an
  optional field cannot affect them, but confirm rather than assume.
- Revert is a single commit.

## Progress

- [x] Step 1 — `HerdrPane.label`
- [x] Step 2 — `HerdrCallOptions`, retargeted `HerdrRunner` comment
- [x] Step 3 — delete `readHerdrPaneLabelAsync`, reuse `getHerdrPaneAsync`
- [x] Step 4 — options object on `publishHerdrPaneTitleAsync`

## Decisions

- 2026-08-20: **The injection seam stays.** Removing it would satisfy a superficial reading
  of "no test-only code in production" at the cost of the only mechanism that verifies the
  constant `--source`, the required `--agent pi`, and the forbidden `--ttl-ms`. `clean-code`
  endorses the seam (Ch. 8 boundaries, Ch. 11 DI, Ch. 9 on test code not being second-class);
  what it objects to is the shape, which is what this plan changes.
- 2026-08-20: **`HerdrRunAsyncOptions` is not extended in place.** `herdrRunAsync` consumes
  `timeoutMs` and would silently receive a `run` field it ignores, which is the kind of
  quiet mismatch that survives review. A separate `HerdrCallOptions` keeps each type honest
  about what its consumer reads.

## Validation

- `npm run typecheck && npm run test:focused` after the change.
- `npm run test` before finishing.
- **Behaviour proof:** the Task 7 argv assertions must pass with their *bodies* unedited.
  Adjusting a call signature is expected; changing an expected argv, a decision outcome, or
  an assertion is not, and means the refactor changed behaviour.
- **Mutation, one hunk at a time** — this is a refactor, so the point is proving the tests
  still bind after the shape changed:
  1. Make `--source` derive from the peer name → the per-source guard must go red.
  2. Drop `--agent pi` → the publish-argv test must go red.
  3. Invert `decideHerdrPaneTitleAction` → the pure-function test must go red.
  If any of these now passes, the refactor broke the coverage even though the suite is green.
- Restore from a byte-checked copy after each mutation; do not use `git checkout --`.
- Run mutations in a scratch export (`git archive <ref> | tar -x -C /tmp/<dir>`), never in
  the working tree.

## Result

Landed. `HerdrPane.label` added; `HerdrCallOptions` carries the `run` seam through
`getHerdrPaneAsync` and `publishHerdrPaneTitleAsync`; `readHerdrPaneLabelAsync` deleted in
favor of the shared `getHerdrPaneAsync` path; `publishHerdrPaneTitleAsync` takes an options
object instead of a trailing positional hole.

One deviation from the plan text, both anticipated by it: the five test fakes for the
title path returned `pane: {}` / `pane: { label }`, which the deleted
`readHerdrPaneLabelAsync` tolerated but `getHerdrPaneAsync` (via `herdrPaneFrom`) does not
— it throws without `pane_id`/`terminal_id`. Updated the fakes to include
`pane_id: "pane-1", terminal_id: "terminal-1"`, matching the `peer` fixture in each test;
assertion bodies were not touched.

`npm run typecheck && npm run test` → 92/92 green. `test:focused` → 85/85 green.

Mutation-proof (scratch export, restored via byte-checked copy + md5 after each):
1. `--source` derived from `appliedName` on the publish path → 2 tests red (publish argv,
   per-source guard). Restored, 44/44 green.
2. Dropped `--agent pi` → 1 test red (publish argv). Restored, 44/44 green.
3. Inverted `decideHerdrPaneTitleAction` → 4 tests red (pure-function test, publish argv,
   clear argv, seq-increase). Restored, 44/44 green.

Confirmed `herdrAgentStatusFrom` and `herdrPeerIdentityMatches` do not read `label` (grep
of `HerdrPane` usages), so the new optional field cannot affect them. Confirmed
`rg "tab.*rename|SinglePaneTab|AUTO_TAB_LABEL" pi-extension test` returns only the Task 7
regression-guard test itself, not reintroduced code.
