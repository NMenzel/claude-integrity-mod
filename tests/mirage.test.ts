// Mirage Detector and intent drift against fixture projects. (Spec tests 8-13.)

import { expect, test } from 'claude-code/testing'

import * as E from '../src/engine/index'
import { API_MISMATCH, FUNCTIONAL, INCOMPLETE_REGISTRATION, MOCK_AS_LIVE, PROTOTYPE } from '../fixtures/projects'

const T0 = 1_760_000_000_000
const rules = (path: string, src: string, intent: E.ContractIntent = 'production', asked = '') =>
  E.scanSource(path, src, intent, asked)

function taskFor(prompt: string): E.Task {
  return E.startTask(E.newProject('k', 'acme/app', 's', T0), prompt, 'prompt', T0)
}

function writeAll(task: E.Task, files: Record<string, string>): E.Hint[] {
  return Object.entries(files).flatMap(([path, after]) => E.recordChange(task, { path, kind: 'create', after }, T0))
}

test('a functional, integrated component raises no mirage findings', () => {
  for (const [path, src] of Object.entries(FUNCTIONAL)) expect(rules(path, src)).toEqual([])
})

test('8. detects a placeholder implementation as confirmed', () => {
  const found = rules('lib/registration.ts', INCOMPLETE_REGISTRATION['lib/registration.ts'])
  expect(found.map(f => [f.ruleId, f.confidence, f.severity])).toEqual([['MIR-E1', 'confirmed', 'high']])
  expect(found[0]?.line).toBe(2)
})

test('9. detects an API handler that simulates success', () => {
  const found = rules('app/api/registrations/route.ts', API_MISMATCH['app/api/registrations/route.ts'])
  expect(found.map(f => f.ruleId)).toEqual(['MIR-B1'])
  expect(found[0]).toMatchObject({ confidence: 'potential', severity: 'high' })
  expect(found[0]?.explanation).toContain('POST')
})

test('10. detects non-functional controls, a fake delay and a deferred TODO', () => {
  const found = rules('components/RegisterPanel.tsx', INCOMPLETE_REGISTRATION['components/RegisterPanel.tsx'], 'production', 'registrations are saved')
  const ids = found.map(f => f.ruleId)
  expect(ids.filter(id => id === 'MIR-C1')).toHaveLength(2) // onClick={() => {}} and href="#"
  expect(ids).toContain('MIR-B2')
  expect(ids).toContain('MIR-E2')
  expect(ids).toContain('MIR-F1')
  expect(found.every(f => f.confidence === 'potential')).toBe(true)
})

test('11. a prototype\'s fixtures are expected, a production view\'s are flagged', () => {
  const proto = rules('app/discover/page.tsx', PROTOTYPE['app/discover/page.tsx'], 'prototype')
  expect(proto.map(f => [f.ruleId, f.confidence, f.severity])).toEqual([['MIR-A1', 'expected', 'info']])

  const live = rules('app/discover/page.tsx', MOCK_AS_LIVE['app/discover/page.tsx'], 'production')
  expect(live.map(f => f.ruleId).sort()).toEqual(['MIR-A1', 'MIR-D1', 'MIR-H1'])
  expect(live.find(f => f.ruleId === 'MIR-A1')).toMatchObject({ confidence: 'potential', severity: 'high' })

  // Expected findings never count as open problems.
  const task = taskFor('Build a clickable prototype of the Discover page with sample data.')
  writeAll(task, PROTOTYPE)
  const s = E.summarize(task, 'observe')
  expect(s.findings).toMatchObject({ open: 0, expected: 1 })
})

test('12. distinguishes a suspicious pattern from a confirmed defect', () => {
  const task = taskFor('Let users register for events; registrations must be saved to the database.')
  writeAll(task, INCOMPLETE_REGISTRATION)
  const confirmed = task.findings.filter(f => f.confidence === 'confirmed').map(f => f.ruleId)
  const potential = new Set(task.findings.filter(f => f.confidence === 'potential').map(f => f.ruleId))
  expect(confirmed).toEqual(['MIR-E1'])
  expect([...potential].sort()).toEqual(['MIR-B2', 'MIR-C1', 'MIR-E2', 'MIR-F1'])
  // Only the confirmed one can contradict "it is implemented"; that claim is contradicted, not merely unsupported.
  const [claim] = E.auditAnswer('The registration feature is now fully implemented.', task, 'turn-1', T0)
  expect(claim).toMatchObject({ kind: 'implemented', verdict: 'contradicted' })
})

