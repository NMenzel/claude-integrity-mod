// The one canonical summary: the status line, every pane view and the report
// all read their counts from `summarize`, so they cannot disagree.

import type { CheckKind, Claim, Evidence, Freshness, Mode, Task } from './types'
import { freshness, latestByCheck } from './evidence'
import { requirementState, type RequirementState } from './status'

export type Tab = 'overview' | 'requirements' | 'evidence' | 'findings' | 'claims' | 'activity' | 'report'

export type Summary = {
  hasTask: boolean
  taskId?: string
  title: string
  approval: 'none' | 'draft' | 'approved' | 'amended'
  version: number
  intent: string
  mode: Mode
  requirements: Record<RequirementState, number> & { total: number }
  must: { total: number; verified: number }
  findings: { open: number; high: number; medium: number; low: number; info: number; expected: number; waived: number; acknowledged: number; confirmed: number }
  evidence: { total: number; fresh: number; stale: number; latest: { check: CheckKind; outcome: string; freshness: Freshness; summary: string; id: string; at: number }[] }
  claims: { total: number; supported: number; partial: number; unsupported: number; contradicted: number; notAssessable: number; latest: Claim[] }
  concern?: { text: string; tab: Tab }
  /** Verified share of the requirements still in force (waived ones left out), 0..1. */
  progress: number
}

const EMPTY_REQ = { verified: 0, stale: 0, failed: 0, waived: 0, implemented: 0, unverified: 0, total: 0 }

export function summarize(task: Task | undefined, mode: Mode): Summary {
  if (task === undefined) {
    return {
      hasTask: false, title: 'No task contract', approval: 'none', version: 0, intent: 'unknown', mode,
      requirements: { ...EMPTY_REQ }, must: { total: 0, verified: 0 },
      findings: { open: 0, high: 0, medium: 0, low: 0, info: 0, expected: 0, waived: 0, acknowledged: 0, confirmed: 0 },
      evidence: { total: 0, fresh: 0, stale: 0, latest: [] },
      claims: { total: 0, supported: 0, partial: 0, unsupported: 0, contradicted: 0, notAssessable: 0, latest: [] },
      progress: 0,
    }
  }
  const c = task.contract
  const requirements = { ...EMPTY_REQ }
  const must = { total: 0, verified: 0 }
  for (const r of c.requirements) {
    const { state } = requirementState(r, task)
    requirements[state]++
    requirements.total++
    if (r.criticality === 'must' && state !== 'waived') {
      must.total++
      if (state === 'verified') must.verified++
    }
  }

  const findings = { open: 0, high: 0, medium: 0, low: 0, info: 0, expected: 0, waived: 0, acknowledged: 0, confirmed: 0 }
  for (const f of task.findings) {
    if (f.status === 'waived') findings.waived++
    else if (f.status === 'acknowledged') findings.acknowledged++
    else if (f.status === 'open' && f.confidence === 'expected') findings.expected++
    else if (f.status === 'open') {
      findings.open++
      findings[f.severity]++
      if (f.confidence === 'confirmed') findings.confirmed++
    }
  }

  const fresh = (e: Evidence): Freshness => freshness(e, task)
  const real = task.evidence.filter(e => e.synthetic !== true)
  const latest = [...latestByCheck(task).values()].map(e => ({ check: e.check, outcome: e.outcome, freshness: fresh(e), summary: e.summary, id: e.id, at: e.timestamp }))
  const lastTurn = task.claims.at(-1)?.turnId
  const latestClaims = task.claims.filter(cl => cl.turnId === lastTurn)
  const count = (v: Claim['verdict']): number => latestClaims.filter(cl => cl.verdict === v).length

  const summary: Summary = {
    hasTask: true,
    taskId: task.id,
    title: c.summary,
    approval: c.approval.status === 'approved' ? 'approved' : c.baseline !== undefined ? 'amended' : 'draft',
    version: c.version,
    intent: c.intent,
    mode,
    requirements,
    must,
    findings,
    evidence: {
      total: task.evidence.length,
      fresh: real.filter(e => e.outcome === 'pass' && fresh(e) === 'fresh').length,
      stale: real.filter(e => e.outcome === 'pass' && fresh(e) === 'stale').length,
      latest,
    },
    claims: {
      total: latestClaims.length, supported: count('supported'), partial: count('partial'), unsupported: count('unsupported'),
      contradicted: count('contradicted'), notAssessable: count('not-assessable'), latest: latestClaims,
    },
    progress: requirements.total - requirements.waived > 0 ? requirements.verified / (requirements.total - requirements.waived) : 0,
  }
  summary.concern = concernOf(summary, task)
  return summary
}

