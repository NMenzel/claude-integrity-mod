// The engine's state transitions. Pure: every function takes the state and the
// time, mutates the task in place, and returns the hints to show. The Mod
// adapter does all IO; a CLI or CI job can drive the same functions.

import type {
  Activity, ActivityKind, Evidence, FileChange, FileState, Finding, Hint, Mode, ProjectRecord, Task, ToolObservation,
} from './types'
import { createContract } from './contract'
import { evidenceFromBash, evidenceFromBrowserTool, freshness, isProof, staleBecause } from './evidence'
import { apiCalls, routeMatches, routeOf, scanSource, type RawFinding } from './mirage'
import { driftFindings } from './drift'
import { auditAnswer } from './claims'
import { requirementState } from './status'
import { clip, hash, isScannable, newId, redact } from './util'

export * from './types'
export { summarize, statusLine, type Summary, type Tab } from './summary'
export { requirementState, policyViolations, deniedPath, linkedEvidence } from './status'
export { freshness, staleBecause, isProof, classifyCommand, parseCounts } from './evidence'
export { createContract, approve, amend, makeRequirement, findRequirement, isMeaningfulTask, detectIntent } from './contract'
export { scanSource, RULES, apiCalls, routeOf, routeMatches } from './mirage'
export { driftFindings } from './drift'
export { auditAnswer, extractClaims } from './claims'
export { toMarkdown, toJson } from './report'
export { mergeProjects, trimProject } from './persist'
export { redact, normalizePath, hash, projectKey } from './util'

const LIMITS = { activity: 200, notified: 300 }

export function newProject(key: string, label: string, writer: string, now: number): ProjectRecord {
  return { schema: 1, key, label: redact(label), rev: 0, writer, updatedAt: now, mode: 'observe', tasks: {} }
}

export const activeTask = (p: ProjectRecord): Task | undefined =>
  p.activeTaskId === undefined ? undefined : p.tasks[p.activeTaskId]

export function startTask(p: ProjectRecord, prompt: string, source: 'prompt' | 'manual', now: number): Task {
  const id = newId('t', now)
  const task: Task = {
    id, createdAt: now, updatedAt: now, contract: createContract(id, prompt, now, source),
    evidence: [], files: {}, findings: [], claims: [], activity: [], seq: 0, notified: [], nextEvidence: 1,
  }
  p.tasks[id] = task
  p.activeTaskId = id
  log(task, 'task', `task started (${source === 'prompt' ? 'captured from prompt' : 'manual'}): ${task.contract.summary}`, now)
  return task
}

export function log(task: Task, kind: ActivityKind, text: string, now: number): void {
  const entry: Activity = { at: now, kind, text: clip(redact(text), 200) }
  task.activity.push(entry)
  if (task.activity.length > LIMITS.activity) task.activity.splice(0, task.activity.length - LIMITS.activity)
  task.updatedAt = now
}

/** A hint at most once per key, ever, for this task. */
function hint(task: Task, key: string, level: Hint['level'], text: string): Hint[] {
  if (task.notified.includes(key)) return []
  task.notified.push(key)
  if (task.notified.length > LIMITS.notified) task.notified.splice(0, task.notified.length - LIMITS.notified)
  return [{ key, level, text }]
}

const nextEvidenceId = (task: Task) => (): string => `E${task.nextEvidence++}`

function contractText(task: Task): string {
  const c = task.contract
  return [c.summary, c.prompt.excerpt, ...c.requirements.map(r => r.description), ...c.assumptions].join(' ')
}

/**
 * Merges a fresh scan of one file into the findings: an id seen before keeps
 * its waiver or acknowledgement; one no longer found is resolved.
 */
