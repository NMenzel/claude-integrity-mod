// The Integrity pane and status hints, mounted through the plugin on real
// surface element tables. (Spec tests 29-31 and the UI/persistence list.)

import type { Engine } from 'claude-code/testing'
import type { Register } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import * as E from '../src/engine/index'
import { INCOMPLETE_REGISTRATION, OUTPUT } from '../fixtures/projects'
import { bash, cmd, PANE, paneProps, ROOT, START, world, write, type World } from './world'

const KEY = E.projectKey(ROOT, 'git@example.org:acme/app.git')
const SURFACES = ['terminal', 'desktop'] as const

async function seeded($: Engine, w: World): Promise<void> {
  await $.session.start(START)
  await $.command.run(cmd('integrity-start', 'Let users register for events. Registrations must be saved to the database. Tests must pass.'))
  w.answer = () => write('create')
  for (const [path, content] of Object.entries(INCOMPLETE_REGISTRATION)) {
    await $.tool.call({ tool: 'Write', file_path: `${ROOT}/${path}`, content })
  }
  w.answer = () => bash(OUTPUT.jestPass)
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
}

const mount = <S extends 'terminal' | 'desktop' | 'mobile'>($: Engine, surface: S, columns: number) =>
  $.ui.mount({ ...PANE, surface, props: paneProps(columns), viewport: { columns, rows: 40 } })

const texts = async (ui: { findAll: (q: { type?: string }) => Promise<{ text: string }[]> }): Promise<string> =>
  (await ui.findAll({})).map(e => e.text).join('\n')

test('no misleading warning without a contract: neutral pane, no status line', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  for (const surface of SURFACES) {
    const ui = await mount($, surface, 90)
    const all = await texts(ui)
    expect(all).toContain('No task contract')
    expect(all).not.toMatch(/[✗‼]|failed|Failed/)
    await ui.unmount()
  }
  expect(w.status.filter(s => s !== undefined)).toEqual([])
})

test('29. renders the requirements view and drills into one', async ($, on) => {
  const w = world(on)
  await seeded($, w)
  for (const surface of SURFACES) {
    const ui = await mount($, surface, 90)
    await ui.press({ key: 'tab:requirements' })
    const rows = await ui.findAll({ type: 'Button' })
    const reqs = rows.filter(r => r.key?.startsWith('req:'))
    expect(reqs.map(r => r.key)).toEqual(['req:R1', 'req:R2'])
    expect(reqs[1]?.text).toContain('✓ R2 [must] Tests must pass.')
    await ui.press({ key: 'req:R2' })
    expect(await texts(ui)).toContain('Why: test pass (24 passed, 0 failed)')
    await ui.press({ key: 'detail-close' })
    expect(await texts(ui)).not.toContain('Why:')
    await ui.unmount()
  }
})

