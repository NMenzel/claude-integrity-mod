// Completion Claim Auditor: finds concrete claims of finished work in a final
// answer and weighs each against recorded evidence. It tells "no evidence"
// (unsupported) apart from "evidence says otherwise" (contradicted), and never
// treats a missing observation as proof that something did not happen.

import type { CheckKind, Claim, ClaimKind, ClaimVerdict, Evidence, Task } from './types'
import { freshness, isProof } from './evidence'
import { requirementState } from './status'
import { clip, hash, redact, sentences } from './util'

const PATTERNS: readonly [ClaimKind, RegExp][] = [
  ['tests-pass', /\b(all\s+)?(the\s+)?(\w+\s+)?tests?\s+(now\s+)?(all\s+)?(pass(es|ed|ing)?|succeed(s|ed)?|are\s+(passing|green)|(are\s+|is\s+)?green)\b|\b\d+\s*(\/\s*\d+\s+)?tests?\s+pass(ed|ing)?\b|\btest suite\s+(passes|passed|is green)\b/i],
  ['build', /\bbuild\s+(now\s+)?(succeeds|succeeded|passes|passed|works|is\s+green)\b|\bbuilds?\s+(cleanly|successfully)\b|\bcompiles?\s+(cleanly|successfully|without\s+errors)\b/i],
  ['typecheck', /\b(type[- ]?check(s|ing)?|tsc|types?)\s+(now\s+)?(pass(es|ed)?|is\s+clean|are\s+clean|succeeds?)\b|\bno\s+type\s+errors\b/i],
  ['lint', /\blint(ing|er)?\s+(now\s+)?(pass(es|ed)?|is\s+clean|succeeds?)\b|\bno\s+lint(ing)?\s+(errors|warnings|issues)\b/i],
  ['migration', /\bmigrations?\s+(ran|run|applied|succeeded|completed)\b|\bmigrations?\s+(was|were|has been|have been)\s+(applied|run)\b/i],
  ['production-ready', /\bproduction[- ]ready\b|\bready\s+for\s+production\b/i],
  ['responsive', /\b(fully\s+)?responsive\b/i],
  ['browser', /\b(works|verified|tested|checked)\s+in\s+(the\s+)?browser\b|\bend[- ]to[- ]end\b.*\b(works|pass)|\b(user\s+(flow|journey)|ui)\s+(works|is working)\b/i],
  ['live-data', /\b(fetch(es|ed)?|load(s|ed)?|pull(s|ed)?|comes?|retrieved?)\b[^.]{0,40}\bfrom\s+the\s+(live\s+|real\s+)?(api|backend|server|database|db)\b|\b(live|real)\s+(api\s+)?data\b/i],
  ['implemented', /\b[\w-]+(\s+[\w-]+){0,2}\s+(is|are|has\s+been|have\s+been)\s+(now\s+)?(fully\s+)?(implemented|complete(d)?|done|finished)\b|\b(i\s+(have\s+)?|i've\s+)(implemented|completed|finished)\b/i],
  ['works', /\b(verified|confirmed)\s+(that\s+)?(it|this|everything)\s+works\b|\beverything\s+works\b|\b(it|this)\s+(now\s+)?works\s+(correctly|as expected)\b/i],
]

/** Hedges, negations, instructions and plans are not claims of completed work. */
const NOT_A_CLAIM = /\b(not|n't|never|nothing|none|no longer|unable|cannot|could not|didn't|did not|haven't|have not|hasn't|without running|unverified|untested|should|will|would|may|might|once|if|when you|you can|you could|to verify|try|please|run `|need to|needs to|todo|next step|failing|fails|failed)\b|\?$/i

export function extractClaims(answer: string): { kind: ClaimKind; text: string }[] {
  const out: { kind: ClaimKind; text: string }[] = []
  for (const s of sentences(answer)) {
    if (NOT_A_CLAIM.test(s)) continue
    for (const [kind, re] of PATTERNS) {
      if (re.test(s) && !out.some(c => c.kind === kind && c.text === s)) out.push({ kind, text: s })
    }
  }
  return out
}

type Judged = { verdict: ClaimVerdict; reason: string; evidenceIds: string[] }

const CHECK_OF: Partial<Record<ClaimKind, CheckKind>> = {
  'tests-pass': 'test', build: 'build', typecheck: 'typecheck', lint: 'lint', migration: 'migration', browser: 'browser',
}

function judgeCheck(kind: ClaimKind, text: string, task: Task): Judged {
  const check = CHECK_OF[kind] as CheckKind
  const runs = task.evidence.filter(e => e.check === check || (check === 'test' && e.check === 'browser' && /\b(e2e|end[- ]to[- ]end|browser)\b/i.test(text)))
  const real = runs.filter(e => e.synthetic !== true)
  const current = real.filter(e => freshness(e, task) !== 'stale')
  const ids = (list: Evidence[]): string[] => list.slice(-3).map(e => e.id)
  const failed = current.filter(e => e.outcome === 'fail').at(-1)
  const passed = current.filter(e => e.outcome === 'pass')
  // Observation order decides which run is latest; clocks can tie.
  const order = (e: Evidence | undefined): number => (e === undefined ? -1 : task.evidence.indexOf(e))

  if (failed !== undefined && order(passed.at(-1)) < order(failed)) {
    return { verdict: 'contradicted', reason: `latest ${check} run failed: ${failed.summary}`, evidenceIds: [failed.id] }
  }
  if (passed.length === 0) {
    if (kind === 'browser' && task.evidence.some(e => e.check === 'test' && e.outcome === 'pass')) {
      return { verdict: 'unsupported', reason: 'unit tests passed, but no browser test ran: unit tests do not prove a browser journey', evidenceIds: [] }
    }
    if (real.some(e => e.outcome === 'pass')) return { verdict: 'unsupported', reason: `only stale ${check} evidence: code changed after the last passing run`, evidenceIds: ids(real) }
    if (runs.length > real.length) return { verdict: 'unsupported', reason: `only synthetic ${check} results: nothing was executed`, evidenceIds: ids(runs) }
    if (runs.length > 0) return { verdict: 'unsupported', reason: `${check} runs were inconclusive (${runs.at(-1)?.basis})`, evidenceIds: ids(runs) }
    return { verdict: 'unsupported', reason: `no ${check} run was observed for this task`, evidenceIds: [] }
  }
  const last = passed.at(-1) as Evidence
  const broad = /\ball\b|\bevery\b|\bentire\b|\bfull\b/i.test(text)
  const namesOther = kind === 'tests-pass' && /\b(integration|e2e|end[- ]to[- ]end|browser)\b/i.test(text) && !passed.some(e => /integration|e2e|playwright|cypress/i.test(e.command ?? ''))
  if (namesOther) return { verdict: 'partial', reason: `${last.summary}, but no integration/e2e run was observed`, evidenceIds: ids(passed) }
  if (broad && (last.scope.length > 0 || (last.counts?.skipped ?? 0) > 0)) {
    const why = last.scope.length > 0 ? `the run was scoped to ${last.scope.join(', ')}` : `${last.counts?.skipped} tests were skipped`
    return { verdict: 'partial', reason: `${last.summary}; ${why}`, evidenceIds: ids(passed) }
  }
  if (last.truncated && last.counts === undefined) return { verdict: 'partial', reason: `${last.summary}; output truncated, summary not seen`, evidenceIds: ids(passed) }
  return { verdict: 'supported', reason: `${last.summary} via ${last.basis} (${last.id})`, evidenceIds: ids(passed) }
}

function judge(kind: ClaimKind, text: string, task: Task): Judged {
  if (CHECK_OF[kind] !== undefined) return judgeCheck(kind, text, task)
  const openMirage = task.findings.filter(f => f.system === 'mirage' && f.status === 'open')
  switch (kind) {
    case 'live-data': {
      const mock = openMirage.find(f => /^MIR-(A1|D1|B1|B2)/.test(f.ruleId) && f.confidence !== 'expected')
      if (mock) return { verdict: 'contradicted', reason: `potentially contradicted: ${mock.ruleId} in ${mock.file}:${mock.line} (${mock.explanation})`, evidenceIds: [] }
      const runtime = task.evidence.filter(e => (e.kind === 'runtime-check' || e.kind === 'manual-confirmation') && isProof(e, task))
      return runtime.length > 0
        ? { verdict: 'partial', reason: 'a runtime check passed; it does not show where the data came from', evidenceIds: runtime.map(e => e.id) }
        : { verdict: 'not-assessable', reason: 'static analysis cannot prove live data; no runtime check observed', evidenceIds: [] }
    }
    case 'implemented': {
      const placeholder = openMirage.find(f => f.confidence === 'confirmed')
      if (placeholder) return { verdict: 'contradicted', reason: `${placeholder.ruleId} in ${placeholder.file}:${placeholder.line}: ${placeholder.explanation}`, evidenceIds: [] }
      const must = task.contract.requirements.filter(r => r.criticality === 'must' && r.waiver === undefined)
      const states = must.map(r => requirementState(r, task).state)
      const verified = states.filter(s => s === 'verified').length
      if (must.length > 0 && verified === must.length) return { verdict: 'supported', reason: `all ${must.length} must requirements verified`, evidenceIds: [] }
      if (states.includes('failed')) return { verdict: 'contradicted', reason: 'a must requirement has failing evidence', evidenceIds: [] }
      if (verified > 0 || Object.keys(task.files).length > 0) {
        return { verdict: 'partial', reason: `code changes observed; ${verified}/${must.length} must requirements verified`, evidenceIds: [] }
      }
      return { verdict: 'unsupported', reason: 'no code changes or verification observed', evidenceIds: [] }
    }
    case 'production-ready':
    case 'responsive':
      return { verdict: 'not-assessable', reason: `"${kind}" cannot be judged from source and terminal output; needs a manual or runtime check`, evidenceIds: [] }
    default: {
      const proof = task.evidence.filter(e => isProof(e, task))
      return proof.length > 0
        ? { verdict: 'partial', reason: `${proof.length} passing check(s); "works" is broader than any one of them`, evidenceIds: proof.slice(-3).map(e => e.id) }
        : { verdict: 'unsupported', reason: 'no passing check observed', evidenceIds: [] }
    }
  }
}

export function auditAnswer(answer: string, task: Task, turnId: string, now: number): Claim[] {
  return extractClaims(answer).map(({ kind, text }) => ({
    id: hash(`${turnId}|${kind}|${text}`),
    turnId,
    text: clip(redact(text), 200),
    kind,
    ...judge(kind, text, task),
    at: now,
  }))
}
