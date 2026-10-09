// Intent drift: observed changes compared with the contract. A file name alone
// never proves intent, so only a match against an exclusion glob the person
// approved is `confirmed`; every other rule reports a `potential` drift and
// says what to check.

import type { Confidence, Contract, FileChange, Severity } from './types'
import type { RawFinding } from './mirage'
import { clip, hash, isCodePath, isPathPattern, matchesGlob } from './util'

export type DriftFinding = RawFinding & { id: string; requirementIds: string[] }

const ROUTE_FILE = /(^|\/)app\/(.+\/)?(page|route)\.(t|j)sx?$|(^|\/)pages\/(?!_app|_document|api\/).+\.(t|j)sx?$|(^|\/)routes\/.+\.(t|j)sx?$/i
const NO_NEW = /\b(?:do not|don't|never|must not|mustn't|without|avoid)\s+(?:creat\w*|add\w*|introduc\w*|mak\w*|build\w*)\s+(?:another|a new|new|a second|second|separate|an additional|additional|a duplicate|duplicate)\s+([\w-]+)(?:\s+(page|route|screen|view|component|endpoint|module|file|service|table))?/i

function make(change: FileChange, ruleId: string, fields: Omit<RawFinding, 'ruleId' | 'line' | 'snippet'> & { requirementIds?: string[] }): DriftFinding {
  const { requirementIds = [], ...rest } = fields
  return {
    ruleId, line: 1, snippet: `${change.kind} ${change.path}`, ...rest, requirementIds,
    id: hash(`${ruleId}|${change.path}|${requirementIds.join(',')}`),
  }
}

function dependencies(json: string | null | undefined): Set<string> {
  if (json === null || json === undefined) return new Set()
  try {
    const parsed = JSON.parse(json) as Record<string, Record<string, string> | undefined>
    return new Set([...Object.keys(parsed['dependencies'] ?? {}), ...Object.keys(parsed['devDependencies'] ?? {})])
  } catch {
    return new Set()
  }
}

export function driftFindings(change: FileChange, contract: Contract): DriftFinding[] {
  const out: DriftFinding[] = []
  const approved = contract.approval.status === 'approved' || contract.baseline !== undefined
  const asked = [contract.summary, ...contract.requirements.map(r => r.description), ...contract.assumptions].join(' ').toLowerCase()
  const preservation = contract.requirements.filter(r => r.category === 'preservation' && r.waiver === undefined)

  for (const glob of contract.exclusions.filter(isPathPattern)) {
    if (!matchesGlob(change.path, glob)) continue
    out.push(make(change, 'DRIFT-X1', {
      category: 'Excluded path changed', severity: 'high', confidence: approved ? 'confirmed' : 'potential',
      requirementIds: contract.requirements.filter(r => r.description.includes(glob)).map(r => r.id),
      explanation: `The contract excludes "${glob}", and ${change.path} was ${change.kind === 'create' ? 'created' : change.kind === 'delete' ? 'deleted' : 'modified'}.`,
      evidence: `Observed ${change.kind} of ${change.path}; exclusion "${glob}" ${approved ? 'is in the approved contract' : 'is in an unapproved draft'}.`,
      verify: 'Revert the change, or amend the contract if the exclusion no longer holds.',
    }))
  }

  if (contract.scope.length > 0 && isCodePath(change.path) && !contract.scope.some(g => matchesGlob(change.path, g))) {
    out.push(make(change, 'DRIFT-S1', {
      category: 'Change outside scope', severity: 'medium', confidence: 'potential',
      explanation: `${change.path} is outside the contract's scope (${contract.scope.join(', ')}).`,
      evidence: `Observed ${change.kind} of ${change.path}.`,
      verify: 'Confirm the change is needed for the task, or widen the scope explicitly.',
    }))
  }

  if (change.kind === 'create') {
    for (const r of contract.requirements) {
      const m = r.waiver === undefined ? r.description.match(NO_NEW) : null
      const noun = m?.[1]?.toLowerCase()
      if (noun === undefined || noun.length < 3 || !change.path.toLowerCase().includes(noun)) continue
      out.push(make(change, 'DRIFT-N1', {
        category: 'Possible duplicate of existing feature', severity: 'high', confidence: 'potential', requirementIds: [r.id],
        explanation: `${r.id} says "${clip(r.description, 90)}", and a new file ${change.path} names "${noun}".`,
        evidence: `New file whose path contains "${noun}"${ROUTE_FILE.test(change.path) ? ' and that defines a route' : ''}. The name alone does not prove a duplicate.`,
        verify: `Check whether ${change.path} replaces or duplicates the existing ${noun}; extend the existing one instead if so.`,
      }))
    }
    if (ROUTE_FILE.test(change.path) && preservation.some(r => /\b(navigation|route|routing|url|page)\b/i.test(r.description))) {
      const ids = preservation.filter(r => /\b(navigation|route|routing|url|page)\b/i.test(r.description)).map(r => r.id)
      out.push(make(change, 'DRIFT-R1', {
        category: 'New route while routes are preserved', severity: 'medium', confidence: 'potential', requirementIds: ids,
        explanation: `${change.path} adds a route, and ${ids.join(', ')} asks to preserve the current navigation.`,
        evidence: `New route file ${change.path}.`,
        verify: 'Open the app and confirm the existing navigation still leads where it did.',
      }))
    }
  }

  if (change.kind === 'delete' && isCodePath(change.path)) {
    out.push(make(change, 'DRIFT-D1', {
      category: 'Existing behaviour deleted', severity: preservation.length > 0 ? 'high' : 'medium', confidence: 'potential',
      requirementIds: preservation.map(r => r.id),
      explanation: `${change.path} was deleted; whatever it did is gone unless moved elsewhere.`,
      evidence: `Observed deletion of ${change.path}.`,
      verify: 'Confirm its behaviour moved elsewhere or is no longer needed.',
    }))
  }

  if (change.kind === 'update' && typeof change.before === 'string' && change.after !== undefined && isCodePath(change.path)) {
    const before = change.before.split('\n').map(l => l.trim()).filter(Boolean)
    const after = new Set(change.after.split('\n').map(l => l.trim()))
    const kept = before.filter(l => after.has(l)).length
    if (before.length >= 30 && kept / before.length < 0.4) {
      out.push(make(change, 'DRIFT-W1', {
        category: 'Rewrite instead of extension', severity: preservation.length > 0 ? 'medium' : 'low', confidence: 'potential',
        requirementIds: preservation.map(r => r.id),
        explanation: `${change.path} kept ${Math.round((kept / before.length) * 100)}% of its previous lines: it was largely rewritten.`,
        evidence: `${kept} of ${before.length} non-empty lines survive the change.`,
        verify: 'Check that the existing behaviour of this file still works.',
      }))
    }
  }

  if (/(^|\/)package\.json$/.test(change.path) && change.after !== undefined) {
    const before = dependencies(change.before)
    const added = [...dependencies(change.after)].filter(d => !before.has(d) && !asked.includes(d.toLowerCase().replace(/^@[^/]+\//, '')))
    if (added.length > 0 && change.before !== undefined) {
      out.push(make(change, 'DRIFT-P1', {
        category: 'Dependency added without a requirement', severity: 'medium', confidence: 'potential' as Confidence,
        explanation: `New dependencies not mentioned by the contract: ${added.slice(0, 6).join(', ')}.`,
        evidence: `package.json gained ${added.length} dependenc${added.length === 1 ? 'y' : 'ies'}.`,
        verify: 'Confirm each dependency is needed, or record it as an assumption.',
      }))
    }
  }
  return out.map(f => ({ ...f, severity: f.severity as Severity }))
}
