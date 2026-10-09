// The Witness: evidence from observed tool calls, its provenance and freshness. (Spec tests 14-22.)

import { expect, test } from 'claude-code/testing'

import * as E from '../src/engine/index'
import { OUTPUT } from '../fixtures/projects'
import { bash, cmd, START, world } from './world'

const T0 = 1_760_000_000_000

function task(prompt = 'Add sorting to the event list. Tests must pass.'): E.Task {
  return E.startTask(E.newProject('k', 'acme/app', 's', T0), prompt, 'prompt', T0)
}

const obs = (command: string, fields: Partial<E.ToolObservation> = {}): E.ToolObservation => ({
  tool: 'Bash', input: { command }, ranInCore: true, isError: false, text: '', result: { stdout: '', stderr: '', interrupted: false }, ...fields,
})
const run = (command: string, stdout: string, isError = false, extra: Record<string, unknown> = {}) =>
  obs(command, { isError, text: stdout, result: { stdout, stderr: '', interrupted: false, ...extra } })

test('14. records a successful test run with its exit status and counts', () => {
  const t = task()
  const { evidence } = E.recordTool(t, run('npm test', OUTPUT.jestPass), T0)
  expect(evidence).toHaveLength(1)
  expect(evidence[0]).toMatchObject({ id: 'E1', check: 'test', kind: 'test-result', outcome: 'pass', basis: 'exit 0', counts: { passed: 24, failed: 0, skipped: 0 } })
  // A test requirement ("Tests must pass") is linked automatically and verified.
  expect(E.requirementState(t.contract.requirements[0]!, t).state).toBe('verified')
})

test('15. records a failed test run', () => {
  const t = task()
  const { evidence, hints } = E.recordTool(t, run('npx jest', OUTPUT.jestFail, true), T0)
  expect(evidence[0]).toMatchObject({ outcome: 'fail', counts: { passed: 23, failed: 1 } })
  expect(hints[0]?.text).toContain('test failed')
  expect(E.requirementState(t.contract.requirements[0]!, t).state).toBe('failed')
})

test('16. a permission denial is never a successful check', () => {
  const t = task()
  const { evidence } = E.recordTool(t, obs('npm test', { denied: 'The user declined', ranInCore: false }), T0)
  expect(evidence[0]).toMatchObject({ outcome: 'inconclusive', basis: 'permission denied: not executed' })
  expect(E.requirementState(t.contract.requirements[0]!, t).state).toBe('unverified')
})

test('17. evidence goes stale after a relevant source change', () => {
  const t = task()
  E.recordTool(t, run('npm test', OUTPUT.jestPass), T0)
  const hints = E.recordChange(t, { path: 'src/events.ts', kind: 'update', after: 'export const x = 1' }, T0 + 1)
  expect(E.freshness(t.evidence[0]!, t)).toBe('stale')
  expect(E.staleBecause(t.evidence[0]!, t)).toEqual(['src/events.ts'])
  expect(hints.map(h => h.text)).toContain('Integrity: test evidence is stale after src/events.ts changed · /integrity evidence')
  expect(E.requirementState(t.contract.requirements[0]!, t).state).toBe('stale')
  expect(E.summarize(t, 'observe').evidence).toMatchObject({ fresh: 0, stale: 1 })
})

test('18. unrelated changes leave evidence fresh', () => {
  const t = task()
  E.recordTool(t, run('npx vitest run src/events', OUTPUT.vitestSkipped), T0)
  E.recordTool(t, run('npm run lint', ''), T0)
  E.recordChange(t, { path: 'src/billing/invoice.ts', kind: 'update', after: 'x' }, T0 + 1)
  E.recordChange(t, { path: 'README.md', kind: 'update', after: '# docs' }, T0 + 1)
  const [scoped, lint] = t.evidence
  expect(scoped?.scope).toEqual(['src/events'])
  expect(E.freshness(scoped!, t)).toBe('unrelated') // still valid: nothing it covers changed
  expect(E.freshness(lint!, t)).toBe('stale') // whole-project lint: a code change anywhere invalidates it
  E.recordChange(t, { path: 'src/events/sort.ts', kind: 'update', after: 'x' }, T0 + 2)
  expect(E.freshness(scoped!, t)).toBe('stale')
})

test('19. synthetic tool results are never proof of execution', () => {
  const t = task()
  const { evidence } = E.recordTool(t, run('npm test', OUTPUT.jestPass, false), T0)
  expect(evidence[0]?.synthetic).toBeUndefined()
  const fake = E.recordTool(t, { ...run('npm test', OUTPUT.jestPass), ranInCore: false }, T0 + 1)
  expect(fake.evidence[0]).toMatchObject({ synthetic: true, outcome: 'inconclusive' })
  const only = task()
  E.recordTool(only, { ...run('npm test', OUTPUT.jestPass), ranInCore: false }, T0)
  expect(E.requirementState(only.contract.requirements[0]!, only).state).toBe('unverified')
  expect(E.auditAnswer('All tests pass.', only, 't1', T0)[0]).toMatchObject({ verdict: 'unsupported' })
})

test('19b. through the Mod: a plugin-answered Bash call (no core ref) is recorded as synthetic', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.command.run(cmd('integrity-start', 'Add sorting to the event list. Tests must pass.'))
  w.answer = () => ({ result: { stdout: OUTPUT.jestPass, stderr: '', interrupted: false } })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  const text = (await $.command.run(cmd('integrity-evidence'))).text
  expect(text).toContain('synthetic: answered by a plugin, not executed')
})

