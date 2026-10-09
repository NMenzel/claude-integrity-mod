# Contributing

Issues and pull requests are welcome.

## Set up

```sh
git clone https://github.com/NMenzel/claude-integrity-mod
cd claude-integrity-mod
npm install                      # local TypeScript only
claude --plugin-dir .
```

Edits to `hooks/` and `src/` hot-reload in that session when Claude's turn ends.

## Before a pull request

```sh
claude plugin validate . --strict
claude plugin test .
npx tsc -p .
```

All three must pass. The type check needs `.claude-plugin/types/`, which
Claude Code writes the first time it loads the mod. To write it without an
interactive session, run `claude -p --plugin-dir . "/integrity-help"` once.

## Ground rules

- **Judge in `src/engine/`, act in `hooks/register.tsx`.** The engine is pure TypeScript with tests and never sees `$`. The validator only lets `$` reach top-level functions of the hooks file, so every API call lives there.
- **Nothing is verified because a model said so.** A requirement is verified only by a real, passing, current check of a kind that can prove it, or by the developer's own confirmation.
- **Say how sure a finding is.** `confirmed` only when the code literally says it is not done or an approved exclusion was violated. Anything else is `potential`, or `expected` when the contract allows it.
- **Never weaken permissions, never rewrite the answer.** Integrity may add a refusal (strict mode) and a note beneath an answer. It never approves a call and never replaces what Claude said.
- **No secrets, no raw output.** Everything stored goes through `redact` in `src/engine/util.ts`, and no raw tool output is kept.
- **A new detection rule ships with a fixture and a test** (see [docs/DETECTION-RULES.md](docs/DETECTION-RULES.md)).

When you report a bug, include `claude --version` and any `integrity:` line from `claude --debug`.
