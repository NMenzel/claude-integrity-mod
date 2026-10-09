// Cross-session persistence rules: merge instead of last-writer-wins, and
// bounded retention. The adapter re-reads the stored record before each write
// and merges it with its own; two sessions' evidence and findings both stay.

import type { Contract, ProjectRecord, Task } from './types'
import { hash } from './util'

const byId = <T extends { id: string }>(a: readonly T[], b: readonly T[], pick: (x: T, y: T) => T = x => x): T[] => {
  const map = new Map<string, T>()
  for (const x of b) map.set(x.id, x)
  for (const x of a) {
    const other = map.get(x.id)
    map.set(x.id, other === undefined ? x : pick(x, other))
  }
  return [...map.values()]
}

function mergeContract(mine: Contract, theirs: Contract, now: number): { contract: Contract; conflict?: string } {
  if (theirs.version !== mine.version) return { contract: theirs.version > mine.version ? theirs : mine }
  const reqs = (c: Contract): string => hash(JSON.stringify([c.requirements, c.exclusions, c.scope]))
  if (reqs(theirs) === reqs(mine)) {
    return { contract: theirs.approval.status === 'approved' && mine.approval.status !== 'approved' ? theirs : mine }
  }
  // Both sessions edited the same version: keep ours and keep theirs as a revision, never drop it.
  const snapshot = {
    summary: theirs.summary, requirements: theirs.requirements, exclusions: theirs.exclusions,
    scope: theirs.scope, assumptions: theirs.assumptions, intent: theirs.intent,
  }
  const key = hash(JSON.stringify(snapshot))
  if (mine.revisions.some(r => hash(JSON.stringify(r.snapshot)) === key)) return { contract: mine }
  return {
    contract: { ...mine, revisions: [...mine.revisions, { version: theirs.version, at: now, change: 'concurrent edit from another session (kept for review)', snapshot }].slice(-50) },
    conflict: `concurrent contract edit at v${mine.version}: kept this session's, saved the other as a revision`,
  }
}

function mergeTask(mine: Task, theirs: Task, now: number): Task {
  const { contract, conflict } = mergeContract(mine.contract, theirs.contract, now)
  const files = { ...theirs.files }
  for (const [path, f] of Object.entries(mine.files)) {
    const o = files[path]
    files[path] = o === undefined || f.lastSeq >= o.lastSeq ? { ...f, changes: Math.max(f.changes, o?.changes ?? 0) } : o
  }
  const activity = [...theirs.activity, ...mine.activity]
    .filter((a, i, all) => all.findIndex(b => b.at === a.at && b.text === a.text) === i)
    .sort((a, b) => a.at - b.at)
  if (conflict) activity.push({ at: now, kind: 'contract', text: conflict })
  // Evidence ids are per-session counters: an id clash with different content is renamed, not dropped.
  const evidence = [...mine.evidence]
  for (const e of theirs.evidence) {
    const same = evidence.find(x => x.id === e.id)
    if (same === undefined) evidence.push(e)
    else if (same.timestamp !== e.timestamp || same.command !== e.command) evidence.push({ ...e, id: `${e.id}b` })
  }
  return {
    ...mine,
    contract,
    updatedAt: Math.max(mine.updatedAt, theirs.updatedAt),
    seq: Math.max(mine.seq, theirs.seq),
    nextEvidence: Math.max(mine.nextEvidence, theirs.nextEvidence),
    files,
    evidence: evidence.sort((a, b) => a.timestamp - b.timestamp),
    findings: byId(mine.findings, theirs.findings, (x, y) => {
      const decided = (f: typeof x) => f.status === 'waived' || f.status === 'acknowledged'
      return decided(y) && !decided(x) ? y : x
    }),
    claims: byId(mine.claims, theirs.claims).sort((a, b) => a.at - b.at),
    activity,
    notified: [...new Set([...theirs.notified, ...mine.notified])],
  }
}

/** Merges the stored record into this session's. Pure; `mine` wins only where both changed the same field. */
export function mergeProjects(mine: ProjectRecord, stored: ProjectRecord | undefined, now: number): ProjectRecord {
  if (stored === undefined || stored.schema !== 1) return { ...mine, rev: mine.rev + 1, updatedAt: now }
  if (stored.rev === mine.rev && stored.writer === mine.writer) return { ...mine, rev: mine.rev + 1, updatedAt: now }
  const tasks: Record<string, Task> = { ...stored.tasks }
  for (const [id, t] of Object.entries(mine.tasks)) {
    const other = tasks[id]
    tasks[id] = other === undefined ? t : mergeTask(t, other, now)
  }
  return { ...mine, tasks, rev: Math.max(mine.rev, stored.rev) + 1, updatedAt: now }
}

/**
 * Retention and size: tasks idle past `retentionDays` (never the active one)
 * are dropped, then lists are cut oldest-first until the record fits `maxBytes`.
 */
export function trimProject(p: ProjectRecord, now: number, retentionDays: number, maxBytes: number): ProjectRecord {
  const cutoff = now - retentionDays * 86_400_000
  for (const [id, t] of Object.entries(p.tasks)) if (id !== p.activeTaskId && t.updatedAt < cutoff) delete p.tasks[id]
  const ids = Object.keys(p.tasks).sort((a, b) => (p.tasks[a]?.updatedAt ?? 0) - (p.tasks[b]?.updatedAt ?? 0))
  while (ids.length > 20) {
    const id = ids.shift() as string
    if (id !== p.activeTaskId) delete p.tasks[id]
  }
  let guard = 0
  while (JSON.stringify(p).length > maxBytes && guard++ < 12) {
    for (const t of Object.values(p.tasks)) {
      const half = <T>(list: T[]): T[] => list.slice(Math.floor(list.length / 2))
      t.activity = half(t.activity)
      t.evidence = half(t.evidence)
      t.claims = half(t.claims)
      t.findings = t.findings.filter(f => f.status !== 'resolved')
      t.contract.revisions = half(t.contract.revisions)
    }
  }
  return p
}
