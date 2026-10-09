# Limitations (stated plainly)

## Verification scope

- **Only observed work counts.** Tests you run in your own terminal or CI are not seen. Confirm them with `/integrity-verify R# …`, or run them through Claude.
- **One passing suite verifies only linked requirements**: test-category requirements, ones whose `check` matches the command, or ones linked by hand. That is by design.
- **Static analysis cannot prove runtime behaviour.** "Live data", "responsive" and "production-ready" claims are `not-assessable` without runtime or manual evidence.
- **Browser MCP sessions are inconclusive.** Clicking around in a browser is not an assertion. A Playwright/Cypress *test run* or your confirmation is.
- **Freshness is change-based.** Evidence goes stale when a related code or config file changes in an observed edit, or when `/integrity-check` finds a tracked file changed on disk. Untracked files edited outside Claude are not watched continuously.
- **Exit status comes from completion state.** Bash results expose `isError`, not the numeric exit code. A pipe or `|| true` masks the check's own status. Integrity then marks the run inconclusive unless a runner summary is readable.

## Detection

- **No AST.** The Mod runtime has no TypeScript compiler. Rules use comment-stripped text with brace matching, so unusual formatting, string-built handlers or code split across files can be missed (false negatives) or misread (false positives). Every non-literal finding is `potential` for that reason.
- **Claim extraction is pattern-based.** Hedged ("should pass") and negated sentences are skipped on purpose, so some genuine claims phrased unusually go unaudited. Under-auditing was chosen over false alarms.
- **First-class support is JS/TS/React/Next.js.** Other languages get evidence and claims but no mirage rules yet.

## Platform

- **Completion cannot be blocked.** `turn.complete` offers no veto. Strict mode warns and gates through `/integrity-check`'s exit code.
- **Concurrent sessions:** `$.store` has no compare-and-swap. Integrity re-reads and merges before every write (evidence and findings union; a conflicting contract edit is kept as a revision), but two writes within the same few milliseconds can still lose the earlier one.
- **UI paint is not tested.** `claude plugin test` validates the drawn trees, element props and handlers on each surface's element table. How the terminal paints them (wrapping, colors) and the Desktop/VS Code renderings were not checked in a live session.
- **Subagents:** their tool calls are observed and recorded as evidence (with `agentId`). Their final reports are not audited as the main answer.
