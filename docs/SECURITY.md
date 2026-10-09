# Security and privacy

## What the Mod sees

It runs inside your Claude Code session and observes your **prompts**, **tool calls and their output**, and the **files** Claude edits (it reads them back to scan them). That is private source code and private intent. Install it only where that is acceptable.

## What it does by default

- **Local only.** No telemetry, no network calls (`$.http` is never used).
- **No arbitrary execution.** The only processes it runs are `git rev-parse --short HEAD` and `git status --porcelain --untracked-files=no`, read-only and with a 3 s timeout, for evidence provenance. Turn this off with the `gitProvenance` option.
- **No code changes, no installs.** It writes files only when you export a report (`.claude/integrity/` in the project). It never creates or edits `CLAUDE.md` or other instruction files.
- **No requirement rewriting.** Captured requirements are your sentences. Model suggestions are opt-in, marked `proposed`, and need your approval.
- **Never weakens permissions.** It only *adds* a refusal (strict mode, excluded paths). Claude Code's permission checks and sandbox still run beneath it and remain the trust boundary.

## What it stores

In its own `$.store` file under your Claude Code config directory, keyed per repository:

- the contract: requirements, exclusions, scope and revisions, plus a **hash** of the original prompt and a **280-character redacted excerpt**. The full prompt is never stored.
- evidence summaries: the redacted command (240 characters max), outcome, counts, basis, revision, timestamps. **No raw tool output is stored.**
- findings: rule, file, line, a 140-character redacted snippet.
- claims: the claim sentence (200 characters max, redacted) and its verdict.

**Redaction** (`src/engine/util.ts`) removes private keys, AWS/GitHub/Slack/`sk-` keys, JWTs, Bearer/Basic credentials, credentials in URLs, `*token*/*secret*/*password*/*key*=value` assignments, and home-directory paths.

**Retention:** tasks idle longer than `retentionDays` (default 30) are deleted, at most 20 tasks per project are kept, and each record is trimmed to 600 kB. `/integrity-reset` deletes the active task; `/integrity-reset all` deletes the project's data.

## Opt-in AI

`/integrity-suggest` runs only when `aiAssist` is on and you invoke it. It sends the redacted prompt (at most 4,000 characters) and the current requirement texts to **this session's own model provider** through `$.model.complete`, never to any other service. It reports the token usage and caches results per prompt. No autonomous or looping model calls exist.

## Threats not covered

- A malicious plugin beneath Integrity could answer tool calls itself. Integrity detects this (no core `ref`) and refuses to count such results, but it cannot see what that plugin really did.
- Commands run outside Claude Code (your own terminal, CI) are invisible to it.