test('20. provenance: redacted command, revision, working directory, source and sequence', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.command.run(cmd('integrity-start', 'Add sorting to the event list. Tests must pass.'))
  w.answer = () => bash(OUTPUT.jestPass)
  await $.tool.call({ tool: 'Bash', command: 'API_TOKEN=s3cr3t-value npm test' })
  const p = [...w.store.values()].find(v => (v as E.ProjectRecord).schema === 1) as E.ProjectRecord
  const ev = E.activeTask(p)!.evidence[0]!
  expect(ev).toMatchObject({ source: 'Bash', command: 'API_TOKEN=*** npm test', revision: 'abc1234', cwd: '/repo/app', seq: 0, outcome: 'pass' })
  expect(JSON.stringify(p)).not.toContain('s3cr3t')
  expect(w.argv).toContainEqual(['git', 'rev-parse', '--short', 'HEAD'])
})

test('21. a truncated result keeps its exit status but says the summary was not seen', () => {
  const t = task()
  const { evidence } = E.recordTool(t, run('npm test', OUTPUT.truncated, false, { persistedOutputPath: '/tmp/out.txt' }), T0)
  expect(evidence[0]).toMatchObject({ outcome: 'pass', truncated: true })
  expect(E.auditAnswer('All tests pass.', t, 't1', T0)[0]).toMatchObject({ verdict: 'partial' })
})

test('22. interrupted, backgrounded, timed-out and exit-masked runs are inconclusive', () => {
  const t = task()
  const cases = [
    run('npm test', '', false, { interrupted: true }),
    run('npm test', '', false, { backgroundTaskId: 'b1' }),
    run('npm test', '', false, { timedOutAfterMs: 120000 }),
    run('npm test | tail -3', 'some output'),
    run('npm test || true', 'x'),
  ]
  const outcomes = cases.map(c => E.recordTool(t, c, T0).evidence[0]?.outcome)
  expect(outcomes).toEqual(['inconclusive', 'inconclusive', 'inconclusive', 'inconclusive', 'inconclusive'])
  // A masked exit with a readable summary counts, and says how it was judged.
  const masked = E.recordTool(t, run('npm test | tail -5', OUTPUT.jestPass), T0).evidence[0]
  expect(masked).toMatchObject({ outcome: 'pass', basis: 'output summary; exit status masked by a pipe or `|| true`' })
  // Exit 0 with no tests run proves nothing.
  const zero = E.recordTool(t, run('npx jest --passWithNoTests', OUTPUT.noTests), T0).evidence[0]
  expect(zero).toMatchObject({ outcome: 'inconclusive', basis: 'exit 0 but no tests ran' })
})

test('22b. through the Mod: an interrupted turn is not audited', async ($, on) => {
  world(on)
  await $.session.start(START)
  await $.command.run(cmd('integrity-start', 'Add sorting to the event list. Tests must pass.'))
  const r = await $.turn.complete({ answer: 'All tests pass.', durationMs: 10, isAborted: true, reason: 'aborted', turnId: 't1' })
  expect(r.text).toBe('All tests pass.')
  const log = (await $.command.run(cmd('integrity', 'claims'))).text
  expect(log).not.toContain('unsupported')
})

test('runner summaries: vitest, pytest, mocha, node:test; chains and classification', () => {
  expect(E.parseCounts(OUTPUT.vitestSkipped)).toEqual({ passed: 20, failed: 0, skipped: 3 })
  expect(E.parseCounts(OUTPUT.pytest)).toEqual({ passed: 12, failed: 0, skipped: 1 })
  expect(E.parseCounts(OUTPUT.mocha)).toEqual({ passed: 18, failed: 2, skipped: 0 })
  expect(E.parseCounts(OUTPUT.nodeTest)).toEqual({ passed: 9, failed: 0, skipped: 0 })
  expect(E.classifyCommand('npm run lint && npm test && npx playwright test e2e/signup.spec.ts').map(c => c.check)).toEqual(['lint', 'test', 'browser'])
  expect(E.classifyCommand('git status')).toEqual([])
  expect(E.classifyCommand('npx tsc -p .')[0]?.check).toBe('typecheck')
  // A failed chain: only the check whose own output shows failures is marked failed.
  const t = task()
  const chain = E.recordTool(t, run('npm run lint && npm test', OUTPUT.jestFail, true), T0).evidence
  expect(chain.map(e => [e.check, e.outcome])).toEqual([['lint', 'inconclusive'], ['test', 'fail']])
})

test('manual confirmation verifies a manual requirement and goes stale after related changes', () => {
  const t = task('Add an export button to the report page.')
  const r = E.makeRequirement(t.contract.requirements, 'Export downloads a CSV', { verification: 'manual' })
  t.contract.requirements.push(r)
  E.recordTool(t, run('npm test', OUTPUT.jestPass), T0)
  expect(E.requirementState(r, t).state).toBe('unverified') // a unit test cannot verify a manual requirement
  E.recordManual(t, r.id, 'clicked export, opened the CSV', T0)
  expect(E.requirementState(r, t).state).toBe('verified')
  E.recordChange(t, { path: 'app/report/Export.tsx', kind: 'update', after: 'x' }, T0 + 1)
  expect(E.requirementState(r, t).state).toBe('stale')
})
