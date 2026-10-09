// Requirement status from evidence, and the explicit policies Strict mode
// enforces. "Verified" needs a real, passing, current run of a kind that can
// prove the requirement: a model's opinion never counts, and one passing suite
// verifies only the requirements linked to it.

import type { Evidence, EvidenceKind, Mode, Requirement, Task, VerificationKind } from './types'
import { freshness } from './evidence'
import { matchesGlob } from './util'

export type RequirementState = 'verified' | 'stale' | 'failed' | 'waived' | 'implemented' | 'unverified'

const PROVES: Record<VerificationKind, readonly EvidenceKind[]> = {
  test: ['test-result', 'runtime-check', 'manual-confirmation'],
  runtime: ['runtime-check', 'manual-confirmation'],
  manual: ['manual-confirmation'],
  static: ['tool-result', 'static-analysis', 'test-result', 'runtime-check', 'manual-confirmation'],
  unknown: ['tool-result', 'static-analysis', 'test-result', 'runtime-check', 'manual-confirmation'],
}

/** Evidence tied to a requirement: linked by id, matched by one of its `checks`, or any test run for a test requirement. */
export function linkedEvidence(r: Requirement, task: Task): Evidence[] {
  const checks = r.checks.map(c => c.toLowerCase())
  return task.evidence.filter(e =>
    e.requirementIds.includes(r.id) ||
    r.evidenceIds.includes(e.id) ||
    (checks.length > 0 && e.command !== undefined && checks.some(c => e.command!.toLowerCase().includes(c))) ||
    (r.category === 'test' && checks.length === 0 && (e.check === 'test' || e.check === 'browser')))
}

export function requirementState(r: Requirement, task: Task): { state: RequirementState; reason: string; evidence: Evidence[] } {
  const linked = linkedEvidence(r, task)
  if (r.waiver !== undefined) return { state: 'waived', reason: `waived: ${r.waiver.reason}`, evidence: linked }
  const violated = task.findings.find(f => f.requirementIds.includes(r.id) && f.confidence === 'confirmed' && f.status === 'open')
  if (violated) return { state: 'failed', reason: `${violated.ruleId}: ${violated.explanation}`, evidence: linked }

  const usable = linked.filter(e => e.synthetic !== true && e.outcome !== 'inconclusive' && PROVES[r.verification].includes(e.kind))
  const current = usable.filter(e => freshness(e, task) !== 'stale')
  const latest = current.at(-1)
  if (latest?.outcome === 'fail') return { state: 'failed', reason: `${latest.summary} (${latest.id})`, evidence: linked }
  const pass = current.filter(e => e.outcome === 'pass').at(-1)
  if (pass) return { state: 'verified', reason: `${pass.summary} (${pass.id})`, evidence: linked }
  if (usable.some(e => e.outcome === 'pass')) return { state: 'stale', reason: 'passing evidence predates later changes', evidence: linked }
  if (linked.length > 0 && usable.length === 0) {
    return { state: r.implemented ? 'implemented' : 'unverified', reason: 'only inconclusive, synthetic or non-qualifying evidence', evidence: linked }
  }
  if (r.implemented) return { state: 'implemented', reason: 'marked implemented; no qualifying evidence', evidence: linked }
  return { state: 'unverified', reason: linked.length === 0 ? 'no evidence observed' : 'no qualifying evidence', evidence: linked }
}

export type PolicyViolation = { id: string; text: string }

/**
 * Strict mode's deterministic policies, each one the person enabled by writing
 * it into the approved contract: an excluded path, a must requirement's
 * declared check. Uncertain judgments are never here.
 */
export function policyViolations(task: Task): PolicyViolation[] {
  const out: PolicyViolation[] = []
  if (task.contract.approval.status !== 'approved' && task.contract.baseline === undefined) return out
  for (const f of task.findings) {
    if (f.ruleId === 'DRIFT-X1' && f.status === 'open') out.push({ id: f.id, text: `excluded path modified: ${f.file}` })
  }
  for (const r of task.contract.requirements) {
    if (r.criticality !== 'must' || r.waiver !== undefined || (r.checks.length === 0 && r.category !== 'test')) continue
    const { state } = requirementState(r, task)
    if (state === 'failed') out.push({ id: r.id, text: `${r.id} required check failed` })
    else if (state !== 'verified') out.push({ id: r.id, text: `${r.id} required check has not passed on the current changes (${r.checks.join(', ') || 'tests'})` })
  }
  return out
}

/** Strict mode's one hard gate the API supports: refuse an edit to a path the approved contract excludes. */
export function deniedPath(task: Task | undefined, mode: Mode, path: string): string | undefined {
  if (mode !== 'strict' || task === undefined || task.contract.baseline === undefined) return undefined
  return task.contract.exclusions.find(g => /[/*]|\.\w{1,5}$/.test(g) && !/\s/.test(g) && matchesGlob(path, g))
}