export function applyFindings(
  task: Task, file: string, system: Finding['system'], fresh: (RawFinding & { id: string; requirementIds?: string[] })[], now: number,
  replaceRules?: (ruleId: string) => boolean,
): Hint[] {
  const hints: Hint[] = []
  const ids = new Set(fresh.map(f => f.id))
  for (const old of task.findings) {
    if (old.file !== file || old.system !== system || ids.has(old.id)) continue
    if (replaceRules !== undefined && !replaceRules(old.ruleId)) continue
    if (old.status === 'open' || old.status === 'acknowledged') {
      old.status = 'resolved'
      log(task, 'resolved', `${old.ruleId} no longer found in ${file}`, now)
    }
  }
  for (const f of fresh) {
    const existing = task.findings.find(x => x.id === f.id)
    if (existing) {
      Object.assign(existing, { line: f.line, snippet: redact(f.snippet), lastSeq: task.seq, severity: f.severity, confidence: f.confidence })
      if (existing.status === 'resolved') existing.status = 'open'
      continue
    }
    task.findings.push({
      id: f.id, ruleId: f.ruleId, system, category: f.category, file, line: f.line, snippet: redact(f.snippet),
      explanation: f.explanation, evidence: f.evidence, severity: f.severity, confidence: f.confidence,
      requirementIds: f.requirementIds ?? [], verify: f.verify, status: 'open', firstSeq: task.seq, lastSeq: task.seq,
    })
    log(task, 'finding', `${f.ruleId} ${f.confidence} in ${file}:${f.line}`, now)
    if (f.confidence === 'expected' || f.severity === 'low' || f.severity === 'info') continue
    const text = system === 'drift'
      ? `Integrity: possible scope drift in ${file} (${f.category.toLowerCase()}) · /integrity findings`
      : `Integrity: ${f.confidence === 'confirmed' ? '' : 'possible '}${f.category.replace(/^\w\.\s*/, '').toLowerCase()} in ${file}:${f.line} · /integrity findings`
    hints.push(...hint(task, `finding:${f.id}`, f.severity === 'high' ? 'important' : 'info', text))
  }
  if (task.findings.length > 300) {
    const drop = task.findings.filter(f => f.status === 'resolved').slice(0, task.findings.length - 300)
    task.findings = task.findings.filter(f => !drop.includes(f))
  }
  return hints
}

/** One observed source change: bumps the change sequence, then drift and mirage checks, then staleness. */
export function recordChange(task: Task, change: FileChange, now: number): Hint[] {
  const proofBefore = task.evidence.filter(e => isProof(e, task))
  task.seq += 1
  const prev = task.files[change.path]
  task.files[change.path] = {
    path: change.path,
    created: prev?.created ?? change.kind === 'create',
    deleted: change.kind === 'delete',
    firstSeq: prev?.firstSeq ?? task.seq,
    lastSeq: task.seq,
    changes: (prev?.changes ?? 0) + 1,
    ...(change.after === undefined ? {} : { hash: hash(change.after) }),
  }
  if (Object.keys(task.files).length > 500) {
    const oldest = Object.values(task.files).sort((a, b) => a.lastSeq - b.lastSeq)[0]
    if (oldest) delete task.files[oldest.path]
  }
  log(task, 'evidence', `${change.kind} ${change.path}`, now)

  const hints: Hint[] = []
  // Drift is history: a later edit does not undo a creation or deletion, so nothing auto-resolves.
  hints.push(...applyFindings(task, change.path, 'drift', driftFindings(change, task.contract), now, () => false))
  if (change.kind === 'delete') hints.push(...applyFindings(task, change.path, 'mirage', [], now))
  else if (change.after !== undefined && isScannable(change.path)) {
    const file = task.files[change.path] as FileState
    file.calls = apiCalls(change.after)
    const route = routeOf(change.path)
    if (route !== undefined) file.route = route
    hints.push(...applyFindings(task, change.path, 'mirage', scanSource(change.path, change.after, task.contract.intent, contractText(task)), now, id => id !== 'MIR-D2'))
  }
  hints.push(...endpointCheck(task, now))

  const invalidated = proofBefore.filter(e => freshness(e, task) === 'stale')
  for (const e of invalidated) log(task, 'invalidated', `${e.id} ${e.check} evidence stale after ${change.path} changed`, now)
  if (invalidated.length > 0) {
    const checks = [...new Set(invalidated.map(e => e.check))].join('/')
    hints.push(...hint(task, `stale:${invalidated.map(e => e.id).join(',')}`, 'important', `Integrity: ${checks} evidence is stale after ${change.path} changed · /integrity evidence`))
  }
  task.updatedAt = now
  return hints
}

