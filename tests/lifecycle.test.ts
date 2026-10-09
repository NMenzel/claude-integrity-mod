// The Mod end to end through the engine's own hook chain: capture, observe,
// enforce, report, persist. (Spec tests 32-36 and the integration fixtures.)

import { expect, test } from 'claude-code/testing'

import * as E from '../src/engine/index'
import { INCOMPLETE_REGISTRATION, OUTPUT } from '../fixtures/projects'
import { bash, cmd, ROOT, START, world, write } from './world'

const KEY = E.projectKey(ROOT, 'git@example.org:acme/app.git')
const project = (w: { store: Map<string, unknown> }): E.ProjectRecord => w.store.get(KEY) as E.ProjectRecord
const prompt = (text: string, kind: 'composer' | 'task-notification' = 'composer') =>
  ({ text, wait: false, origin: kind === 'composer' ? { kind } : { kind, taskId: 't' } }) as never

test('auto-captures a draft from an implementation prompt, never from questions or notifications', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.prompt.submit(prompt('How is the event list sorted today?'))
  await $.prompt.submit(prompt('Implement event registration; registrations must be saved.', 'task-notification'))
  expect(project(w)?.activeTaskId).toBeUndefined()
  await $.prompt.submit(prompt('Implement event registration on the Discover page. Registrations must be saved to the database. Do not modify app/legacy/**.'))
  const task = E.activeTask(project(w))!
  expect(task.contract.approval.status).toBe('draft')
  expect(task.contract.exclusions).toEqual(['app/legacy/**'])
  expect(w.status.at(-1)).toBe('Integrity ◇ draft contract · /integrity')
})

