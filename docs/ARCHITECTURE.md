# Architecture

Two layers. The engine judges; the adapter does IO.

```
hooks/register.tsx   Mod adapter: events → engine calls; $.store persistence; commands; status line; toasts
hooks/pane.tsx       The /integrity pane: drawn from the element table and the engine's summary (no $)
src/engine/          Pure TypeScript, no runtime dependencies, no $ calls
  types.ts           The data model (JSON-safe)
  contract.ts        Intent Fingerprint: capture, requirements, approve, versioned amend
  evidence.ts        The Witness: command classification, outcomes, runner summaries, freshness
  mirage.ts          Mirage Detector rules + endpoint extraction
  drift.ts           Intent drift rules
  status.ts          Requirement state from evidence; strict policies
  claims.ts          Completion Claim Auditor
  summary.ts         THE canonical summary (UI, status line and report all read it)
  report.ts          Markdown / JSON reports
  persist.ts         Cross-session merge and retention
  index.ts           State transitions: startTask, recordChange, recordTool, recordAudit, ...
tests/               claude plugin test suites + an in-memory world beneath the plugin
fixtures/            Deterministic fixture projects and runner outputs
```

## Data flow

| Event | Adapter | Engine |
|---|---|---|
| `session.start` | registers commands, loads `$.store` record for this repo | — |
| `prompt.submit` (human origin) | keeps the prompt in memory; auto-drafts a contract if none is active and the prompt is an implementation task | `isMeaningfulTask`, `startTask` |
| `tool.call` Edit/Write/NotebookEdit | strict guard *before* `next`; after core ran: reads the file back, records the change | `deniedPath`, `recordChange` (drift → mirage → endpoint check → staleness) |
| `tool.call` Bash / browser MCP | records `bashEditDiff` file changes first, then the check; adds `git rev-parse` provenance | `recordChange`, `recordTool` |
| `turn.complete` (main loop) | audits the answer; returns a different `text` (shown beneath, never replacing the answer) | `recordAudit` |
| `command.run` | all `/integrity*` commands | everything |
| `ui.render` Pane | draws from `$.state` `rev` (subscription) + `ui` (focus) | `summarize` |

Every state change goes through `changed()`: bump `rev` (redraws subscribed panes), refresh the status line (only when its text changed), show deduplicated hints, persist.

## State

- **Canonical:** `ProjectRecord` in `$.store` under `p:<hash(repo root | origin remote)>`. It holds the active task id, mode, and the tasks (contract, evidence, files, findings, claims, activity).
- **Session:** `$.state` `integrity.rev` (a change counter the pane subscribes to) and `integrity.ui` (tab, selection, waiver input). UI focus lives apart from evidence, so a redraw never loses your place.
- **Module:** a cache of the loaded record. A hot reload is a fresh load, so the cache reloads from the store.

Writes coalesce and are serialized. Each write re-reads the stored record and merges (`persist.ts`) instead of overwriting, so two sessions on one repository keep each other's evidence.

## Why `$` stays in register.tsx

`claude plugin validate` follows `$` statically and allows it only in functions declared at the top of the hooks file. The pane therefore receives the element table (`$.ui.resolve(e)`) and closures, never `$`. The engine never sees `$` at all, which is also what makes it reusable from a CLI or CI.
