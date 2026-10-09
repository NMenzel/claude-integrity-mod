// Completion Claim Auditor. (Spec tests 23-28.)

import type { Register } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import * as E from '../src/engine/index'
import { MOCK_AS_LIVE, OUTPUT } from '../fixtures/projects'
import { bash, cmd, START, world } from './world'

const T0 = 1_760_000_000_000

function task(): E.Task {
  return E.startTask(E.newProject('k', 'acme/app', 's', T0), 'Add sorting to the event list. Tests must pass.', 'prompt', T0)
}
const ran = (t: E.Task, command: string, stdout: string, isError = false) =>
  E.recordTool(t, { tool: 'Bash', input: { command }, ranInCore: true, isError, text: stdout, result: { stdout, stderr: '', interrupted: false } }, T0)
const audit = (t: E.Task, answer: string) => E.auditAnswer(answer, t, 'turn-1', T0 + 10)

test('23. a claim with fresh matching evidence is supported', () => {
  const t = task()
  ran(t, 'npm test', OUTPUT.jestPass)
  const [c] = audit(t, 'I added the sort order. All 24 tests pass.')
  expect(c).toMatchObject({ kind: 'tests-pass', verdict: 'supported', evidenceIds: ['E1'] })
  expect(c?.reason).toContain('exit 0')
})

test('24. "all tests pass" with no test run is unsupported', () => {
  const [c] = audit(task(), 'Done! All tests pass and the build is green.')
  expect(c).toMatchObject({ kind: 'tests-pass', verdict: 'unsupported', reason: 'no test run was observed for this task' })
})

test('25. a claim contradicted by a failed test run', () => {
  const t = task()
  ran(t, 'npm test', OUTPUT.jestFail, true)
  expect(audit(t, 'All tests pass.')[0]).toMatchObject({ verdict: 'contradicted', evidenceIds: ['E1'] })
  // A later passing run of the same check supersedes the failure.
  ran(t, 'npm test', OUTPUT.jestPass)
  expect(audit(t, 'All tests pass.')[0]?.verdict).toBe('supported')
})

test('26. missing evidence is reported as unsupported, never as a failure', () => {
  const t = task()
  const claims = audit(t, 'The build succeeds. Lint is clean. The migration was applied.')
  expect(claims.map(c => [c.kind, c.verdict])).toEqual([['build', 'unsupported'], ['lint', 'unsupported'], ['migration', 'unsupported']])
  expect(claims.some(c => c.verdict === 'contradicted')).toBe(false)
})

test('27. a passing unit test does not prove a browser journey', () => {
  const t = task()
  ran(t, 'npm test', OUTPUT.jestPass)
  const [c] = audit(t, 'The registration flow works in the browser.')
  expect(c).toMatchObject({ kind: 'browser', verdict: 'unsupported' })
  expect(c?.reason).toContain('unit tests do not prove a browser journey')
  ran(t, 'npx playwright test e2e/register.spec.ts', '  3 passed (4s)')
  expect(audit(t, 'The registration flow works in the browser.')[0]?.verdict).toBe('supported')
})

test('hedges, negations and instructions are not claims', () => {
  expect(audit(task(), "I didn't run the tests. Tests should pass once the API is up. Run `npm test` to verify.")).toEqual([])
})

test('broad claims over narrow evidence are partial; live-data and production-ready are judged honestly', () => {
  const t = task()
  ran(t, 'npx vitest run src/events', OUTPUT.vitestSkipped)
  expect(audit(t, 'All tests pass.')[0]).toMatchObject({ verdict: 'partial' })
  expect(audit(t, 'Unit and integration tests pass.')[0]?.reason).toContain('no integration/e2e run')
  expect(audit(t, 'It is production-ready.')[0]?.verdict).toBe('not-assessable')

  const live = task()
  E.recordChange(live, { path: 'app/discover/page.tsx', kind: 'update', after: MOCK_AS_LIVE['app/discover/page.tsx'] }, T0)
  const [c] = audit(live, 'Events are now fetched from the live API.')
  expect(c).toMatchObject({ kind: 'live-data', verdict: 'contradicted' })
  expect(c?.reason).toContain('potentially contradicted')
})

const synopsis: Register = on => {
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    return { ...r, text: r.text === e.answer ? 'TL;DR: sorting added' : `${r.text}\nTL;DR: sorting added` }
  })
}

test('28. appends a verification notice beneath the answer, keeping another plugin\'s line', { plugins: [{ name: 'synopsis', register: synopsis }] }, async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.command.run(cmd('integrity-start', 'Add sorting to the event list. Tests must pass.'))
  const answer = 'Sorting is implemented. All tests pass.'
  const r = await $.turn.complete({ answer, durationMs: 1000, isAborted: false, reason: 'answer', turnId: 'turn-1' })
  expect(r.text).not.toBe(answer) // a different text is shown beneath the answer; the answer itself is untouched
  expect(r.text).toContain('TL;DR: sorting added')
  expect(r.text).toContain('Integrity · 2 completion claims checked')
  expect(r.text).toContain('? "All tests pass.": no test run was observed for this task')

  // With evidence, nothing to flag: at the default level the answer passes through untouched.
  w.answer = () => bash(OUTPUT.jestPass)
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  const quiet = await $.turn.complete({ answer: 'All tests pass.', durationMs: 1000, isAborted: false, reason: 'answer', turnId: 'turn-2' })
  expect(quiet.text).toContain('TL;DR')
  expect(quiet.text).not.toContain('Integrity')
})

test('a subagent\'s turn is not audited as the main answer', async ($, on) => {
  world(on)
  await $.session.start(START)
  await $.command.run(cmd('integrity-start', 'Add sorting to the event list. Tests must pass.'))
  const r = await $.turn.complete({ answer: 'All tests pass.', durationMs: 5, isAborted: false, reason: 'answer', turnId: 's1', agentId: 'agent-7' })
  expect(r.text).toBe('All tests pass.')
})
