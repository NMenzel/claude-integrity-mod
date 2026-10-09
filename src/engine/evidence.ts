// The Witness: evidence from observed tool calls, its provenance and freshness.
// Outcomes come from the tool's completion state (core's isError, interrupt,
// background, deny, synthetic answer) first; output text only refines it, and
// never turns a failed or unobserved run into a pass.

import type { CheckKind, Evidence, EvidenceKind, Freshness, Outcome, Task, ToolObservation } from './types'
import { clip, isCodePath, isDocPath, redact } from './util'

type Classified = { check: CheckKind; scope: string[] }

const CHECKS: readonly [CheckKind, RegExp][] = [
  ['browser', /\b(playwright\s+test|cypress\s+run|wdio\s+run|testcafe)\b/i],
  ['migration', /\b(prisma\s+migrate|drizzle-kit\s+(push|migrate)|knex\s+migrate|sequelize\s+db:migrate|alembic\s+upgrade|rails\s+db:migrate|manage\.py\s+migrate|typeorm\s+migration:run|supabase\s+db\s+push)\b/i],
  ['test', /\b((npm|pnpm|yarn|bun)\s+(run\s+)?test(:\w+)?|jest|vitest|mocha|ava|pytest|python3?\s+-m\s+(pytest|unittest)|go\s+test|cargo\s+test|dotnet\s+test|node\s+--test|deno\s+test|claude\s+plugin\s+test|rspec|phpunit|(mvn|mvnw)(\s+-\S+)*\s+test|gradlew?\s+test)\b/i],
  ['typecheck', /\b(tsc|vue-tsc|mypy|pyright|(npm|pnpm|yarn|bun)\s+(run\s+)?(typecheck|type-check|check-types))\b|typescript\.js/i],
  ['lint', /\b(eslint|biome\s+(check|lint)|ruff|flake8|clippy|golangci-lint|prettier\s+--check|(npm|pnpm|yarn|bun)\s+(run\s+)?lint|claude\s+plugin\s+validate)\b/i],
  ['build', /\b((npm|pnpm|yarn|bun)\s+(run\s+)?build|next\s+build|vite\s+build|cargo\s+build|go\s+build|dotnet\s+build|webpack|(mvn|mvnw)(\s+-\S+)*\s+(package|install|compile|verify)|gradlew?\s+(build|assemble))\b/i],
]

const SUBCOMMANDS = new Set(['run', 'test', 'exec', 'watch', 'npx', 'npm', 'pnpm', 'yarn', 'bun', '--'])