function concernOf(s: Summary, task: Task): Summary['concern'] {
  const contradicted = s.claims.latest.find(cl => cl.verdict === 'contradicted')
  if (contradicted) return { text: `Claim contradicted: "${contradicted.text}"`, tab: 'claims' }
  const confirmed = task.findings.find(f => f.status === 'open' && f.confidence === 'confirmed')
  if (confirmed) return { text: `${confirmed.ruleId} ${confirmed.file}:${confirmed.line}: ${confirmed.category}`, tab: 'findings' }
  if (s.requirements.failed > 0) return { text: `${s.requirements.failed} requirement(s) have failing evidence`, tab: 'requirements' }
  const high = task.findings.find(f => f.status === 'open' && f.severity === 'high' && f.confidence === 'potential')
  if (high) return { text: `Possible ${high.category.replace(/^\w\.\s*/, '').toLowerCase()} in ${high.file}`, tab: 'findings' }
  const stale = s.evidence.latest.find(e => e.freshness === 'stale' && e.outcome === 'pass')
  if (stale) return { text: `${stale.check} evidence is stale after later edits`, tab: 'evidence' }
  const unsupported = s.claims.latest.find(cl => cl.verdict === 'unsupported')
  if (unsupported) return { text: `Unsupported claim: "${unsupported.text}"`, tab: 'claims' }
  if (s.approval !== 'approved') return { text: s.approval === 'amended' ? 'Contract amended: re-approve with /integrity-approve' : 'Draft contract: review and /integrity-approve', tab: 'requirements' }
  if (s.must.total > s.must.verified) return { text: `${s.must.total - s.must.verified} must requirement(s) not verified yet`, tab: 'requirements' }
  return undefined
}

/** The glanceable one-line status; undefined when there is nothing to say. Glyphs carry the meaning, not color. */
export function statusLine(s: Summary, columns = 120): string | undefined {
  if (!s.hasTask) return undefined
  if (s.approval === 'draft' && s.evidence.total === 0 && s.findings.open === 0) return 'Integrity ◇ draft contract · /integrity'
  const parts: string[] = []
  const inForce = s.requirements.total - s.requirements.waived
  if (inForce > 0) parts.push(`✓ ${s.requirements.verified}/${inForce} verified`)
  const unverified = s.requirements.unverified + s.requirements.implemented
  if (unverified > 0) parts.push(`? ${unverified} unverified`)
  if (s.requirements.failed > 0) parts.push(`✗ ${s.requirements.failed} failed`)
  if (s.findings.open > 0) parts.push(`! ${s.findings.open} finding${s.findings.open === 1 ? '' : 's'}`)
  if (s.evidence.stale > 0) parts.push(`⧗ ${s.evidence.stale} stale`)
  if (s.claims.contradicted + s.claims.unsupported > 0) parts.push(`✗ ${s.claims.contradicted + s.claims.unsupported} claim${s.claims.contradicted + s.claims.unsupported === 1 ? '' : 's'}`)
  if (s.approval !== 'approved') parts.push(s.approval === 'amended' ? '◇ amended' : '◇ draft')
  if (parts.length === 0) parts.push('no evidence yet')
  // Narrow terminals keep the leading (most important) parts.
  let line = 'Integrity  ' + parts.join('  ·  ')
  while (line.length > columns && parts.length > 1) {
    parts.pop()
    line = 'Integrity ' + parts.join(' · ')
  }
  return line
}