test('observes edits: mirage findings toast once, not on every edit (no spam)', async ($, on) => {
  const w = world(on, { files: INCOMPLETE_REGISTRATION })
  await $.session.start(START)
  await $.command.run(cmd('integrity-start', 'Let users register for events. Registrations must be saved to the database.'))
  w.answer = () => write('create')
  const content = INCOMPLETE_REGISTRATION['lib/registration.ts']
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/lib/registration.ts`, content })
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/lib/registration.ts`, content })
  expect(w.toasts.filter(t => t.includes('lib/registration.ts'))).toEqual(['Integrity: placeholder implementation in lib/registration.ts:2 · /integrity findings'])
  // An Edit is read back from disk after it ran.
  w.answer = () => ({ ref: 2, result: { filePath: '', oldString: '', newString: '', originalFile: '', structuredPatch: [], userModified: false, replaceAll: false }, text: 'ok' })
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/components/RegisterPanel.tsx`, old_string: 'a', new_string: 'b' })
  const ids = E.activeTask(project(w))!.findings.map(f => f.ruleId)
  expect(ids).toContain('MIR-C1')
  expect(w.status.at(-1)).toMatch(/^Integrity .*! \d+ findings/)
})

test('a refused, failed or plugin-answered write records no change', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.command.run(cmd('integrity-start', 'Add sorting to the event list. Tests must pass.'))
  w.answer = () => ({ deny: 'The user declined' })
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/a.ts`, content: 'x' })
  w.answer = () => ({ result: { type: 'create' } }) as never
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/b.ts`, content: 'x' })
  expect(E.activeTask(project(w))!.files).toEqual({})
})

test('32. switches modes; strict refuses edits to approved exclusions, observe only reports them', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.command.run(cmd('integrity-start', 'Add CSV export to reports. Do not modify app/legacy/**.'))
  await $.command.run(cmd('integrity-approve'))
  expect((await $.command.run(cmd('integrity-mode', 'strict'))).text).toContain('Mode set to **strict**')
  w.answer = () => write('update', 'old')
  const denied = await $.tool.call({ tool: 'Write', file_path: `${ROOT}/app/legacy/report.ts`, content: 'x' })
  expect(denied.deny).toContain('excluded by the approved contract ("app/legacy/**")')
  const allowed = await $.tool.call({ tool: 'Write', file_path: `${ROOT}/app/reports/csv.ts`, content: 'x' })
  expect(allowed.deny).toBeUndefined()

  await $.command.run(cmd('integrity-mode', 'observe'))
  const observed = await $.tool.call({ tool: 'Write', file_path: `${ROOT}/app/legacy/report.ts`, content: 'x' })
  expect(observed.deny).toBeUndefined()
  expect(E.activeTask(project(w))!.findings.find(f => f.ruleId === 'DRIFT-X1')?.confidence).toBe('confirmed')
  expect(project(w).mode).toBe('observe')
})

test('33. exports a valid report whose counts match the canonical summary', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.command.run(cmd('integrity-start', 'Add sorting to the event list. Tests must pass. It should keep the current order for equal dates.'))
  w.answer = () => bash(OUTPUT.jestPass)
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  const r = await $.command.run(cmd('integrity-report', 'export'))
  expect(r.text).toMatch(/Exported \.claude\/integrity\/t-.+\.md and \.claude\/integrity\/t-.+\.json\./)
  const json = JSON.parse([...w.written.entries()].find(([k]) => k.endsWith('.json'))![1]) as { schema: string; summary: E.Summary; requirements: { state: string }[] }
  const md = [...w.written.entries()].find(([k]) => k.endsWith('.md'))![1]
  const s = E.summarize(E.activeTask(project(w)), 'observe')
  expect(json.schema).toBe('claude-integrity/report@1')
  expect(json.summary.requirements).toEqual(s.requirements)
  expect(json.requirements.map(x => x.state)).toEqual(['verified', 'unverified'])
  expect(md).toContain(`| ${s.requirements.verified}/${s.requirements.total} |`)
  expect([...w.written.keys()].every(k => k.startsWith(`${ROOT}/.claude/integrity/`))).toBe(true)
})

test('34. headless: commands answer in text, and strict /integrity-check exits 1 on violations', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: ROOT, surface: null, isInteractive: false })
  await $.command.run(cmd('integrity-start', 'Add sorting to the event list. Tests must pass.'))
  await $.command.run(cmd('integrity-contract', 'check R1 npm test'))
  await $.command.run(cmd('integrity-approve'))
  await $.command.run(cmd('integrity-mode', 'strict'))
  const failing = await $.command.run(cmd('integrity-check'))
  expect(failing.exitCode).toBe(1)
  expect(failing.text).toContain('R1 required check has not passed')
  w.answer = () => bash(OUTPUT.jestPass)
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  const passing = await $.command.run(cmd('integrity-check'))
  expect(passing.exitCode).toBeUndefined()
  expect(passing.text).toContain('Policies: none violated.')
  expect((await $.command.run(cmd('integrity-report', 'md'))).text).toContain('# Claude Integrity report')
})

test('short aliases answer exactly as the commands they stand for; /ig takes subcommands', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: ROOT, surface: null, isInteractive: false })
  for (const name of ['ig', 'igc', 'iga', 'igv', 'igf', 'igr']) expect(w.commands).toContain(name)
  await $.command.run(cmd('ig', 'start Add sorting to the event list. Tests must pass.'))
  expect((await $.command.run(cmd('igc'))).text).toBe((await $.command.run(cmd('integrity-contract'))).text)
  await $.command.run(cmd('igc', 'check R1 npm test'))
  expect((await $.command.run(cmd('iga'))).text).toContain('pproved')
  await $.command.run(cmd('ig', 'mode strict'))
  expect((await $.command.run(cmd('ig', 'check'))).exitCode).toBe(1)
  expect((await $.command.run(cmd('igv', 'R1 ran the suite locally: green'))).text).toContain('R1')
  expect((await $.command.run(cmd('igf'))).text).toBe((await $.command.run(cmd('integrity-findings'))).text)
  expect((await $.command.run(cmd('igr', 'md'))).text).toContain('# Claude Integrity report')
})

test('35. state survives a reload: what one load stored, the next load reads', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.command.run(cmd('integrity-start', 'Add sorting to the event list. Tests must pass.'))
  w.answer = () => bash(OUTPUT.jestPass)
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  const stored = JSON.parse(JSON.stringify(project(w))) as E.ProjectRecord
  // What a fresh load computes from the stored record alone equals what this load shows.
  expect(E.summarize(E.activeTask(stored), stored.mode)).toEqual(E.summarize(E.activeTask(project(w)), 'observe'))
  expect(E.activeTask(stored)!.evidence[0]).toMatchObject({ outcome: 'pass', revision: 'abc1234' })
})

test('36. retention and storage limits: idle tasks expire, lists stay bounded', () => {
  const T0 = 1_760_000_000_000
  const p = E.newProject('k', 'acme/app', 's', T0)
  const old = E.startTask(p, 'Add a legacy importer for CSV files.', 'prompt', T0 - 90 * 86_400_000)
  old.updatedAt = T0 - 90 * 86_400_000
  const active = E.startTask(p, 'Add sorting to the event list. Tests must pass.', 'prompt', T0)
  for (let i = 0; i < 400; i++) {
    E.recordTool(active, { tool: 'Bash', input: { command: 'npm test' }, ranInCore: true, isError: false, text: OUTPUT.jestPass, result: { stdout: OUTPUT.jestPass, stderr: '', interrupted: false } }, T0 + i)
  }
  expect(active.evidence.length).toBe(200)
  expect(active.activity.length).toBe(200)
  E.trimProject(p, T0, 30, 40_000)
  expect(p.tasks[old.id]).toBeUndefined()
  expect(p.tasks[active.id]).toBeDefined()
  expect(JSON.stringify(p).length).toBeLessThan(40_000)
})

test('concurrent sessions merge instead of overwriting each other', () => {
  const T0 = 1_760_000_000_000
  const base = E.newProject('k', 'acme/app', 'A', T0)
  const task = E.startTask(base, 'Add sorting to the event list. Tests must pass.', 'prompt', T0)
  const a = JSON.parse(JSON.stringify(base)) as E.ProjectRecord
  const b = JSON.parse(JSON.stringify(base)) as E.ProjectRecord
  b.writer = 'B'
  const bash1 = { tool: 'Bash', input: { command: 'npm test' }, ranInCore: true, isError: false, text: OUTPUT.jestPass, result: { stdout: OUTPUT.jestPass, stderr: '', interrupted: false } }
  E.recordTool(a.tasks[task.id]!, bash1, T0 + 1)
  E.recordTool(b.tasks[task.id]!, { ...bash1, input: { command: 'npm run lint' } }, T0 + 2)
  const stored = E.mergeProjects(b, undefined, T0 + 3)
  const merged = E.mergeProjects(a, stored, T0 + 4)
  expect(merged.tasks[task.id]!.evidence.map(e => e.command)).toEqual(['npm test', 'npm run lint'])
  expect(merged.tasks[task.id]!.evidence.map(e => e.id)).toEqual(['E1', 'E1b'])
  // Both sessions edited the same contract version: ours kept, theirs saved as a revision, once.
  a.tasks[task.id]!.contract.requirements.push(E.makeRequirement([], 'A-only'))
  const again = E.mergeProjects(a, stored, T0 + 5)
  const twice = E.mergeProjects(again, stored, T0 + 6)
  expect(twice.tasks[task.id]!.contract.revisions.filter(r => r.change.startsWith('concurrent'))).toHaveLength(1)
})

test('reset asks first, then deletes; manual verification and waivers work by command', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.command.run(cmd('integrity-start', 'Add an export button to the report page. It must download a CSV.'))
  await $.command.run(cmd('integrity-contract', 'verify-by R1 manual'))
  expect((await $.command.run(cmd('integrity-verify', 'R1 clicked export; the CSV opened in Excel'))).text).toContain('(verified)')
  expect((await $.command.run(cmd('integrity-waive', 'R1'))).text).toContain('A reason is required')
  // The dialog is dismissed: the command explains how to confirm instead of deleting.
  w.answer = () => ({ deny: 'dismissed' })
  expect((await $.command.run(cmd('integrity-reset'))).text).toContain('/integrity-reset confirm')
  expect(E.activeTask(project(w))).toBeDefined()
  expect((await $.command.run(cmd('integrity-reset', 'confirm'))).text).toContain('Deleted task')
  expect(E.activeTask(project(w))).toBeUndefined()
  expect(w.status.at(-1)).toBeUndefined()
})

test('opt-in AI: off by default and makes no call; on, proposals are marked and cached', async ($, on) => {
  let calls = 0
  on('model.complete', () => (calls++, { value: { isAnswered: true as const, text: '- Events sort by start time\n- Ties keep insertion order', usage: { input_tokens: 120, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }))
  world(on)
  await $.session.start(START)
  await $.command.run(cmd('integrity-start', 'Add sorting to the event list.'))
  expect((await $.command.run(cmd('integrity-suggest'))).text).toContain('AI suggestions are off')
  expect(calls).toBe(0)
})

test('opt-in AI when enabled: proposed requirements, usage shown, cached', { options: { aiAssist: true } }, async ($, on) => {
  let calls = 0
  on('model.complete', () => (calls++, { value: { isAnswered: true as const, text: '- Events sort by start time\n- Ties keep insertion order', usage: { input_tokens: 120, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }))
  const w = world(on)
  await $.session.start(START)
  await $.command.run(cmd('integrity-start', 'Add sorting to the event list.'))
  const r = await $.command.run(cmd('integrity-suggest'))
  expect(r.text).toContain('Added 2 **proposed** requirement(s) (120 input + 20 output tokens)')
  await $.command.run(cmd('integrity-suggest'))
  expect(calls).toBe(1)
  const reqs = E.activeTask(project(w))!.contract.requirements
  expect(reqs.filter(x => x.origin === 'proposed').map(x => x.criticality)).toEqual(['should', 'should', 'should', 'should'])
  // A model's proposal never verifies anything by itself.
  expect(reqs.every(x => E.requirementState(x, E.activeTask(project(w))!).state === 'unverified')).toBe(true)
})