test('13. an acknowledged or waived false positive stays suppressed on later scans', () => {
  const task = taskFor('Add a registration panel to the event page; it must be saved via the API.')
  const first = writeAll(task, { 'components/RegisterPanel.tsx': INCOMPLETE_REGISTRATION['components/RegisterPanel.tsx'] })
  const c1 = task.findings.filter(f => f.ruleId === 'MIR-C1')
  expect(c1).toHaveLength(2)
  E.setFindingStatus(task, c1[0]!.id, 'waived', T0, 'calendar export ships in the next task')
  E.setFindingStatus(task, c1[1]!.id, 'acknowledged', T0)
  const lineBefore = c1[0]!.line

  // The same file edited again (an unrelated line added above): same findings, statuses kept, no repeat hint.
  const again = E.recordChange(task, { path: 'components/RegisterPanel.tsx', kind: 'update', after: `// header\n${INCOMPLETE_REGISTRATION['components/RegisterPanel.tsx']}` }, T0 + 1)
  expect(task.findings.find(f => f.id === c1[0]!.id)).toMatchObject({ status: 'waived', line: lineBefore + 1 })
  expect(task.findings.find(f => f.id === c1[1]!.id)?.status).toBe('acknowledged')
  expect(again.filter(h => h.key.startsWith('finding:'))).toEqual([])
  expect(first.length).toBeGreaterThan(0)

  // Fixing the code resolves the finding; it is not counted any more.
  E.recordChange(task, { path: 'components/RegisterPanel.tsx', kind: 'update', after: 'export function RegisterPanel() { return null }' }, T0 + 2)
  expect(task.findings.filter(f => f.file === 'components/RegisterPanel.tsx' && f.status === 'open')).toEqual([])
})

test('MIR-D2: a client calling an endpoint no observed route serves', () => {
  const task = taskFor('Add event registration with an API route; registrations must be saved.')
  writeAll(task, API_MISMATCH)
  const d2 = task.findings.filter(f => f.ruleId === 'MIR-D2')
  expect(d2.map(f => [f.file, f.snippet])).toEqual([['app/discover/RegisterForm.tsx', 'request to /api/events/register']])
  expect(E.routeOf('app/(site)/api/events/[id]/route.ts')).toBe('/api/events/[id]')
  expect(E.routeMatches('/api/events/[id]', '/api/events/42')).toBe(true)
  expect(E.routeMatches('/api/events', '/api/events/register')).toBe(false)
  // Serving the endpoint resolves it.
  E.recordChange(task, { path: 'app/api/events/register/route.ts', kind: 'create', after: 'export async function POST() { await db.registration.create({}); return Response.json({ ok: true }) }' }, T0)
  expect(task.findings.filter(f => f.ruleId === 'MIR-D2' && f.status === 'open')).toEqual([])
})

test('drift: a new Discover page conflicts with "do not create another Discover page" (potential, not confirmed)', () => {
  const task = taskFor('Enrich the existing Discover page. Preserve the current navigation and do not create another Discover page.')
  E.approve(task.contract, T0)
  const hints = E.recordChange(task, { path: 'app/discover-new/page.tsx', kind: 'create', after: 'export default function Page() { return null }' }, T0)
  const drift = task.findings.filter(f => f.system === 'drift')
  expect(drift.map(f => [f.ruleId, f.confidence]).sort()).toEqual([['DRIFT-N1', 'potential'], ['DRIFT-R1', 'potential']])
  expect(drift[0]?.requirementIds).toEqual(['R1'])
  expect(hints.some(h => h.text.includes('possible scope drift'))).toBe(true)
  // Editing the existing page is not drift.
  E.recordChange(task, { path: 'app/discover/page.tsx', kind: 'update', after: 'export default function Page() { return null }' }, T0)
  expect(task.findings.filter(f => f.file === 'app/discover/page.tsx')).toEqual([])
})

test('drift: an approved exclusion is a confirmed violation; deletions, rewrites and new dependencies are potential', () => {
  const task = taskFor('Add CSV export to reports. Do not modify app/legacy/**.')
  E.approve(task.contract, T0)
  E.recordChange(task, { path: 'app/legacy/old.ts', kind: 'update', after: 'x' }, T0)
  expect(task.findings.find(f => f.ruleId === 'DRIFT-X1')).toMatchObject({ confidence: 'confirmed', severity: 'high' })
  expect(E.policyViolations(task).map(v => v.text)).toEqual(['excluded path modified: app/legacy/old.ts'])

  E.recordChange(task, { path: 'lib/report.ts', kind: 'delete' }, T0)
  expect(task.findings.find(f => f.ruleId === 'DRIFT-D1')?.confidence).toBe('potential')

  const before = Array.from({ length: 40 }, (_, i) => `export const v${i} = ${i}`).join('\n')
  E.recordChange(task, { path: 'lib/csv.ts', kind: 'update', before, after: 'export const all = 1' }, T0)
  expect(task.findings.find(f => f.ruleId === 'DRIFT-W1')?.explanation).toContain('kept 0%')

  E.recordChange(task, { path: 'package.json', kind: 'update', before: '{"dependencies":{"react":"19"}}', after: '{"dependencies":{"react":"19","left-pad":"1"}}' }, T0)
  expect(task.findings.find(f => f.ruleId === 'DRIFT-P1')?.explanation).toContain('left-pad')
})
