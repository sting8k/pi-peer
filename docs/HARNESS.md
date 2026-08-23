# Harness

The Harness is the repo-level operating system for safe human/agent work. In
this repository, the product is the standalone pi-peer extension (peer-to-peer
Pi communication over a Herdr workspace) and the Harness is
what agents use to classify work, preserve context, validate changes, and leave
trace evidence.

The product is what pi users touch. The Harness is what agents touch.

## Current Project Context

```text
README.md
  -> public install and usage contract

pi-extension/pi-peer/*
  -> standalone TypeScript extension runtime (3 peer tools)

test/*
  -> unit and integration proof

docs/* + harness.db
  -> Harness operating layer and durable records
```

The repository already contains product code. Harness work must therefore protect
existing extension behavior instead of assuming an empty future scaffold.

## Mental Model

```text
Human intent
  -> Feature intake
  -> Story packet or direct tiny patch
  -> Agent work loop
  -> Product delta
  -> Validation proof
  -> Harness delta when friction is found
  -> Trace
  -> Next intent
```

Every task has two possible outputs:

1. Product delta: extension code, tests, API/tool shape, or
   product docs.
2. Harness delta: docs, templates, validation expectations, backlog items,
   durable records, or decision records that make the next task easier.

## Source Hierarchy

```text
User prompt or accepted product request
  input material for current work

README.md
  public product entrypoint and install/usage contract

docs/product/*
  current product contract in agent-sized files

pi-extension/pi-peer/*
  implemented standalone runtime behavior (talk_sessions, talk_latest, talk_to)

test/* and package.json scripts
  executable proof for runtime behavior

docs/stories/*
  story-sized work packets and historical evidence

scripts/bin/harness-cli query matrix
  behavior-to-proof control panel backed by the durable layer

docs/decisions/*
  why durable product, architecture, or Harness choices changed
```

Before implementation, product docs describe intent. After implementation,
product docs plus executable tests become the living contract.

## Durable Layer

Policy documents describe how to work. The durable layer stores what happened.

Operational data — intake classifications, story status, decision outcomes,
backlog items, and execution traces — lives in a SQLite database (`harness.db`)
managed by the Rust Harness CLI at `scripts/bin/harness-cli`. Agents and humans
should use that binary for Harness work. The database is local to each project
instance and `.gitignore`d. The schema is version-controlled under
`scripts/schema/`.

Initialize the database if it does not exist:

```bash
scripts/bin/harness-cli init
```

Common commands:

```bash
scripts/bin/harness-cli intake  --type <type> --summary <text> --lane <lane>
scripts/bin/harness-cli story   add --id <id> --title <text> --lane <lane>
scripts/bin/harness-cli story   update --id <id> --status <status>
scripts/bin/harness-cli story   update --id <id> --unit 1 --integration 1 --e2e 0 --platform 0
scripts/bin/harness-cli story   verify <id>
scripts/bin/harness-cli decision add --id <id> --title <text> --doc docs/decisions/<file>.md
scripts/bin/harness-cli trace   --summary <text> --outcome <outcome>
scripts/bin/harness-cli score-trace
scripts/bin/harness-cli query   matrix
scripts/bin/harness-cli query   matrix --numeric
scripts/bin/harness-cli query   backlog
scripts/bin/harness-cli query   stats
scripts/bin/harness-cli --version
```

## Input Types

Ongoing work should enter the harness as one of these input types:

- New spec: a substantial product specification that needs to become product
  docs and initial story candidates.
- Spec slice: a selected behavior from an accepted spec.
- Change request: a bounded behavior change, bug fix, or product refinement.
- New initiative: a larger product area that needs multiple stories.
- Maintenance request: dependency, architecture, performance, security, or
  operational work.
- Harness improvement: a process, template, proof, or agent-instruction change.

## Task Loop

For every task:

1. Classify the request with `docs/FEATURE_INTAKE.md`.
2. Record the classification with `scripts/bin/harness-cli intake`.
3. Locate the affected product docs, source files, tests, and story files.
4. Check proof status with `scripts/bin/harness-cli query matrix`.
5. Work only inside the selected lane: `tiny`, `normal`, or `high-risk`.
6. Before finishing, ask whether product truth, validation expectations,
   architecture rules, repeated failure patterns, or next-agent instructions
   changed.
7. Record a trace with `scripts/bin/harness-cli trace`, using
   `docs/TRACE_SPEC.md` for the expected trace tier and field depth.
8. Review the trace score printed by `scripts/bin/harness-cli trace`; use
   `scripts/bin/harness-cli score-trace --id <id>` only when re-checking a
   specific historical trace.