/**
 * MIR-D2, across files: a client calls an `/api/...` endpoint that no observed
 * route file serves. Runs only once the task has seen at least one route file.
 */
function endpointCheck(task: Task, now: number): Hint[] {
  const files = Object.values(task.files).filter(f => !f.deleted)
  const routes = files.map(f => f.route).filter((r): r is string => r !== undefined)
  if (routes.length === 0) return []
  const hints: Hint[] = []
  for (const f of files) {
    if (f.calls === undefined) continue
    const missing = f.calls.filter(c => !routes.some(r => routeMatches(r, c.path)))
    hints.push(...applyFindings(task, f.path, 'mirage', missing.map(c => ({
      id: hash(`MIR-D2|${f.path}|${c.path}`), ruleId: 'MIR-D2', category: 'D. Incomplete data integration', line: c.line,
      snippet: `request to ${c.path}`, severity: 'high' as const, confidence: 'potential' as const,
      explanation: `${f.path} calls ${c.path}, but no route file seen in this task serves it (seen: ${routes.slice(0, 4).join(', ')}).`,
      evidence: 'Literal endpoint compared with the route files observed in this task; routes outside the task are not seen.',
      verify: `Confirm ${c.path} exists, or point the client at the route that does.`,
    })), now, id => id === 'MIR-D2'))
  }
  return hints
}

/** One observed tool call that may be evidence: a check run, a browser session. */
export function recordTool(task: Task, obs: ToolObservation, now: number): { evidence: Evidence[]; hints: Hint[] } {
  const verifiedBefore = new Set(task.contract.requirements.filter(r => requirementState(r, task).state === 'verified').map(r => r.id))
  let evidence: Evidence[] = []
  if (obs.tool === 'Bash') evidence = evidenceFromBash(obs, task.seq, now, nextEvidenceId(task))
  else {
    const browser = evidenceFromBrowserTool(obs, task.seq, now, `E${task.nextEvidence}`)
    if (browser) {
      task.nextEvidence++
      evidence = [browser]
    }
  }
  if (evidence.length === 0) return { evidence, hints: [] }

  for (const e of evidence) {
    e.requirementIds = task.contract.requirements
      .filter(r => r.checks.length > 0 && e.command !== undefined && r.checks.some(c => e.command!.toLowerCase().includes(c.toLowerCase())))
      .map(r => r.id)
    task.evidence.push(e)
    log(task, 'evidence', `${e.id} ${e.summary} [${e.basis}]`, now)
  }
  if (task.evidence.length > 200) task.evidence.splice(0, task.evidence.length - 200)

  const hints: Hint[] = []
  const failed = evidence.find(e => e.outcome === 'fail')
  if (failed) hints.push(...hint(task, `fail:${failed.id}`, 'important', `Integrity: ${failed.check} failed (${failed.basis}) · /integrity evidence`))
  const newlyVerified = task.contract.requirements.filter(r => !verifiedBefore.has(r.id) && requirementState(r, task).state === 'verified')
  if (newlyVerified.length > 0) {
    hints.push(...hint(task, `verified:${newlyVerified.map(r => r.id).join(',')}:${task.seq}`, 'info', `Integrity: ${newlyVerified.map(r => r.id).join(', ')} verified by fresh evidence`))
  }
  task.updatedAt = now
  return { evidence, hints }
}

/** A person's own confirmation: the only way a manual requirement is verified. */
export function recordManual(task: Task, requirementId: string, note: string, now: number): Evidence {
  const e: Evidence = {
    id: `E${task.nextEvidence++}`, requirementIds: [requirementId], kind: 'manual-confirmation', check: 'manual', outcome: 'pass',
    timestamp: now, source: 'person', summary: `confirmed by the developer: ${clip(redact(note), 120)}`, basis: 'explicit user verification',
    scope: [], seq: task.seq,
  }
  task.evidence.push(e)
  log(task, 'evidence', `${e.id} manual confirmation of ${requirementId}`, now)
  return e
}

