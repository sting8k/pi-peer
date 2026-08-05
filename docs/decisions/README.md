# Decisions

Decision records explain why important product, architecture, or harness choices
were made.

Use `docs/templates/decision.md` when adding a new decision.

After adding or updating a markdown decision file, also add or refresh the
durable decision row:

```bash
scripts/bin/harness-cli decision add \
  --id 0011-standalone-pi-peer-extension \
  --title "Standalone Pi-Peer Extension" \
  --doc docs/decisions/0011-standalone-pi-peer-extension.md
```

Trace fields such as `--decisions` summarize task-level choices. They do not
count as the Harness decision log.

Add a decision when:

- A locked technical choice changes.
- A product rule changes meaningfully.
- A validation requirement is added, removed, or weakened.
- A high-risk feature chooses one design over another.
- Auth, authorization, data ownership, audit/security, or API behavior changes.
- The source-of-truth hierarchy changes.