test('30. current and stale evidence render differently', async ($, on) => {
  const w = world(on)
  await seeded($, w)
  const ui = await mount($, 'terminal', 90)
  await ui.press({ key: 'tab:evidence' })
  expect((await ui.find({ key: 'ev:E1' }))?.text).toMatch(/✓ E1 test pass · fresh/)
  w.answer = () => write('update', 'old')
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/events.ts`, content: 'export const sort = 1' })
  const stale = await ui.find({ key: 'ev:E1' })
  // The glyph and word carry the state; dimming only supplements it.
  expect(stale?.text).toMatch(/✓ E1 test pass · ⧗ stale/)
  expect(stale?.props['dimColor']).toBe(true)
  expect(w.status.at(-1)).toContain('⧗ 1 stale')
  expect(w.toasts).toContain('Integrity: test evidence is stale after src/events.ts changed · /integrity evidence')
})

test('31. reviews and waives a finding from the pane; acknowledge and reopen work too', async ($, on) => {
  const w = world(on)
  await seeded($, w)
  for (const surface of SURFACES) {
    const ui = await mount($, surface, 140)
    await ui.press({ key: 'tab:findings' })
    const first = (await ui.findAll({ type: 'Button' })).find(b => b.key?.startsWith('f:') && b.text.includes('MIR-C1'))!
    await ui.press({ key: first.key! })
    expect(await texts(ui)).toContain('Verify: Press the control')
    await ui.press({ key: 'ack' })
    expect(await texts(ui)).toContain('potential · acknowledged · MIR-C1')
    await ui.press({ key: 'reopen' })
    await ui.press({ key: 'waive' })
    await ui.input({ key: 'waive-reason', text: 'calendar button ships next sprint' })
    expect(await texts(ui)).toContain('Waived: calendar button ships next sprint')
    await ui.unmount()
    // The waiver is persisted, not just drawn.
    const f = E.activeTask(w.store.get(KEY) as E.ProjectRecord)!.findings.find(x => x.id === first.key!.slice(2))
    expect(f).toMatchObject({ status: 'waived', waiver: { reason: 'calendar button ships next sprint' } })
    // Restore for the next surface.
    await $.command.run(cmd('integrity-findings', `reopen ${first.key!.slice(2)}`))
  }
})

test('mobile has no Input: waiving falls back to the command, nothing breaks', async ($, on) => {
  const w = world(on)
  await seeded($, w)
  const ui = await mount($, 'mobile', 50)
  await ui.press({ key: 'tab:findings' })
  const row = (await ui.findAll({ type: 'Button' })).find(b => b.key?.startsWith('f:'))!
  await ui.press({ key: row.key! })
  await ui.press({ key: 'waive' })
  expect(await texts(ui)).toContain('Type /integrity-waive')
})

test('pane counts exactly match the canonical report', async ($, on) => {
  const w = world(on)
  await seeded($, w)
  const ui = await mount($, 'terminal', 90)
  const json = JSON.parse(((await $.command.run(cmd('integrity-report', 'json'))).text ?? '').replace(/^```json\n|\n```$/g, '')) as { summary: E.Summary }
  const s = json.summary
  const all = await texts(ui)
  expect(all).toContain(`${s.requirements.verified}/${s.requirements.total - s.requirements.waived} verified`)
  expect(all).toContain(`! ${s.findings.open} findings (${s.findings.high} high)`)
  expect(all).toContain(`‼ ${s.findings.high} high · ! ${s.findings.medium} medium`)
  await ui.press({ key: 'tab:report' })
  expect(await texts(ui)).toContain(`${s.requirements.verified}/${s.requirements.total - s.requirements.waived} verified, ${s.requirements.stale} stale, ${s.requirements.failed} failed, ${s.findings.open} open findings, ${s.evidence.fresh} fresh passing checks`)
  // And the status line says the same.
  expect(w.status.at(-1)).toBe(E.statusLine(E.summarize(E.activeTask(w.store.get(KEY) as E.ProjectRecord), 'observe')))
})

test('mini, compact and wide layouts at narrow, typical and wide widths', async ($, on) => {
  const w = world(on)
  await seeded($, w)
  const sizes = [[40, 'Ovw'], [90, 'Ovw'], [140, 'Overview']] as const
  for (const [columns, label] of sizes) {
    const ui = await mount($, 'terminal', columns)
    expect((await ui.find({ key: 'tab:overview' }))?.props['label']).toBe(label)
    const all = await texts(ui)
    // Mini keeps the essentials (progress, counts, concern) and drops the breakdown.
    expect(all).toContain('verified')
    expect(all).toMatch(/▸ /)
    if (columns === 40) expect(all).not.toContain('EVIDENCE · witness')
    else expect(all).toContain('EVIDENCE · witness')
    for (const t of await ui.findAll({ type: 'Text' })) {
      if (t.props['wrap'] === 'truncate-end') expect(t.text.length).toBeLessThanOrEqual(columns + 40)
    }
    await ui.unmount()
  }
  // A layout preference overrides the measured width.
  await $.command.run(cmd('integrity-layout', 'mini'))
  const forced = await mount($, 'terminal', 160)
  expect(await texts(forced)).not.toContain('EVIDENCE · witness')
})

test('Flightdeck look: title and legend, a card per subsystem, a requirement strip; inline is the mini summary', async ($, on) => {
  const w = world(on)
  await seeded($, w)
  const ui = await mount($, 'terminal', 90)
  const all = await texts(ui)
  expect(all).toContain('INTEGRITY · OBSERVE MODE · DRAFT V1')
  for (const card of ['CONTRACT · draft v1', 'EVIDENCE · witness', 'FINDINGS · mirage + drift', 'CLAIMS · last answer', 'activity log']) expect(all).toContain(card)
  expect((await ui.find({ type: 'Text', text: /^reqs / }))?.text).toMatch(/^reqs [■]{2}$/)
  const cards = (await ui.findAll({ type: 'Box' })).filter(b => b.props['borderStyle'] === 'round')
  expect(cards.map(b => b.props['borderColor'])).toEqual(expect.arrayContaining(['claude', 'suggestion', 'warning', 'merged', 'subtle']))
  // An overview finding opens its drill-down in the Findings view.
  const top = (await ui.findAll({ type: 'Button' })).find(b => b.key?.startsWith('ovf:'))!
  await ui.press({ key: top.key! })
  expect(await texts(ui)).toContain('Verify: ')
  await ui.unmount()

  await $.command.run(cmd('integrity', 'overview'))
  const inline = await $.ui.mount({ ...PANE, surface: 'terminal', props: paneProps(140, 'inline'), viewport: { columns: 140, rows: 40 } })
  const mini = await texts(inline)
  expect(mini).toMatch(/Integrity ▰*▱* 1\/2 verified · draft v1 · observe/)
  expect(mini).not.toContain('EVIDENCE · witness')
  expect((await inline.findAll({ type: 'Box' })).filter(b => b.props['borderStyle'] === 'round')).toEqual([])
})

test('without color the glyphs carry the states and no border is tinted', { options: { color: false } }, async ($, on) => {
  const w = world(on)
  await seeded($, w)
  const ui = await mount($, 'terminal', 90)
  expect((await ui.find({ type: 'Text', text: /^reqs / }))?.text).toMatch(/^reqs [✓◐?⧗✗–]{2}$/)
  for (const b of await ui.findAll({ type: 'Box' })) expect(b.props['borderColor']).toBeUndefined()
})

test('keyboard: views 1-7 have hotkeys, actions have letters, selection survives redraws', async ($, on) => {
  const w = world(on)
  await seeded($, w)
  const ui = await mount($, 'terminal', 90)
  const tabs = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('tab:'))
  expect(tabs.map(b => b.props['hotkey'])).toEqual(['1', '2', '3', '4', '5', '6', '7'])
  expect((await ui.find({ key: 'recheck' }))?.props['hotkey']).toBe('c')
  await ui.press({ key: 'tab:requirements' })
  await ui.press({ key: 'req:R1' })
  // A state change elsewhere (new evidence) redraws the pane; the open detail stays.
  w.answer = () => bash(OUTPUT.jestPass)
  await $.tool.call({ tool: 'Bash', command: 'npm run lint' })
  expect(await texts(ui)).toContain('R1: ')
  await ui.press({ key: 'tab:activity' })
  expect(await texts(ui)).toContain('E2 lint pass [exit 0]')
})

test('status hints only when configured', { options: { statusHint: false } }, async ($, on) => {
  const w = world(on)
  await seeded($, w)
  expect(w.status.filter(s => s !== undefined)).toEqual([])
})

test('notifications off: no toasts at all', { options: { notify: 'off' } }, async ($, on) => {
  const w = world(on)
  await seeded($, w)
  expect(w.toasts).toEqual([])
})

const neighbor: Register = on => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: 'neighbor band: 3 agents running' })
  })
}

test('another mod\'s AbovePrompt band stays present and usable', { plugins: [{ name: 'neighbor', register: neighbor }] }, async ($, on) => {
  const w = world(on)
  await seeded($, w)
  for (const surface of SURFACES) {
    const band = await $.ui.mount({
      plugin: 'neighbor', surface, component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 80, scroll: { offset: 0, bodyRows: 8 }, view: {} },
    })
    expect(await band.find({ type: 'Text', text: /neighbor band/ })).toBeDefined()
    await band.unmount()
  }
  // Integrity's own glanceable hint lives in its one status slot, never in the band.
  expect(w.status.at(-1)).toMatch(/^Integrity /)
})

test('rendering stays bounded with hundreds of requirements and findings', async ($, on) => {
  const T0 = 1_760_000_000_000
  const p = E.newProject(KEY, 'acme/app', 'old', T0)
  const task = E.startTask(p, 'Large task with many requirements. Tests must pass.', 'manual', T0)
  for (let i = 0; i < 300; i++) task.contract.requirements.push(E.makeRequirement(task.contract.requirements, `Requirement number ${i}`))
  for (let i = 0; i < 120; i++) {
    E.recordChange(task, { path: `components/Panel${i}.tsx`, kind: 'create', after: INCOMPLETE_REGISTRATION['components/RegisterPanel.tsx'] }, T0 + i)
  }
  expect(task.findings.length).toBeGreaterThan(300)
  world(on, { store: { [KEY]: p } })
  await $.session.start(START)
  const started = Date.now()
  const ui = await mount($, 'terminal', 140)
  await ui.press({ key: 'tab:requirements' })
  await ui.press({ key: 'tab:findings' })
  await ui.press({ key: 'next' })
  expect(Date.now() - started).toBeLessThan(4000)
  // Findings page by the configured size rather than drawing hundreds of rows.
  expect((await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('f:'))).toHaveLength(8)
})
