# Harness Components

This taxonomy maps the installed Harness in `pi-peer` to the
responsibilities it serves. It is scoped to files that exist in this repository,
not to the upstream Harness source repository.

Status values:

- **Covered**: the repository has an explicit file, command, or durable record for
  this responsibility.
- **Partial**: the repository has some support, but the support is incomplete,
  manual, or not yet measured.
- **Missing**: no meaningful support exists yet.

## Responsibility Map

| # | Responsibility | Status | Harness Files | Evidence | Gap |
| --- | --- | --- | --- | --- | --- |
| 1 | Task specification | Covered | `AGENTS.md`, `docs/FEATURE_INTAKE.md`, `docs/templates/*`, `docs/stories/*`, `intake` and `story` durable records | Requests are classified by type and lane before implementation; templates exist for normal and high-risk work. | Keep story packets synchronized with product docs. |
| 2 | Context selection | Covered | `AGENTS.md`, `docs/CONTEXT_RULES.md`, `docs/ARCHITECTURE.md`, `docs/product/*`, `docs/decisions/*` | Agents have a stable reading list plus phase-by-lane context rules. | Future automation could measure over-reading or stale context. |
| 3 | Tool access | Partial | `scripts/bin/harness-cli`, `scripts/README.md`, pi tools in `pi-extension/pi-peer/index.ts` | Harness CLI records operational state; pi extension tools expose peer-to-peer communication behavior. | No generated tool registry or permission manifest exists. |
| 4 | Project memory | Covered | `docs/HARNESS.md`, `docs/product/*`, `docs/decisions/*`, `docs/GLOSSARY.md`, `docs/stories/*`, `harness.db` | Product truth, decisions, stories, traces, and backlog records preserve durable knowledge. | Add stale-doc checks when repeated drift appears. |
| 5 | Task state | Covered | `scripts/bin/harness-cli query matrix`, `docs/TEST_MATRIX.md`, `story` and `trace` durable records | Durable records track status, proof columns, and traces. | Add lifecycle checks so in-progress stories cannot be forgotten. |
| 6 | Observability | Partial | `docs/TRACE_SPEC.md`, `scripts/bin/harness-cli trace`, `scripts/bin/harness-cli score-trace`, `scripts/bin/harness-cli query traces`, `scripts/bin/harness-cli query friction` | Traces are recorded and scored; friction can be queried. | No dashboard or benchmark ingestion exists in this installed repo. |
| 7 | Failure attribution | Partial | `docs/HARNESS_COMPONENTS.md`, `docs/TRACE_SPEC.md`, trace `errors`, trace `harness_friction`, backlog records | Failures can be tied to files, components, friction, and backlog proposals. | No automated attribution from failing tests to components exists. |
| 8 | Verification | Covered | `package.json`, `test/*`, `docs/TEST_MATRIX.md`, `scripts/bin/harness-cli story verify` | `npm test` and `npm run test:integration` are documented proof commands; stories can store verification commands. | Batch verification and proof-column automation remain future work. |
| 9 | Permissions | Partial | `AGENTS.md`, `docs/HARNESS.md`, `docs/FEATURE_INTAKE.md`, `docs/ARCHITECTURE.md` | Policy describes when agents may update directly and when to ask before changing direction. | Permissions are instruction-level only; no enforced allowlist exists. |
| 10 | Entropy auditing | Partial | `docs/HARNESS_BACKLOG.md`, backlog records, trace `harness_friction`, `docs/HARNESS_MATURITY.md` | Growth rule captures friction and backlog items can compare predicted impact with actual outcome. | No drift detector or entropy score exists. |
| 11 | Intervention recording | Partial | trace records, `docs/decisions/*`, `docs/stories/*`, final agent reports | Traces and decisions can record actions, decisions, and outcomes. | Human interventions are not separated from normal agent actions. |

## NexAU Cross-Reference

