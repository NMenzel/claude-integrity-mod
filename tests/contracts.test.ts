// Intent Fingerprint: contracts are captured from the developer's words,
// approved, versioned, persisted and kept per repository. (Spec tests 1-7.)

import { expect, test } from 'claude-code/testing'

import * as E from '../src/engine/index'
import { cmd, ROOT, START, world } from './world'

const DISCOVER = 'Enrich the existing Discover page with better event information. Preserve the current navigation and do not create another Discover page.'
const T0 = 1_760_000_000_000

test('1. preserves the original task request by hash and excerpt', () => {
  const p = E.newProject('k', 'acme/app', 's', T0)
  const task = E.startTask(p, DISCOVER, 'prompt', T0)
  expect(task.contract.prompt.hash).toBe(E.hash(DISCOVER))
  expect(task.contract.prompt.excerpt).toBe(DISCOVER)
  expect(task.contract.summary).toBe('Enrich the existing Discover page with better event information.')
  expect(p.activeTaskId).toBe(task.id)
})

test('2. extracts explicit preservation constraints, and only those', () => {
  const c = E.createContract('t', DISCOVER, T0, 'prompt')
  const preserve = c.requirements.filter(r => r.category === 'preservation')
  expect(preserve.map(r => r.description)).toEqual(['Preserve the current navigation and do not create another Discover page.'])
  expect(preserve[0]?.criticality).toBe('must')
  expect(preserve[0]?.origin).toBe('explicit')
  // The first sentence is an instruction, not an acceptance criterion: nothing is invented for it.
  expect(c.requirements).toHaveLength(1)
  expect(E.isMeaningfulTask(DISCOVER)).toBe(true)
  expect(E.isMeaningfulTask('How does the Discover page load its events?')).toBe(false)
  expect(E.isMeaningfulTask('fix it')).toBe(false)
})

test('2b. path exclusions and intent come from the prompt', () => {
  const c = E.createContract('t', 'Add a CSV export to the reports page. Do not modify app/legacy/** or `lib/billing/*`. It must persist settings to the database.', T0, 'prompt')
  expect(c.exclusions).toEqual(['app/legacy/**', 'lib/billing/*'])
  expect(c.intent).toBe('production')
  expect(E.createContract('t', 'Build a clickable prototype of the dashboard with sample data.', T0, 'prompt').intent).toBe('prototype')
})

test('3. creates a contract through the Mod without any model call', async ($, on) => {
  // No model.complete answer is installed: any model call would fail this test.
  const w = world(on)
  await $.session.start(START)
  const r = await $.command.run(cmd('integrity-start', DISCOVER))
  expect(r.text).toContain('Started task')
  expect(r.text).toContain('R1')
  const stored = w.store.get(E.projectKey(ROOT, 'git@example.org:acme/app.git')) as E.ProjectRecord
  expect(Object.keys(stored.tasks)).toHaveLength(1)
})

test('4-5. approves a baseline, then versions an amendment without overwriting it', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.command.run(cmd('integrity-start', DISCOVER))
  expect((await $.command.run(cmd('integrity-approve'))).text).toContain('baseline frozen at v1')

  const added = await $.command.run(cmd('integrity-contract', 'add Show the venue address on each event card'))
  expect(added.text).toContain('Added R2')
  expect(added.text).toContain('re-approve')

  const p = w.store.get(E.projectKey(ROOT, 'git@example.org:acme/app.git')) as E.ProjectRecord
  const c = E.activeTask(p)!.contract
  expect(c.version).toBe(2)
  expect(c.approval.status).toBe('draft')
  expect(c.baseline?.requirements).toHaveLength(1)
  expect(c.requirements).toHaveLength(2)
  expect(c.revisions.map(r => r.version)).toEqual([2])

  expect((await $.command.run(cmd('integrity-approve'))).text).toContain('re-approved at v2')
  const after = E.activeTask(w.store.get(E.projectKey(ROOT, 'git@example.org:acme/app.git')) as E.ProjectRecord)!.contract
  expect(after.baseline?.requirements).toHaveLength(1)
  expect(after.approval).toMatchObject({ status: 'approved', version: 2 })
})

test('6. a stored contract is recovered when the Mod loads again (reload, new session, after compaction)', async ($, on) => {
  const p = E.newProject(E.projectKey(ROOT, 'git@example.org:acme/app.git'), 'acme/app', 'older-session', T0)
  const task = E.startTask(p, DISCOVER, 'prompt', T0)
  E.approve(task.contract, T0)
  const w = world(on, { store: { [p.key]: p } })
  await $.session.start(START)
  const r = await $.command.run(cmd('integrity-contract'))
  expect(r.text).toContain('approved v1')
  expect(r.text).toContain('Preserve the current navigation')
  expect(w.status.at(-1)).toContain('Integrity')
})

test('7. contracts stay isolated between repositories', async ($, on) => {
  const other = E.newProject(E.projectKey('/repo/other', 'git@example.org:acme/other.git'), 'acme/other', 's', T0)
  E.startTask(other, DISCOVER, 'prompt', T0)
  expect(other.key).not.toBe(E.projectKey(ROOT, 'git@example.org:acme/app.git'))
  const w = world(on, { store: { [other.key]: other } })
  await $.session.start(START)
  expect((await $.command.run(cmd('integrity', 'status'))).text).toContain('no task contract')
  await $.command.run(cmd('integrity-start', 'Add a dark mode toggle to the settings page.'))
  // The other repository's record is untouched.
  expect(Object.keys((w.store.get(other.key) as E.ProjectRecord).tasks)).toHaveLength(1)
  expect(Object.values((w.store.get(other.key) as E.ProjectRecord).tasks)[0]?.contract.summary).toContain('Discover')
})
