# Changelog

## 0.1.0

First public release.

- **Intent Fingerprint**: a requirement contract captured from your own words (no model call), reviewed with `/integrity-contract`, frozen with `/integrity-approve`, and amended in versioned revisions. Stored per repository, outside the conversation, so compaction cannot drop it.
- **Mirage Detector**: twelve rules for code that looks finished but isn't (placeholder throws, success responses with no write, inert buttons, mock data in shipped views, unread fetches, calls to routes that don't exist, missing error handling), and seven intent-drift rules (excluded paths, out-of-scope edits, a second copy of something you said not to recreate, deletions, rewrites, new dependencies). Each finding says whether it is confirmed, potential or expected.
- **The Witness**: test, build, lint, typecheck, migration and browser-test runs become evidence, tied to the source state they ran against. Denied, synthetic, background, interrupted and exit-masked runs never count as a pass. Later edits make evidence stale.
- **Claim Auditor**: "all tests pass", "it's implemented" and similar lines in Claude's final answer are checked against the evidence. Unsupported or contradicted claims get a short note beneath the answer; the answer itself is never rewritten.
- **Dashboard pane** (`/integrity`), drawn in the style of Claude Flightdeck: a centered title and color legend, rounded cards for the contract, evidence, findings and claims, a strip with one cell per requirement, a `▰▱` progress gauge, the top concern and an activity log. Overview, Requirements, Evidence, Findings, Claims, Activity and Report views on keys `1`-`7`, with drill-downs, acknowledge, waive (with a reason) and export. Two columns from 110 columns, one below, and a three-line summary inline above the prompt. Theme colors, and glyphs that carry every state with color off.
- **Short aliases**: `/ig` (= `/integrity`, which also takes subcommands: `/ig check`), `/igc` contract, `/iga` approve, `/igv` verify, `/igf` findings, `/igr` report.
- **Modes**: observe (default), review, and strict, which refuses edits to excluded paths and makes `claude -p "/integrity-check"` exit 1 as a CI gate.
- **Reports**: Markdown and JSON exports to `.claude/integrity/`.
- 66 tests: the pure engine, and the real hooks and pane through `claude-code/testing`.