/** Paths or filters a check names: `vitest run src/events` scopes to `src/events`. Empty: the whole project. */
function scopeOf(segment: string, match: RegExpMatchArray): string[] {
  const rest = segment.slice((match.index ?? 0) + match[0].length)
  return rest
    .split(/\s+/)
    .map(t => t.replace(/^['"]|['"]$/g, '').split('::')[0] ?? '')
    .filter(t => t !== '' && !t.startsWith('-') && !SUBCOMMANDS.has(t) && (/[/\\]/.test(t) || /\.\w{1,5}$/.test(t)))
    .map(t => t.replace(/\\/g, '/').replace(/^\.\//, ''))
}

/** Splits a shell line into its `&&`/`;`/`||` segments and classifies each that is a known check. */
export function classifyCommand(command: string): Classified[] {
  const found: Classified[] = []
  for (const segment of command.split(/&&|\|\||;|\n/)) {
    const head = segment.split('|')[0] ?? ''
    for (const [check, pattern] of CHECKS) {
      const match = head.match(pattern)
      if (match) {
        found.push({ check, scope: scopeOf(head, match) })
        break
      }
    }
  }
  return found
}

/** A pipe after the check, `|| true` or `; exit 0` hide the check's own exit status. */
export function isExitMasked(command: string): boolean {
  return /\|\|\s*(true|:|exit\s+0)\b|;\s*(true|exit\s+0)\s*$/.test(command) ||
    command.split(/&&|;|\n/).some(seg => {
      const pipe = seg.indexOf('|')
      return pipe >= 0 && seg[pipe + 1] !== '|' && classifyCommand(seg.slice(0, pipe)).length > 0 && !/set\s+-o\s+pipefail/.test(command)
    })
}

export type Counts = { passed: number; failed: number; skipped: number }

/** Reads the summary line of common runners (jest, vitest, mocha, pytest, cargo, go, node:test). */
export function parseCounts(output: string): Counts | undefined {
  const lines = output.split(/\r?\n/)
  const summary =
    lines.filter(l => /^\s*Tests?:?\s/i.test(l) && /\d/.test(l)).at(-1) ??
    lines.filter(l => /test result:|^=+ .*\d+ (passed|failed)|\d+ (passing|failing)/i.test(l)).join(' ') ??
    ''
  const text = summary !== '' ? summary : lines.filter(l => /^#\s*(pass|fail|skipped|todo)\s+\d+/i.test(l) || /\b\d+\s+(passed|failed|skipped)\b/i.test(l)).join(' ')
  if (text === '') {
    const goFails = lines.filter(l => /^--- FAIL:/.test(l)).length
    const goOk = lines.filter(l => /^ok\s+\S+/.test(l)).length
    return goFails + goOk > 0 ? { passed: goOk, failed: goFails, skipped: 0 } : undefined
  }
  const sum = (re: RegExp): number => [...text.matchAll(re)].reduce((n, m) => n + Number(m[1] ?? m[2] ?? 0), 0)
  return {
    passed: sum(/(\d+)\s+(?:passed|passing)\b|#\s*pass\s+(\d+)/gi),
    failed: sum(/(\d+)\s+(?:failed|failing)\b|#\s*fail\s+(\d+)/gi),
    skipped: sum(/(\d+)\s+(?:skipped|pending|ignored|todo)\b|#\s*(?:skipped|todo)\s+(\d+)/gi),
  }
}

const EVIDENCE_KIND: Record<CheckKind, EvidenceKind> = {
  test: 'test-result', browser: 'runtime-check', migration: 'runtime-check', build: 'tool-result',
  typecheck: 'tool-result', lint: 'tool-result', manual: 'manual-confirmation', static: 'static-analysis', other: 'tool-result',
}

type BashRecord = {
  interrupted?: boolean
  backgroundTaskId?: string
  timedOutAfterMs?: number
  persistedOutputPath?: string
  stdout?: string
  stderr?: string
}

/**
 * Evidence from one observed Bash call, or none when the command runs no
 * known check. One record per check the line runs.
 */
export function evidenceFromBash(obs: ToolObservation, seq: number, now: number, nextId: () => string): Evidence[] {
  const command = typeof obs.input['command'] === 'string' ? obs.input['command'] : ''
  const checks = classifyCommand(command)
  if (checks.length === 0) return []
  const record = (obs.result ?? {}) as BashRecord
  const output = `${record.stdout ?? ''}\n${record.stderr ?? ''}\n${obs.text}`
  const counts = parseCounts(output)
  const truncated = record.persistedOutputPath !== undefined || /output too large|\[truncated\]|… \d+ (more )?lines/i.test(obs.text)
  const masked = isExitMasked(command)

  let outcome: Outcome
  let basis: string
  if (obs.denied !== undefined) [outcome, basis] = ['inconclusive', 'permission denied: not executed']
  else if (!obs.ranInCore) [outcome, basis] = ['inconclusive', 'synthetic: answered by a plugin, not executed']
  else if (record.backgroundTaskId !== undefined) [outcome, basis] = ['inconclusive', 'moved to background: completion not observed']
  else if (record.timedOutAfterMs !== undefined) [outcome, basis] = ['inconclusive', `timed out after ${record.timedOutAfterMs} ms`]
  else if (record.interrupted === true) [outcome, basis] = ['inconclusive', 'interrupted']
  else if (counts !== undefined && counts.failed > 0) [outcome, basis] = ['fail', masked ? 'output reports failures (exit status masked)' : 'output reports failures']
  else if (masked) {
    ;[outcome, basis] = counts !== undefined && counts.passed > 0
      ? ['pass', 'output summary; exit status masked by a pipe or `|| true`']
      : ['inconclusive', 'exit status masked by a pipe or `|| true`']
  } else if (obs.isError) [outcome, basis] = ['fail', exitCode(obs.text) ?? 'exit non-zero']
  else if ((counts === undefined || counts.passed + counts.failed === 0) && /no tests? (found|ran)|no test files/i.test(output)) {
    ;[outcome, basis] = ['inconclusive', 'exit 0 but no tests ran']
  } else [outcome, basis] = ['pass', 'exit 0']

  return checks.map((c, i) => {
    // In a chain that failed, only a check whose own output says so is known to have failed.
    const chainFailed = checks.length > 1 && outcome === 'fail' && !(c.check === 'test' && (counts?.failed ?? 0) > 0)
    const own = chainFailed ? 'inconclusive' : outcome
    const ownBasis = chainFailed ? `${basis}; chained with other commands, failing step unknown` : basis
    const tally = c.check === 'test' || c.check === 'browser' ? counts : undefined
    return {
      id: nextId(),
      requirementIds: [],
      kind: EVIDENCE_KIND[c.check],
      check: c.check,
      outcome: own,
      timestamp: now + i,
      source: obs.tool,
      summary: summarize(c.check, own, tally, truncated),
      command: clip(redact(command), 240),
      basis: ownBasis,
      scope: c.scope,
      ...(tally === undefined ? {} : { counts: tally }),
      ...(truncated ? { truncated } : {}),
      ...(obs.ranInCore ? {} : { synthetic: true }),
      ...(obs.cwd === undefined ? {} : { cwd: redact(obs.cwd) }),
      ...(obs.revision === undefined ? {} : { revision: obs.revision }),
      ...(obs.agentId === undefined ? {} : { agentId: obs.agentId }),
      seq,
    }
  })
}

const exitCode = (text: string): string | undefined => {
  const m = text.match(/exit (?:code|status)[:\s]+(\d+)/i)
  return m ? `exit ${m[1]}` : undefined
}

function summarize(check: CheckKind, outcome: Outcome, counts: Counts | undefined, truncated: boolean): string {
  const tally = counts === undefined ? '' : ` (${counts.passed} passed, ${counts.failed} failed${counts.skipped ? `, ${counts.skipped} skipped` : ''})`
  return `${check} ${outcome}${tally}${truncated ? ', output truncated' : ''}`
}

/** A browser automation call is an observed session, not an assertion: inconclusive until a person confirms. */
export function evidenceFromBrowserTool(obs: ToolObservation, seq: number, now: number, id: string): Evidence | undefined {
  if (!/^mcp__.*(playwright|chrome|browser|puppeteer)/i.test(obs.tool)) return undefined
  return {
    id, requirementIds: [], kind: 'runtime-check', check: 'browser', outcome: 'inconclusive', timestamp: now,
    source: obs.tool, summary: 'browser session observed (no assertion)', basis: obs.ranInCore ? 'interaction only' : 'synthetic',
    scope: [], seq, ...(obs.ranInCore ? {} : { synthetic: true }),
  }
}

const CONFIG = /(^|\/)(package\.json|tsconfig[^/]*\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|vite\.config\.\w+|jest\.config\.\w+|vitest\.config\.\w+|next\.config\.\w+|babel\.config\.\w+)$/i

const stem = (path: string): string => (path.split('/').pop() ?? path).replace(/\.(test|spec)(?=\.)/i, '').replace(/\.\w+$/, '').toLowerCase()
const dir = (path: string): string => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''

/** Whether a change at `path` can affect evidence scoped to `scope`. */
export function relates(path: string, scope: string): boolean {
  const p = path.toLowerCase()
  const s = scope.toLowerCase().replace(/\/$/, '')
  if (p === s || p.startsWith(`${s}/`)) return true
  if (stem(p) === stem(s)) return true
  const sd = /\.\w{1,5}$/.test(s) ? dir(s) : s
  return sd !== '' && dir(p) === sd
}

/** Changes that invalidate `e`: code or config, never docs, made after it was recorded. */
function invalidators(e: Evidence, task: Task): string[] {
  return Object.values(task.files)
    .filter(f => f.lastSeq > e.seq && !isDocPath(f.path) && (isCodePath(f.path) || CONFIG.test(f.path)))
    .filter(f => e.scope.length === 0 || CONFIG.test(f.path) || e.scope.some(s => relates(f.path, s)))
    .map(f => f.path)
}

export function freshness(e: Evidence, task: Task): Freshness {
  if (invalidators(e, task).length > 0) return 'stale'
  if (e.scope.length > 0 && Object.keys(task.files).length > 0 &&
    !Object.keys(task.files).some(p => e.scope.some(s => relates(p, s)))) return 'unrelated'
  return 'fresh'
}

export const staleBecause = (e: Evidence, task: Task): string[] => invalidators(e, task)

/** Evidence that counts as proof: a real, passing, current run. */
export const isProof = (e: Evidence, task: Task): boolean =>
  e.outcome === 'pass' && e.synthetic !== true && freshness(e, task) !== 'stale'

/** The latest record of each check kind, the one the summary shows. */
export function latestByCheck(task: Task): Map<CheckKind, Evidence> {
  const out = new Map<CheckKind, Evidence>()
  for (const e of task.evidence) if (e.check !== 'manual' && e.check !== 'static') out.set(e.check, e)
  return out
}