9. If Harness friction was found, either fix it directly or record it with
   `scripts/bin/harness-cli backlog add`.

## Growth Rule

The Harness grows from friction.

When an agent is confused, repeats manual reasoning, needs a new validation
command, discovers a missing rule, or sees a recurring failure pattern, it must
either improve the Harness directly or record the friction:

```bash
scripts/bin/harness-cli backlog add --title "<short name>" --pain "<what was hard>"
```

Backlog risk uses the same lane vocabulary as intake and stories: `tiny`,
`normal`, or `high-risk`. Use `--risk tiny` for low-risk follow-up items; `low`
is not a valid lane.

Use the backlog outcome loop for improvements that are expected to change agent
behavior or validation results:

1. When creating the backlog item, fill `--predicted` with the measurable impact
   expected from the improvement.
2. When closing the item, fill `--outcome` with the actual measured result or
   review evidence.
3. Use `scripts/bin/harness-cli query backlog --open` to review proposed and
   accepted items, and `scripts/bin/harness-cli query backlog --closed` to
   compare predictions with outcomes after implementation.

The `harness_friction` field on traces also captures per-task friction so
patterns can be queried later:

```bash
scripts/bin/harness-cli query friction
```

## Story Verification

Stories may carry a mechanical proof command:

```bash
scripts/bin/harness-cli story add --id US-012 --title "Story verification" --lane normal --verify "npm test"
scripts/bin/harness-cli story update --id US-012 --verify "npm run test:integration"
scripts/bin/harness-cli story verify US-012
```

`story verify` runs the command from the repository root, records
`last_verified_at` and `last_verified_result`, and exits 0 on pass or 1 on fail.
When `trace --story <id>` links to a story whose verification command has never
passed, the trace still records but prints an advisory warning before close.

`story verify` accepts only the story id. Configure the command with `story add
--verify` or `story update --verify`. Record proof booleans with `story update`,
using numeric values: `1` means yes and `0` means no. The Rust CLI rejects text
values such as `yes` and `no`.

Use `scripts/bin/harness-cli query matrix --numeric` when copying proof values
back into `story update`. The default matrix output is human-readable `yes`/`no`;
the numeric output mirrors CLI input.

## Decision Records

High-risk work needs durable decisions when it changes behavior or architecture.
For auth, authorization, data ownership, API shape, audit/security, validation
changes, source hierarchy changes, or architecture direction changes, record the
decision in both places:

1. Add a markdown file under `docs/decisions/` from
   `docs/templates/decision.md`.
2. Add or refresh the durable record:

```bash
scripts/bin/harness-cli decision add \
  --id 0011-standalone-pi-peer-extension \
  --title "Standalone Pi-Peer Extension" \
  --doc docs/decisions/0011-standalone-pi-peer-extension.md \
  --notes "Accepted during the standalone pi-peer extraction."
```

The trace `--decisions` field is useful evidence, but it is not the decision
log. Do not treat decision text in a trace as satisfying the durable decision
record requirement.

## Harness Change Policy

Agents may update directly:

- Story status and evidence via `scripts/bin/harness-cli story update`.
- Test matrix rows via `scripts/bin/harness-cli story add` and
  `scripts/bin/harness-cli story update`.
- Links from story packets to product docs.
- Product docs that restate existing behavior or accepted story behavior.
- Validation notes and reports.
- Small clarifications tied to the current task.
- Intake records, traces, and backlog items via `scripts/bin/harness-cli`.

Agents should ask for human confirmation before:

- Changing architecture direction.
- Removing validation requirements.
- Changing the source-of-truth hierarchy.
- Changing risk classification rules.
- Replacing the feature workflow.

## Done Definition

A task is done only when:

- The requested change is completed or the blocker is documented.
- Relevant docs, stories, and test matrix entries remain current.
- Validation commands were run when they exist, or skipped with a clear reason.
- A trace has been recorded with `scripts/bin/harness-cli trace`.
- Missing Harness capabilities were fixed or recorded with
  `scripts/bin/harness-cli backlog add`.
- The final response says what changed and what was not attempted.

## Current Validation Ladder

```text
npm test
  unit-focused TypeScript tests for the peer runtime (protocol, history, storage, entrypoint)

npm run test:integration
  mocked two-session peer lifecycle tests (request/reply, busy queueing, history);
  live Herdr smoke is opt-in and documented separately
```

Future product or release work may add broader checks, but agents must not claim
new commands pass until they exist and have been run.