export type AuditResult = { notice?: string; hints: Hint[] }

/** Audits a final answer and composes the notice shown beneath it, or none per the notification level. */
export function recordAudit(task: Task, answer: string, turnId: string, now: number, mode: Mode, level: 'off' | 'important' | 'all'): AuditResult {
  const claims = auditAnswer(answer, task, turnId, now)
  const known = new Set(task.claims.map(c => c.id))
  task.claims.push(...claims.filter(c => !known.has(c.id)))
  if (task.claims.length > 100) task.claims.splice(0, task.claims.length - 100)
  if (claims.length > 0) log(task, 'claims', `${claims.length} claim(s) audited: ${claims.map(c => c.verdict).join(', ')}`, now)

  const bad = claims.filter(c => c.verdict === 'contradicted' || c.verdict === 'unsupported')
  const lines: string[] = []
  if (level !== 'off' && (bad.length > 0 || (level === 'all' && claims.length > 0))) {
    const counts = (['supported', 'partial', 'unsupported', 'contradicted', 'not-assessable'] as const)
      .map(v => [v, claims.filter(c => c.verdict === v).length] as const).filter(([, n]) => n > 0).map(([v, n]) => `${n} ${v}`)
    lines.push(`Integrity · ${claims.length} completion claim${claims.length === 1 ? '' : 's'} checked: ${counts.join(' · ')}`)
    for (const c of (level === 'all' ? claims : bad).slice(0, 4)) lines.push(`  ${GLYPH[c.verdict]} "${clip(c.text, 70)}": ${c.reason}`)
  }
  if (mode !== 'observe' && level !== 'off') {
    const high = task.findings.filter(f => f.status === 'open' && f.severity === 'high' && f.confidence !== 'expected')
    const mustOpen = task.contract.requirements.filter(r => r.criticality === 'must' && r.waiver === undefined && requirementState(r, task).state !== 'verified')
    if (high.length > 0 || mustOpen.length > 0) {
      lines.push(`Integrity ${mode}: ${mustOpen.length} must requirement(s) not verified · ${high.length} high finding(s) open`)
    }
  }
  if (lines.length > 0) lines.push('  details: /integrity claims')
  return { ...(lines.length > 0 ? { notice: lines.join('\n') } : {}), hints: [] }
}

export const GLYPH = { supported: '✓', partial: '◐', unsupported: '?', contradicted: '✗', 'not-assessable': '·' } as const

export function setFindingStatus(task: Task, id: string, status: 'acknowledged' | 'waived' | 'open', now: number, reason?: string): Finding | undefined {
  const f = task.findings.find(x => x.id === id || x.id.startsWith(id))
  if (f === undefined) return undefined
  f.status = status
  if (status === 'waived') f.waiver = { reason: clip(redact(reason ?? ''), 200), at: now }
  else delete f.waiver
  log(task, status === 'waived' ? 'waiver' : 'finding', `${f.ruleId} ${f.file}:${f.line} ${status}${reason ? `: ${reason}` : ''}`, now)
  return f
}

/** Re-reads tracked files (passed in by the adapter) and records out-of-band edits as changes. */
export function reconcileFiles(task: Task, current: Record<string, string | null>, now: number): Hint[] {
  const hints: Hint[] = []
  for (const [path, text] of Object.entries(current)) {
    const known = task.files[path]
    if (known === undefined) continue
    if (text === null && !known.deleted) hints.push(...recordChange(task, { path, kind: 'delete' }, now))
    else if (text !== null && known.hash !== undefined && hash(text) !== known.hash) {
      hints.push(...recordChange(task, { path, kind: 'update', after: text }, now))
      log(task, 'invalidated', `${path} changed outside observed tools`, now)
    }
  }
  return hints
}

