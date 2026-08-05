# Stories

Stories are work packets. They turn product intent into bounded implementation
and validation work.

Current story packets include:

- `docs/stories/epics/E06-peer-talk/US-009-session-talk.md` (implemented)
- `docs/stories/epics/E07-pi-peer-standalone/US-010-standalone-pi-peer-extension/` (in_progress, high-risk)

## Normal Story

Use `docs/templates/story.md` for normal feature work.

Suggested path:

```text
docs/stories/epics/E01-domain-name/US-001-short-story-title.md
```

## High-Risk Story

Use `docs/templates/high-risk-story/` when the feature intake classifies work as
high-risk.

Suggested path:

```text
docs/stories/epics/E02-risky-domain/US-012-risky-story-title/
  execplan.md
  overview.md
  design.md
  validation.md
```

## Status Flow

```text
planned -> in_progress -> implemented
                  |
                  v
               changed
                  |
                  v
               retired
```
