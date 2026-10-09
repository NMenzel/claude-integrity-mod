// Intent Fingerprint: requirement contracts captured from the developer's own
// words. Nothing here invents acceptance criteria: only sentences the prompt
// states become requirements; everything else is typed by a person or marked
// `proposed` and waits for approval.

import type {
  Contract, ContractIntent, ContractSnapshot, Criticality, Requirement, RequirementCategory,
} from './types'
import { clip, hash, isPathPattern, redact, sentences } from './util'

const ACTION = /\b(implement|add|build|create|make|fix|refactor|enrich|update|change|replace|remove|delete|migrate|integrate|wire|connect|write|extend|improve|support|rename|port|convert|set up|hook up|ship)\b/i
const QUESTION = /^(what|why|how|when|where|who|which|can|could|does|do|is|are|should|would|explain|tell me|show me)\b/i

/** A prompt worth a contract: an instruction to change something, not a question or a one-liner. */
export function isMeaningfulTask(prompt: string): boolean {
  const text = prompt.trim()
  if (text.length < 25 || text.startsWith('/')) return false
  if (QUESTION.test(text) && text.endsWith('?')) return false
  return ACTION.test(text)
}

const NEGATIVE = /\b(do not|don't|dont|never|must not|mustn't|should not|shouldn't|avoid|without)\b/i
const PRESERVE = /\b(preserve|keep|retain|maintain|leave)\b.*\b(existing|current|unchanged|intact|as is|as-is|navigation|behaviou?r|api|route|layout)\b|\b(existing|current)\b.*\b(must|should)\b.*\b(stay|remain|work)\b/i
const MUST = /\b(must|need to|needs to|has to|have to|required|require|ensure|make sure)\b/i
const SHOULD = /\b(should|ideally|prefer)\b/i
const TESTS = /\b(tests?|spec|coverage|e2e|end-to-end)\b/i
const PERF = /\b(fast|performance|latency|accessib|a11y|responsive|secure|security)\b/i

function categorize(sentence: string): { category: RequirementCategory; criticality: Criticality } | undefined {
  if (PRESERVE.test(sentence)) return { category: 'preservation', criticality: 'must' }
  if (NEGATIVE.test(sentence)) {
    return { category: /\b(existing|current|navigation|route)\b/i.test(sentence) ? 'preservation' : 'constraint', criticality: 'must' }
  }
  if (TESTS.test(sentence) && MUST.test(sentence)) return { category: 'test', criticality: 'must' }
  if (MUST.test(sentence)) return { category: PERF.test(sentence) ? 'non-functional' : 'functional', criticality: 'must' }
  if (SHOULD.test(sentence)) return { category: PERF.test(sentence) ? 'non-functional' : 'functional', criticality: 'should' }
  return undefined
}

export function detectIntent(text: string): ContractIntent {
  const prototype = /\b(prototype|mock(ed|up)?s?|mockup|demo|placeholder|sample data|fake data|fixtures?|wireframe|stub(bed)?|poc|proof of concept|static)\b/i.test(text)
  const production = /\b(live|real|production|persist(ed|ence)?|database|db|backend|api|endpoint|server|save[ds]?|store[ds]?|fetch(ed)?)\b/i.test(text)
  if (prototype && !/\b(not|no|instead of|replace)\b[^.]*\b(mock|placeholder|fake|static|fixture)/i.test(text)) return 'prototype'
  return production ? 'production' : 'unknown'
}

/** Path-like tokens a "do not touch/modify/create" sentence names become exclusion globs. */
function exclusionsFrom(sentence: string): string[] {
  if (!/\b(do not|don't|never|must not)\b.*\b(touch|modify|change|edit|create|delete|remove)\b/i.test(sentence)) return []
  return (sentence.match(/[`'"]?[\w.*/-]+[`'"]?/g) ?? [])
    .map(t => t.replace(/[`'"]/g, '').replace(/[.,;:]+$/, ''))
    .filter(t => isPathPattern(t) && /[/*]/.test(t))
}

function nextRequirementId(requirements: readonly Requirement[]): string {
  const n = requirements.reduce((max, r) => Math.max(max, Number(r.id.slice(1)) || 0), 0)
  return `R${n + 1}`
}

export function makeRequirement(
  existing: readonly Requirement[],
  description: string,
  fields: Partial<Omit<Requirement, 'id' | 'description'>> = {},
): Requirement {
  const category = fields.category ?? 'functional'
  return {
    id: nextRequirementId(existing),
    description: clip(redact(description), 300),
    category,
    criticality: fields.criticality ?? 'must',
    verification: fields.verification ?? (category === 'test' ? 'test' : category === 'preservation' || category === 'constraint' ? 'static' : 'unknown'),
    origin: fields.origin ?? 'manual',
    checks: fields.checks ?? [],
    evidenceIds: [],
    ...(fields.implemented === undefined ? {} : { implemented: fields.implemented }),
  }
}

/**
 * Captures a contract from a prompt without a model: the request is kept by
 * hash and a short redacted excerpt; explicit constraints become requirements.
 */
export function createContract(taskId: string, prompt: string, now: number, source: 'prompt' | 'manual'): Contract {
  const requirements: Requirement[] = []
  const exclusions: string[] = []
  for (const sentence of sentences(prompt)) {
    const kind = categorize(sentence)
    if (kind !== undefined) requirements.push(makeRequirement(requirements, sentence, { ...kind, origin: 'explicit' }))
    exclusions.push(...exclusionsFrom(sentence))
  }
  const first = sentences(prompt)[0] ?? prompt
  return {
    taskId,
    summary: clip(redact(first), 140),
    requirements,
    exclusions: [...new Set(exclusions)],
    scope: [],
    assumptions: [],
    intent: detectIntent(prompt),
    prompt: { hash: hash(prompt), excerpt: clip(redact(prompt), 280), capturedAt: now, source },
    createdAt: now,
    updatedAt: now,
    version: 1,
    approval: { status: 'draft' },
    revisions: [],
  }
}

export const snapshot = (c: Contract): ContractSnapshot =>
  JSON.parse(JSON.stringify({
    summary: c.summary, requirements: c.requirements, exclusions: c.exclusions,
    scope: c.scope, assumptions: c.assumptions, intent: c.intent,
  })) as ContractSnapshot

export function approve(c: Contract, now: number): void {
  c.approval = { status: 'approved', at: now, version: c.version }
  c.baseline ??= snapshot(c)
  c.updatedAt = now
}

/**
 * Every change after the first approval is a versioned revision: the baseline
 * stays as approved, and a change to what is required asks for re-approval.
 */
export function amend(c: Contract, now: number, change: string, mutate: (c: Contract) => void, needsReapproval = true): void {
  mutate(c)
  c.updatedAt = now
  if (c.baseline === undefined) return
  c.version += 1
  c.revisions.push({ version: c.version, at: now, change: clip(change, 200), snapshot: snapshot(c) })
  if (c.revisions.length > 50) c.revisions.splice(0, c.revisions.length - 50)
  if (needsReapproval) c.approval = { ...c.approval, status: 'draft' }
}

export const findRequirement = (c: Contract, id: string): Requirement | undefined =>
  c.requirements.find(r => r.id.toLowerCase() === id.trim().toLowerCase())

export const isApproved = (c: Contract): boolean => c.approval.status === 'approved'
