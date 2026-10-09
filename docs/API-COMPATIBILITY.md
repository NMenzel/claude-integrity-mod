# API compatibility report

Verified against the declarations Claude Code **2.1.294** writes (`claude-code.d.ts`, about 21k lines) and against `claude plugin validate` / `claude plugin test` on that build. The Mods API is early access, so re-check after an update.

## Used, verified

| Surface | How it is used | Verified by |
|---|---|---|
| `session.start` | registers commands, loads state | tests, real `-p` load |
| `session.end` | flushes a pending write | validate |
| `prompt.submit` | captures human prompts (`origin.kind` composer/bridge/sdk) | tests |
| `tool.call` | strict deny before `next`; observes core's result after | tests |
| `turn.complete` | returns `{ text }` ≠ answer → shown **beneath** the answer; the transcript is never rewritten | tests |
| `command.run` / `$.command.register` | 16 commands and 6 short aliases; `exitCode` for headless runs | tests, real `-p` (exit 1) |
| `ui.render` `Pane` + `$.ui.open/close` | the dashboard; opens with `columns: 66` (docked) and `rows: 10` (inline); `placement` picks the inline mini | `$.ui.mount` tests on terminal/desktop/mobile |
| `$.ui.status` | Level-A hint; one slot per plugin, so it cannot overwrite another mod | tests |
| `$.ui.toast` | deduplicated hints | tests |
| `$.state` + `atom/read/update` | redraw subscription and UI focus | validate (declared contract), tests |
| `$.store` | canonical persistence (4 MiB per plugin; record trimmed to 600 kB) | tests, real `-p` across processes |
| `$.fs.read/exists/write` | read back edited files; export reports | tests |
| `$.process.run` | `git rev-parse` / `git status --porcelain` only, for provenance (option `gitProvenance`) | tests |
| `$.session.repo/root/cwd/id` | project identity and provenance | tests |
| `$.model.complete` | `/integrity-suggest` only, opt-in, `maxTokens` 500, 30 s timeout, cached per prompt | tests |
| `$.ui.ask` | reset confirmation (falls back to `confirm` argument headless) | tests |

## Facts that shaped the design

- **No exit code in Bash results.** Failure is `isError: true`. Also used: `interrupted`, `backgroundTaskId`, `timedOutAfterMs`, `persistedOutputPath`, `bashEditDiff`.
- **Synthetic results are detectable.** Core's answers carry `ref`; a plugin's own `{ result }` does not. Integrity never counts such a result as execution.
- **Edit/Write results** carry `originalFile`, `type: create|update` and `staged`. A staged or refused write is not a change.
- **`turn.complete` cannot block completion.** Strict mode warns and gates through `/integrity-check`'s exit code instead.
- **`Button` has no `color` prop.** Status in rows is carried by glyph and word, plus `dimColor`. Color is only applied on `Text`.
- **Pane hotkeys** work only while the pane holds the keyboard, so digits never collide with prompt typing.
- **`$` may only be passed to top-level functions of the hooks file** (validator rule). See ARCHITECTURE.md.
- **The test kit resolves paths natively** (`C:\repo\...` on Windows) before raising `fs.*` events.
- **`$.store` has no compare-and-swap.** Integrity re-reads and merges before each write. A narrow race window remains (see LIMITATIONS.md).

## Considered, not used

- `PromptHint` `tail` / `AbovePrompt`: `$.ui.status` is the least intrusive surface and is per-plugin by construction. Integrity draws no band, so it cannot hide another mod's.
- `session.compact`: the contract lives in `$.store`, outside the conversation, so compaction cannot drop it. No hook was needed.
- `MultiEdit` is handled by name, but this build's tool table has no `MultiEdit`.

## Spec items mapped to what exists

| Spec | Implementation |
|---|---|
| `$.ui.status` or `ui.render` hint | `$.ui.status` |
| "Strict blocks completion" | not possible; warning plus `/integrity-check` exit 1 |
| AST analysis | no compiler in the Mod runtime; token-level rules over comment-stripped text with brace matching |
| Flightdeck-style pane | native `Pane` with tabs, hotkeys, drill-downs and responsive layouts; no Flightdeck dependency |
