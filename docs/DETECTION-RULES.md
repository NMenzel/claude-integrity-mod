# Detection rules

Every rule is deterministic, reads one file's text (MIR-D2 reads the task's observed files), and states its **confidence**:

- `confirmed`: the code literally says it is not done, or an approved exclusion was violated.
- `potential`: suspicious; the finding says what to check.
- `expected`: matches the contract (a prototype's fixtures). Shown, never counted as a problem.

Severity scales with the contract's **intent** (`production`, `prototype`, `unknown`), which comes from the prompt and can be set with `/integrity-contract intent`. Test files, `*.d.ts`, and fixture/mock/story paths are skipped where noted.

## Mirage Detector (JS/TS/React/Next.js)

| Rule | Category | Fires on | Confidence | False-positive guard |
|---|---|---|---|---|
| MIR-E1 | E. Placeholder | `throw new Error("Not implemented" / "TODO")` | confirmed | not in test files |
| MIR-E2 | E. Placeholder | TODO/FIXME whose text defers real work (implement, wire, persist, call the API…) | potential | plain TODOs ignored |
| MIR-E3 | E. Placeholder | `example.com` endpoints, `/api/todo`, `YOUR_API_KEY`, `REPLACE_ME` | potential | — |
| MIR-B1 | B. Simulated success | POST/PUT/PATCH/DELETE handler returns success with no write, query, fetch, service or file call in its body | potential (expected for prototypes) | reading `req.json()` is not IO |
| MIR-B2 | B. Simulated success | `setTimeout`/`sleep` delay plus a success state in the same function, with no request | potential | needs both delay and success |
| MIR-C1 | C. Non-functional control | `onClick={() => {}}`, log/alert-only handlers, `preventDefault()`-only submit, `href="#"` | potential | UI files only |
| MIR-A1 | A. Mock as production | `mock*/fake*/sample*/dummy*` data or imports from `mocks/fixtures/sample` in a shipped view | potential, or expected for prototypes | fixture/mock/story paths skipped |
| MIR-D1 | D. Incomplete integration | `const x = await fetch(...)` never read | potential | any later use clears it |
| MIR-D2 | D. Incomplete integration | client calls `/api/x` that no route file observed in the task serves | potential | only once a route file was observed; dynamic `[id]` and catch-all segments match |
| MIR-F1 | F. Missing persistence | a submit/save handler only sets state or toasts | potential | only when the contract asks for saved/persisted data or intent is production |
| MIR-G1 | G. Authorization | role-gated UI in a component that sends mutating requests; mutating handlers with no session/role/401/403 when the contract mentions permissions | potential | needs both conditions |
| MIR-H1 | H. Failure handling | `await fetch` with no try/catch, `.catch`, `.ok` or status check in its function | potential | — |

## Intent drift

| Rule | Fires on | Confidence |
|---|---|---|
| DRIFT-X1 | change to a path matching a contract exclusion glob | confirmed once approved, potential in a draft |
| DRIFT-S1 | code change outside the contract's scope globs (when scope is set) | potential |
| DRIFT-N1 | a new file whose path names the X of "do not create another/new X" | potential: a file name alone is not proof |
| DRIFT-R1 | a new route file while a preservation requirement protects navigation/routes | potential |
| DRIFT-D1 | a code file deleted | potential (high with preservation requirements) |
| DRIFT-W1 | an update keeping under 40% of a 30+ line file | potential |
| DRIFT-P1 | `package.json` gains dependencies the contract never mentions | potential |

Drift findings are history: a later edit does not auto-resolve them. Acknowledge or waive them.

## Suppression

A finding's id is a fingerprint of rule, file and normalized line text, so it survives line moves. Acknowledged and waived findings keep their status on every later scan, and a hint is shown at most once per finding. A fixed pattern resolves its finding automatically (mirage rules only).

## Adding a rule

Append a `MirageRule` to `RULES` in `src/engine/mirage.ts` (`appliesTo(path)`, `detect(ctx)`), and add a fixture and test in `tests/mirage.test.ts`. Rules for other languages follow the same interface.