| Component | Harness Equivalent | Status | Notes |
| --- | --- | --- | --- |
| System prompts | `AGENTS.md` plus Harness policy docs | Covered | `AGENTS.md` is the stable shim; docs carry evolving operating instructions. |
| Tool descriptions | `README.md`, `docs/product/overview.md`, `scripts/README.md`, pi tool descriptions in `pi-extension/pi-peer/index.ts` | Partial | Commands and Harness CLI are documented, but there is no generated command reference. |
| Tool implementations | `pi-extension/pi-peer/*`, `scripts/bin/harness-cli`, `scripts/schema/*` | Covered | Product tools and Harness durable-layer tools are separate implementation surfaces. |
| Middleware | Feature intake workflow, peer busy/queue lock, HerdR liveness checks | Partial | Some runtime guards exist, but Harness policies are not centrally enforced. |
| Skills | `docs/templates/*`, `docs/FEATURE_INTAKE.md`, `docs/CONTEXT_RULES.md`, `docs/TRACE_SPEC.md` | Partial | Procedures exist as markdown rather than installable agent skills. |
| Peer sessions | `talk_sessions`/`talk_latest`/`talk_to`, `pi-extension/pi-peer/*` | Covered | The product itself provides peer-to-peer session communication between HerdR panes. |
| Long-term memory | `harness.db`, `docs/decisions/*`, `docs/stories/*`, `docs/product/*`, `docs/GLOSSARY.md` | Covered | Durable records and docs preserve task history and product vocabulary. |

## File Inventory

| File or Directory | Primary Responsibility | Secondary Responsibilities |
| --- | --- | --- |
| `AGENTS.md` | Context selection | Task specification, permissions |
| `README.md` | Product contract | Tool descriptions, project memory |
| `package.json` | Verification | Tool access |
| `pi-extension/pi-peer/index.ts` | Product tool implementation | Tool access, permissions (`PI_PEER_DISABLED`) |
| `pi-extension/pi-peer/service.ts` | Product tool implementation | Task state, observability |
| `pi-extension/pi-peer/protocol.ts` | Product tool implementation | Task state (mailbox) |
| `pi-extension/pi-peer/history.ts` | Project memory | Task state |
| `pi-extension/pi-peer/herdr.ts` | Platform verification | Tool access |
| `pi-extension/pi-peer/storage.ts` | Data model | Task state |
| `pi-extension/pi-peer/schemas.ts` | Product contract | Tool descriptions |
| `test/*` | Verification | Failure attribution |
| `docs/ARCHITECTURE.md` | Context selection | Permissions, task specification |
| `docs/FEATURE_INTAKE.md` | Task specification | Permissions, context selection |
| `docs/CONTEXT_RULES.md` | Context selection | Task specification |
| `docs/HARNESS.md` | Task specification | Project memory, permissions |
| `docs/product/*` | Product contract | Context selection |
| `docs/stories/*` | Task specification | Project memory, verification |
| `docs/decisions/*` | Project memory | Permissions |
| `docs/TRACE_SPEC.md` | Observability | Failure attribution, intervention recording |
| `docs/TEST_MATRIX.md` | Verification | Task state |
| `docs/HARNESS_BACKLOG.md` | Entropy auditing | Failure attribution |
| `docs/HARNESS_MATURITY.md` | Entropy auditing | Observability, verification |
| `docs/GLOSSARY.md` | Project memory | Context selection |
| `docs/templates/*` | Task specification | Verification, project memory |
| `scripts/README.md` | Tool access | Context selection |
| `scripts/bin/harness-cli` | Task state | Observability, project memory |
| `scripts/schema/*` | Project memory | Task state, observability |

## Coverage Summary

- Covered: 5/11 responsibilities.
- Partial: 6/11 responsibilities.
- Missing: 0/11 responsibilities.

Covered responsibilities:

- Task specification.
- Context selection.
- Project memory.
- Task state.
- Verification.

Partial responsibilities:

- Tool access.
- Observability.
- Failure attribution.
- Permissions.
- Entropy auditing.
- Intervention recording.

Next improvement areas should focus on generated command references, stale-doc
checks, and stronger proof automation before adding new process layers.
