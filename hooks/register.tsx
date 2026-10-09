// Claude Integrity: the Claude Code Mod adapter. It observes prompts, tool
// calls and turn completions, keeps the engine's state in `$.store`, and draws
// the status line and the /integrity pane. All judgement lives in the pure
// engine (../src/engine); this file does IO and nothing else.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { IntegrityUi } from '../types'
import * as E from '../src/engine/index'
import { renderPane, type PaneActions } from './pane'

const PANE = 'integrity'
const rev = atom({ plugin: 'integrity', key: 'rev' } as const, 0)
const uiState = atom({ plugin: 'integrity', key: 'ui' } as const, { tab: 'overview', page: 0 } as IntegrityUi)

export type Prefs = {
  notify: E.NotifyLevel
  statusHint: boolean
  paneAutoOpen: boolean
  layout: E.Layout
  maxFindings: number
  color: boolean
  autoCapture: boolean
  retentionDays: number
  gitProvenance: boolean
  aiAssist: boolean
}

function prefsFrom(options: PluginOptions, stored: Partial<Prefs> | undefined): Prefs {
  const pick = <T,>(key: keyof Prefs, fallback: T, ok: (v: unknown) => boolean): T => {
    const s = stored?.[key]
    if (s !== undefined && ok(s)) return s as T
    const o = options[key]
    return o !== undefined && ok(o) ? (o as T) : fallback
  }
  const isBool = (v: unknown) => typeof v === 'boolean'
  const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0
  return {
    notify: pick('notify', 'important', v => v === 'off' || v === 'important' || v === 'all'),
    statusHint: pick('statusHint', true, isBool),
    paneAutoOpen: pick('paneAutoOpen', false, isBool),
    layout: pick('layout', 'auto', v => v === 'auto' || v === 'mini' || v === 'compact' || v === 'wide'),
    maxFindings: Math.min(50, Math.round(pick('maxFindings', 8, isNum))),
    color: pick('color', true, isBool),
    autoCapture: pick('autoCapture', true, isBool),
    retentionDays: pick('retentionDays', 30, isNum),
    gitProvenance: pick('gitProvenance', true, isBool),
    aiAssist: pick('aiAssist', false, isBool),
  }
}

const COMMANDS: readonly { name: string; description: string; argumentHint?: string }[] = [
  { name: 'integrity', description: 'Claude Integrity: open the dashboard (or /integrity <subcommand>)', argumentHint: '[help|status|...]' },
  { name: 'integrity-start', description: 'Integrity: start a task contract from text or your last prompt', argumentHint: '[task description]' },
  { name: 'integrity-contract', description: 'Integrity: view or edit the contract (add, edit, remove, crit, check, exclude, scope, intent, ...)', argumentHint: '[add|edit|remove|crit|check|exclude|scope|assume|intent|implemented] ...' },
  { name: 'integrity-approve', description: 'Integrity: approve the contract as the baseline' },
  { name: 'integrity-check', description: 'Integrity: re-check tracked files and evaluate policies (exit 1 in strict mode on violations)' },
  { name: 'integrity-findings', description: 'Integrity: list findings, or ack/reopen one', argumentHint: '[all | ack <id> | reopen <id>]' },
  { name: 'integrity-evidence', description: 'Integrity: list evidence, or link one to a requirement', argumentHint: '[link <E#> <R#>]' },
  { name: 'integrity-verify', description: 'Integrity: record your own manual confirmation of a requirement', argumentHint: '<R#> <what you checked>' },
  { name: 'integrity-report', description: 'Integrity: print the delivery report, or export it to files', argumentHint: '[md|json] [export]' },
  { name: 'integrity-mode', description: 'Integrity: set the mode (observe, review, strict)', argumentHint: '[observe|review|strict]' },
  { name: 'integrity-waive', description: 'Integrity: waive a finding or requirement, with a reason', argumentHint: '<finding-id|R#> <reason>' },
  { name: 'integrity-reset', description: 'Integrity: delete the active task (or all stored data) after confirmation', argumentHint: '[all] [confirm]' },
  { name: 'integrity-ui', description: 'Integrity: configure the status hint, pane and notifications', argumentHint: '[status on|off] [pane open|close] [autoopen on|off] [notify off|important|all] [color on|off] [max N]' },
  { name: 'integrity-layout', description: 'Integrity: set the pane layout', argumentHint: '[auto|mini|compact|wide]' },
  { name: 'integrity-suggest', description: 'Integrity: suggest requirements with one opt-in model call (proposed, needs approval)' },
  { name: 'integrity-help', description: 'Integrity: how it works and every command' },
]

// Short aliases, like Claude DevTools' /bp family: /ig is /integrity (so /ig check, /ig approve ... work too).
const SHORTCUTS: readonly { name: string; to: string; description: string; argumentHint?: string }[] = [
  { name: 'ig', to: 'integrity', description: 'Integrity: open the dashboard (= /integrity); /ig check, /ig start ... run a subcommand', argumentHint: '[view|subcommand] ...' },
  { name: 'igc', to: 'integrity-contract', description: 'Integrity: view or edit the contract (= /integrity-contract)', argumentHint: '[add|edit|remove|crit|check|exclude|scope|intent] ...' },
  { name: 'iga', to: 'integrity-approve', description: 'Integrity: approve the contract (= /integrity-approve)' },
  { name: 'igv', to: 'integrity-verify', description: 'Integrity: record your own confirmation (= /integrity-verify)', argumentHint: '<R#> <what you checked>' },
  { name: 'igf', to: 'integrity-findings', description: 'Integrity: list or triage findings (= /integrity-findings)', argumentHint: '[all | ack <id> | reopen <id>]' },
  { name: 'igr', to: 'integrity-report', description: 'Integrity: print or export the report (= /integrity-report)', argumentHint: '[md|json] [export]' },
]
const ALIASES: Readonly<Record<string, string>> = Object.fromEntries(SHORTCUTS.map(s => [s.name, s.to]))

const HELP = `**Claude Integrity**: never confuse AI-generated implementation with verified completion.

It keeps a *contract* (what you asked for), watches *changes* and *checks* Claude runs, flags *mirages* (code that looks finished but isn't) and audits *completion claims* against evidence. Nothing is "verified" without a real, passing, current check, or your own confirmation.

1. Describe a task, or \`/integrity-start <task>\`: a draft contract is captured from your words (no model call).
2. \`/integrity-contract\` to review; \`add\`, \`edit R2 ...\`, \`crit R2 should\`, \`check R1 npm test\`, \`exclude app/legacy/**\`, \`intent prototype\`.
3. \`/integrity-approve\` freezes the baseline; later edits become versioned revisions.
4. Work normally. Test/build/lint/typecheck runs become evidence; later edits make it stale.
5. \`/integrity\` opens the dashboard (keys 1-7 switch views). \`/integrity-report export\` writes Markdown + JSON.

Other: \`/integrity-verify R3 <what you checked>\` · \`/integrity-waive <id> <reason>\` · \`/integrity-findings ack <id>\` · \`/integrity-evidence link E4 R2\` · \`/integrity-mode observe|review|strict\` · \`/integrity-check\` · \`/integrity-ui\` · \`/integrity-layout\` · \`/integrity-suggest\` (opt-in AI) · \`/integrity-reset\`.

Short aliases: \`/ig\` (= \`/integrity\`; \`/ig check\`, \`/ig start ...\`) · \`/igc\` contract · \`/iga\` approve · \`/igv\` verify · \`/igf\` findings · \`/igr\` report.

Modes: **observe** (default) records and notes; **review** adds a summary of open must-requirements and high findings after each answer; **strict** also refuses edits to paths the approved contract excludes and makes \`/integrity-check\` exit 1 on policy violations. Nothing blocks a turn from completing; the Mods API cannot, so Integrity says so instead of pretending.`

type Runtime = {
  options: PluginOptions
  project?: E.ProjectRecord
  loading?: Promise<E.ProjectRecord>
  key: string
  root: string
  session: string
  prefs: Prefs
  storedPrefs?: Partial<Prefs>
  lastStatus?: string
  dirty: boolean
  writing?: Promise<void>
  deleted: Set<string>
  lastPrompt?: string
  suggested: Map<string, string[]>
}


function freshRuntime(options: PluginOptions): Runtime {
  return { options, key: '', root: '', session: 'session', prefs: prefsFrom(options, undefined), dirty: false, deleted: new Set(), suggested: new Map() }
}

/** Module state, renewed each time the engine loads the module (a hot reload is a fresh load). */
let rt: Runtime = freshRuntime({})

function now($: EngineInterface): Promise<number> {
  return $.clock.now()
}

function rel(path: string): string {
  return E.normalizePath(path, rt.root)
}

function ensure($: EngineInterface): Promise<E.ProjectRecord> {
  if (rt.project !== undefined) return Promise.resolve(rt.project)
  rt.loading ??= (async () => {
    const repo = await $.session.repo().catch(() => null)
    const root = repo?.root ?? (await $.session.root().catch(() => $.session.cwd()))
    rt.root = root
    rt.key = E.projectKey(root, repo?.remote)
    rt.session = await $.session.id().catch(() => 'session')
    rt.storedPrefs = ((await $.store.get('prefs')) ?? undefined) as Partial<Prefs> | undefined
    rt.prefs = prefsFrom(rt.options, rt.storedPrefs)
    const stored = (await $.store.get(rt.key)) as E.ProjectRecord | undefined
    const label = repo?.remote ?? root.replace(/\\/g, '/').split('/').slice(-2).join('/')
    rt.project = stored?.schema === 1 ? stored : E.newProject(rt.key, label, rt.session, await now($))
    return rt.project
  })()
  return rt.loading
}

/** Re-reads, merges and writes; writes coalesce, so a burst of changes is one or two writes. */
async function writeOnce($: EngineInterface): Promise<void> {
  const mine = rt.project
  if (mine === undefined) return
  const t = await now($)
  const stored = (await $.store.get(rt.key)) as E.ProjectRecord | undefined
  const merged = E.mergeProjects(mine, stored, t)
  for (const id of rt.deleted) delete merged.tasks[id]
  if (merged.activeTaskId !== undefined && merged.tasks[merged.activeTaskId] === undefined) delete merged.activeTaskId
  merged.writer = rt.session
  E.trimProject(merged, t, rt.prefs.retentionDays, 600_000)
  await $.store.set(rt.key, merged)
  rt.project = merged
}

function save($: EngineInterface): Promise<void> {
  rt.dirty = true
  rt.writing ??= (async () => {
    try {
      while (rt.dirty) {
        rt.dirty = false
        await writeOnce($)
      }
    } catch (err) {
      $.ui.log(`integrity: could not save state (${String(err)})`, { to: 'debug' })
    } finally {
      rt.writing = undefined
    }
  })()
  return rt.writing
}

async function refreshStatus($: EngineInterface): Promise<void> {
  const p = await ensure($)
  const line = rt.prefs.statusHint ? E.statusLine(E.summarize(E.activeTask(p), p.mode)) : undefined
  if (line === rt.lastStatus) return
  rt.lastStatus = line
  $.ui.status(line)
}

function showHints($: EngineInterface, hints: readonly E.Hint[]): void {
  for (const h of hints) {
    if (rt.prefs.notify === 'off' || (rt.prefs.notify === 'important' && h.level !== 'important')) continue
    $.ui.toast(h.text, { timeoutMs: 6000 })
  }
}

/** After any state change: redraw subscribers, refresh the status line, show hints, persist. */
async function changed($: EngineInterface, hints: readonly E.Hint[] = []): Promise<void> {
  await update($, rev, n => n + 1)
  await refreshStatus($)
  showHints($, hints)
  await save($)
}

/** Docked it asks Flightdeck's width beside the transcript; inline above the prompt, a short block. */
function openPane($: EngineInterface) {
  return $.ui.open({ id: PANE, title: 'Integrity', columns: 66, rows: 10 })
}

async function gitHead($: EngineInterface): Promise<string | undefined> {
  if (!rt.prefs.gitProvenance) return undefined
  const run = await $.process.run(['git', 'rev-parse', '--short', 'HEAD'], { timeoutMs: 3000 }).catch(() => undefined)
  if (run === undefined || run.exitCode !== 0) return undefined
  const dirty = await $.process.run(['git', 'status', '--porcelain', '--untracked-files=no'], { timeoutMs: 3000 }).catch(() => undefined)
  return `${run.stdout.trim()}${dirty !== undefined && dirty.stdout.trim() !== '' ? `+dirty:${E.hash(dirty.stdout).slice(0, 6)}` : ''}`
}

async function readText($: EngineInterface, path: string): Promise<string | undefined> {
  const text = await $.fs.read(path).catch(() => undefined)
  return typeof text === 'string' ? text : undefined
}

function filePath(e: { tool: string } & Record<string, unknown>): string | undefined {
  const path = e['file_path'] ?? e['notebook_path']
  return (e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'NotebookEdit' || e.tool === 'MultiEdit') && typeof path === 'string' ? path : undefined
}

// ---- Commands -------------------------------------------------------------------

function words(args: string): string[] {
  return args.trim().split(/\s+/).filter(Boolean)
}

async function requireTask($: EngineInterface): Promise<E.Task | string> {
  const task = E.activeTask(await ensure($))
  return task ?? 'No active task. Describe what you want built, or run `/integrity-start <task>`.'
}

function contractText(task: E.Task, mode: E.Mode): string {
  const c = task.contract
  const s = E.summarize(task, mode)
  const lines = [
    `**Contract** ${c.summary} · ${s.approval} v${c.version} · intent ${c.intent} · task \`${task.id}\``,
    `Prompt: "${c.prompt.excerpt}" (hash ${c.prompt.hash.slice(0, 10)})`,
    '',
    ...(c.requirements.length === 0 ? ['_No requirements yet: `/integrity-contract add <requirement>`_'] : c.requirements.map(r => {
      const st = E.requirementState(r, task)
      return `- **${r.id}** [${r.criticality}/${r.category}/${r.verification}${r.origin === 'proposed' ? '/proposed' : ''}] ${r.description}  \n  → ${st.state}: ${st.reason}${r.checks.length ? ` · checks: ${r.checks.join(', ')}` : ''}`
    })),
  ]
  if (c.exclusions.length) lines.push('', `Exclusions: ${c.exclusions.map(x => `\`${x}\``).join(', ')}`)
  if (c.scope.length) lines.push(`Scope: ${c.scope.map(x => `\`${x}\``).join(', ')}`)
  if (c.assumptions.length) lines.push(`Assumptions: ${c.assumptions.join('; ')}`)
  if (c.revisions.length) lines.push(`Revisions: ${c.revisions.slice(-5).map(r => `v${r.version} ${r.change}`).join(' · ')}`)
  lines.push('', s.approval === 'approved' ? 'Approved baseline kept; edits create revisions.' : 'Not approved yet: `/integrity-approve` when it reads right.')
  return lines.join('\n')
}

async function editContract($: EngineInterface, args: string): Promise<string> {
  const task = await requireTask($)
  if (typeof task === 'string') return task
  const p = rt.project as E.ProjectRecord
  const [verb = '', ...rest] = words(args)
  const t = await now($)
  const c = task.contract
  if (verb === '') return contractText(task, p.mode)
  const id = rest[0] ?? ''
  const text = rest.slice(1).join(' ')
  const req = E.findRequirement(c, id)
  const needReq = (): string | undefined => (req === undefined ? `No requirement "${id}". Requirements: ${c.requirements.map(r => r.id).join(', ') || 'none'}.` : undefined)
  let done: string
  switch (verb) {
    case 'add': {
      const description = rest.join(' ')
      if (description === '') return 'Usage: `/integrity-contract add <requirement>`'
      let added: E.Requirement | undefined
      E.amend(c, t, `added requirement: ${description}`, x => { added = E.makeRequirement(x.requirements, description); x.requirements.push(added) })
      done = `Added ${added?.id}.`
      break
    }
    case 'edit':
      if (needReq() || text === '') return needReq() ?? 'Usage: `/integrity-contract edit R2 <new text>`'
      E.amend(c, t, `${req!.id} reworded`, () => { req!.description = E.redact(text).slice(0, 300); if (req!.origin === 'proposed') req!.origin = 'manual' })
      done = `Updated ${req!.id}.`
      break
    case 'remove':
      if (needReq()) return needReq() as string
      E.amend(c, t, `${req!.id} removed: ${req!.description}`, x => { x.requirements = x.requirements.filter(r => r !== req) })
      done = `Removed ${req!.id}.`
      break
    case 'crit':
    case 'criticality':
      if (needReq() || !['must', 'should', 'optional'].includes(text)) return needReq() ?? 'Usage: `/integrity-contract crit R2 must|should|optional`'
      E.amend(c, t, `${req!.id} criticality ${req!.criticality} → ${text}`, () => { req!.criticality = text as E.Criticality })
      done = `${req!.id} is now ${text}.`
      break
    case 'category':
      if (needReq() || !['functional', 'constraint', 'non-functional', 'test', 'preservation'].includes(text)) return needReq() ?? 'Usage: `/integrity-contract category R2 functional|constraint|non-functional|test|preservation`'
      E.amend(c, t, `${req!.id} category → ${text}`, () => { req!.category = text as E.RequirementCategory })
      done = `${req!.id} category is now ${text}.`
      break
    case 'verify-by':
      if (needReq() || !['static', 'test', 'runtime', 'manual', 'unknown'].includes(text)) return needReq() ?? 'Usage: `/integrity-contract verify-by R2 static|test|runtime|manual`'
      E.amend(c, t, `${req!.id} verification → ${text}`, () => { req!.verification = text as E.VerificationKind })
      done = `${req!.id} is verified by ${text} evidence.`
      break
    case 'check':
      if (needReq() || text === '') return needReq() ?? 'Usage: `/integrity-contract check R2 <command substring, e.g. npm test -- events>`'
      E.amend(c, t, `${req!.id} check: ${text}`, () => { req!.checks = [...new Set([...req!.checks, text])] })
      done = `${req!.id} is verified by a passing run of a command containing "${text}".`
      break
    case 'implemented':
      if (needReq()) return needReq() as string
      E.amend(c, t, `${req!.id} marked implemented by the developer`, () => { req!.implemented = true }, false)
      done = `${req!.id} marked implemented (not verified: that still needs evidence).`
      break
    case 'exclude':
    case 'scope':
    case 'assume': {
      const value = rest.join(' ')
      if (value === '') return `Usage: \`/integrity-contract ${verb} <${verb === 'assume' ? 'text' : 'glob, e.g. app/legacy/**'}>\``
      const list = verb === 'exclude' ? 'exclusions' : verb === 'scope' ? 'scope' : 'assumptions'
      E.amend(c, t, `${verb}: ${value}`, x => { x[list] = [...new Set([...x[list], E.redact(value)])] }, verb !== 'assume')
      done = `Added to ${list}: ${value}`
      break
    }
    case 'intent':
      if (!['production', 'prototype', 'unknown'].includes(id)) return 'Usage: `/integrity-contract intent production|prototype|unknown`'
      E.amend(c, t, `intent ${c.intent} → ${id}`, x => { x.intent = id as E.ContractIntent })
      done = `Intent is now ${id}. Mirage rules read mock data as ${id === 'prototype' ? 'expected' : 'suspicious'}.`
      break
    case 'summary':
      if (rest.length === 0) return 'Usage: `/integrity-contract summary <one line>`'
      E.amend(c, t, 'summary changed', x => { x.summary = E.redact(rest.join(' ')).slice(0, 140) }, false)
      done = 'Summary updated.'
      break
    default:
      return `Unknown contract action "${verb}". Try: add, edit, remove, crit, category, verify-by, check, implemented, exclude, scope, assume, intent, summary.`
  }
  E.log(task, 'contract', done, t)
  await changed($)
  const note = c.baseline !== undefined && c.approval.status !== 'approved' ? ' Contract amended to v' + c.version + ': re-approve with `/integrity-approve`.' : ''
  return done + note
}

async function findingsText($: EngineInterface, args: string): Promise<string> {
  const task = await requireTask($)
  if (typeof task === 'string') return task
  const [verb = '', id = ''] = words(args)
  if (verb === 'ack' || verb === 'reopen') {
    const f = E.setFindingStatus(task, id, verb === 'ack' ? 'acknowledged' : 'open', await now($))
    if (f === undefined) return `No finding "${id}".`
    await changed($)
    return `${f.ruleId} ${f.file}:${f.line} ${verb === 'ack' ? 'acknowledged' : 'reopened'}.`
  }
  const order: Record<E.Severity, number> = { high: 0, medium: 1, low: 2, info: 3 }
  const list = task.findings
    .filter(f => verb === 'all' || f.status === 'open')
    .sort((a, b) => order[a.severity] - order[b.severity])
  if (list.length === 0) return verb === 'all' ? 'No findings recorded.' : 'No open findings. `/integrity-findings all` lists resolved, waived and acknowledged ones.'
  return list.slice(0, 40).map(f =>
    `- \`${f.id.slice(0, 8)}\` **${f.severity}/${f.confidence}** ${f.ruleId} \`${f.file}:${f.line}\` (${f.status}): ${f.explanation}\n  Verify: ${f.verify}`,
  ).join('\n') + (list.length > 40 ? `\n…and ${list.length - 40} more` : '')
}

async function evidenceText($: EngineInterface, args: string): Promise<string> {
  const task = await requireTask($)
  if (typeof task === 'string') return task
  const [verb = '', eid = '', rid = ''] = words(args)
  if (verb === 'link') {
    const ev = task.evidence.find(x => x.id.toLowerCase() === eid.toLowerCase())
    const req = E.findRequirement(task.contract, rid)
    if (ev === undefined || req === undefined) return 'Usage: `/integrity-evidence link E4 R2` (both must exist).'
    req.evidenceIds = [...new Set([...req.evidenceIds, ev.id])]
    E.log(task, 'requirement', `${ev.id} linked to ${req.id} by the developer`, await now($))
    await changed($)
    return `${ev.id} linked to ${req.id}: now ${E.requirementState(req, task).state}.`
  }
  if (task.evidence.length === 0) return 'No checks observed yet. Test, build, lint and typecheck runs Claude makes are recorded automatically.'
  return task.evidence.slice(-30).map(ev => {
    const fresh = E.freshness(ev, task)
    const why = fresh === 'stale' ? ` (stale: ${E.staleBecause(ev, task).slice(0, 3).join(', ')} changed)` : ''
    return `- **${ev.id}** ${ev.check} ${ev.outcome} · ${fresh}${why} · ${ev.command ? `\`${ev.command}\`` : ev.source} · ${ev.basis}${ev.revision ? ` @ ${ev.revision}` : ''}`
  }).join('\n')
}

async function check($: EngineInterface): Promise<{ text: string; exitCode?: number }> {
  const task = await requireTask($)
  if (typeof task === 'string') return { text: task }
  const p = rt.project as E.ProjectRecord
  const current: Record<string, string | null> = {}
  for (const path of Object.keys(task.files).slice(0, 200)) {
    const abs = /^([A-Za-z]:)?[\\/]/.test(path) ? path : `${rt.root.replace(/[\\/]$/, '')}/${path}`
    current[path] = (await $.fs.exists(abs).catch(() => false)) ? (await readText($, abs)) ?? null : null
  }
  const t = await now($)
  const hints = E.reconcileFiles(task, current, t)
  // Re-scan with the current contract (intent or wording may have changed since).
  for (const [path, text] of Object.entries(current)) {
    if (text !== null && /\.(c|m)?(t|j)sx?$/i.test(path)) {
      const asked = [task.contract.summary, task.contract.prompt.excerpt, ...task.contract.requirements.map(r => r.description)].join(' ')
      hints.push(...E.applyFindings(task, path, 'mirage', E.scanSource(path, text, task.contract.intent, asked), t))
    }
  }
  const violations = E.policyViolations(task)
  E.log(task, 'evidence', `re-check: ${Object.keys(current).length} tracked file(s), ${violations.length} policy violation(s)`, t)
  await changed($, hints)
  const s = E.summarize(task, p.mode)
  const lines = [
    E.statusLine(s, 200) ?? 'Integrity: no status',
    `Re-read ${Object.keys(current).length} tracked file(s); ${hints.length} new hint(s).`,
    ...(violations.length ? ['', `**Policy (${p.mode}):**`, ...violations.map(v => `- ✗ ${v.text}`)] : ['Policies: none violated.']),
  ]
  return { text: lines.join('\n'), ...(p.mode === 'strict' && violations.length > 0 ? { exitCode: 1 } : {}) }
}

async function exportReport($: EngineInterface, format: 'md' | 'json' | 'both'): Promise<string> {
  const task = await requireTask($)
  if (typeof task === 'string') return task
  const p = rt.project as E.ProjectRecord
  const t = await now($)
  const dir = `${rt.root.replace(/[\\/]$/, '')}/.claude/integrity`
  const written: string[] = []
  if (format !== 'json') {
    await $.fs.write(`${dir}/${task.id}.md`, E.toMarkdown(task, p.mode, p.label, t))
    written.push(`.claude/integrity/${task.id}.md`)
  }
  if (format !== 'md') {
    await $.fs.write(`${dir}/${task.id}.json`, JSON.stringify(E.toJson(task, p.mode, p.label, t), null, 2))
    written.push(`.claude/integrity/${task.id}.json`)
  }
  E.log(task, 'task', `report exported: ${written.join(', ')}`, t)
  await changed($)
  return `Exported ${written.join(' and ')}.`
}

async function suggest($: EngineInterface): Promise<string> {
  const task = await requireTask($)
  if (typeof task === 'string') return task
  if (!rt.prefs.aiAssist) {
    return 'AI suggestions are off. Turn on "AI requirement suggestions" for integrity in /config, then run `/integrity-suggest` again. Each run makes one model call (about 1-2k tokens) on this session\'s own model provider; nothing goes to any other service.'
  }
  const c = task.contract
  const source = rt.lastPrompt !== undefined && E.hash(rt.lastPrompt) === c.prompt.hash ? rt.lastPrompt : c.prompt.excerpt
  const cacheKey = E.hash(source)
  let lines = rt.suggested.get(cacheKey)
  let cost = 'cached, no model call'
  if (lines === undefined) {
    const r = await $.model.complete({
      model: 'haiku',
      system: 'You list testable software requirements. Output 3 to 7 lines, each starting with "- ". No commentary. Do not invent features the request does not imply.',
      prompt: `Developer request (secrets redacted):\n${E.redact(source).slice(0, 4000)}\n\nAlready recorded:\n${c.requirements.map(r => `- ${r.description}`).join('\n') || '(none)'}\n\nList missing acceptance criteria.`,
      maxTokens: 500,
      effort: 'low',
      timeoutMs: 30_000,
    })
    if (!r.isAnswered) return `No suggestions: the model call ended with ${r.reason}. Nothing was changed.`
    lines = r.text.split('\n').map(l => l.replace(/^\s*[-*•]\s*/, '').trim()).filter(l => l.length > 8).slice(0, 7)
    rt.suggested.set(cacheKey, lines)
    cost = `${r.usage.input_tokens} input + ${r.usage.output_tokens} output tokens`
  }
  if (lines.length === 0) return 'The model proposed nothing new.'
  const t = await now($)
  E.amend(c, t, `${lines.length} proposed requirement(s) added (model suggestion)`, x => {
    for (const l of lines!) x.requirements.push(E.makeRequirement(x.requirements, l, { origin: 'proposed', criticality: 'should' }))
  })
  E.log(task, 'contract', `${lines.length} model-proposed requirement(s) added; awaiting approval`, t)
  await changed($)
  return `Added ${lines.length} **proposed** requirement(s) (${cost}). They count only once you approve the contract; remove any with \`/integrity-contract remove R#\`.\n\n${lines.map(l => `- ${l}`).join('\n')}`
}

async function savePrefs($: EngineInterface, change: Partial<Prefs>): Promise<void> {
  rt.storedPrefs = { ...rt.storedPrefs, ...change }
  await $.store.set('prefs', rt.storedPrefs)
  rt.prefs = prefsFrom(rt.options, rt.storedPrefs)
  rt.lastStatus = '\u0000'
  await changed($)
}

async function run($: EngineInterface, command: string, args: string, presentation: { isFullscreen: boolean }): Promise<{ text: string; exitCode?: number }> {
  const p = await ensure($)
  const t = await now($)
  switch (command) {
    case 'integrity': {
      const [sub = '', ...rest] = words(args)
      if (sub !== '' && COMMANDS.some(c => c.name === `integrity-${sub}`)) return run($, `integrity-${sub}`, rest.join(' '), presentation)
      if (sub === 'status' || sub === 'claims' || sub === '' || ['overview', 'requirements', 'evidence', 'findings', 'activity', 'report'].includes(sub)) {
        const tab = (['overview', 'requirements', 'evidence', 'findings', 'claims', 'activity', 'report'].includes(sub) ? sub : 'overview') as E.Tab
        if (sub !== 'status') {
          await update($, uiState, u => ({ ...u, tab, page: 0 }))
          void openPane($)
        }
        const s = E.summarize(E.activeTask(p), p.mode)
        if (!s.hasTask) return { text: 'Claude Integrity: no task contract yet. Describe what you want built, or `/integrity-start <task>`. `/integrity-help` explains.' }
        const claims = s.claims.latest.map(c => `- ${E.GLYPH[c.verdict]} ${c.verdict}: "${c.text}" (${c.reason})`)
        return { text: [E.statusLine(s, 200), s.concern ? `Top concern: ${s.concern.text}` : 'No outstanding concern.', ...(sub === 'claims' ? ['', ...claims] : [])].join('\n') }
      }
      return { text: `Unknown subcommand "${sub}". \`/integrity-help\` lists them.` }
    }
    case 'integrity-start': {
      const text = args.trim() !== '' ? args : rt.lastPrompt ?? ''
      if (text === '') return { text: 'Usage: `/integrity-start <what you want built>` (or run it right after describing the task).' }
      const old = E.activeTask(p)
      const task = E.startTask(p, text, args.trim() !== '' ? 'manual' : 'prompt', t)
      if (old) E.log(task, 'task', `previous task ${old.id} kept in history`, t)
      await changed($)
      return { text: `Started task \`${task.id}\`.\n\n${contractText(task, p.mode)}` }
    }
    case 'integrity-contract':
      return { text: await editContract($, args) }
    case 'integrity-approve': {
      const task = await requireTask($)
      if (typeof task === 'string') return { text: task }
      if (task.contract.approval.status === 'approved') return { text: `Already approved (v${task.contract.version}).` }
      if (task.contract.requirements.length === 0) return { text: 'Nothing to approve: add at least one requirement (`/integrity-contract add ...`).' }
      const first = task.contract.baseline === undefined
      E.approve(task.contract, t)
      E.log(task, 'approval', `contract ${first ? 'approved as baseline' : 're-approved'} at v${task.contract.version}`, t)
      await changed($)
      const proposed = task.contract.requirements.filter(r => r.origin === 'proposed').length
      return { text: `Contract ${first ? 'approved: baseline frozen' : 're-approved'} at v${task.contract.version} (${task.contract.requirements.length} requirements${proposed ? `, ${proposed} model-proposed` : ''}).` }
    }
    case 'integrity-check':
      return check($)
    case 'integrity-findings':
      return { text: await findingsText($, args) }
    case 'integrity-evidence':
      return { text: await evidenceText($, args) }
    case 'integrity-verify': {
      const task = await requireTask($)
      if (typeof task === 'string') return { text: task }
      const [id = '', ...note] = words(args)
      const req = E.findRequirement(task.contract, id)
      if (req === undefined || note.length === 0) return { text: 'Usage: `/integrity-verify R3 <what you checked, e.g. "submitted the form and reloaded: saved">`' }
      const ev = E.recordManual(task, req.id, note.join(' '), t)
      await changed($)
      return { text: `${ev.id}: your confirmation of ${req.id} recorded (${E.requirementState(req, task).state}). It goes stale if related code changes later.` }
    }
    case 'integrity-report': {
      const task = await requireTask($)
      if (typeof task === 'string') return { text: task }
      const w = words(args)
      const format = w.includes('json') ? 'json' : w.includes('md') ? 'md' : 'both'
      if (w.includes('export')) return { text: await exportReport($, format) }
      return { text: format === 'json' ? '```json\n' + JSON.stringify(E.toJson(task, p.mode, p.label, t), null, 2).slice(0, 60_000) + '\n```' : E.toMarkdown(task, p.mode, p.label, t) }
    }
    case 'integrity-mode': {
      const mode = words(args)[0]
      if (mode === undefined) return { text: `Mode: **${p.mode}**. Options: observe (default, never blocks), review (summary after answers), strict (refuses edits to excluded paths; /integrity-check exits 1 on violations).` }
      if (mode !== 'observe' && mode !== 'review' && mode !== 'strict') return { text: 'Usage: `/integrity-mode observe|review|strict`' }
      p.mode = mode
      const task = E.activeTask(p)
      if (task) E.log(task, 'mode', `mode → ${mode}`, t)
      await changed($)
      const strictNote = mode === 'strict' && (task?.contract.baseline === undefined) ? ' Strict policies apply once a contract is approved.' : ''
      return { text: `Mode set to **${mode}** for this project.${strictNote}` }
    }
    case 'integrity-waive': {
      const task = await requireTask($)
      if (typeof task === 'string') return { text: task }
      const [id = '', ...reason] = words(args)
      if (id === '' || reason.length === 0) return { text: 'Usage: `/integrity-waive <finding-id|R#> <reason>`. A reason is required.' }
      const req = E.findRequirement(task.contract, id)
      if (req !== undefined) {
        E.amend(task.contract, t, `${req.id} waived: ${reason.join(' ')}`, () => { req.waiver = { reason: E.redact(reason.join(' ')), at: t } }, false)
        E.log(task, 'waiver', `${req.id} waived: ${reason.join(' ')}`, t)
        await changed($)
        return { text: `${req.id} waived: ${reason.join(' ')}` }
      }
      const f = E.setFindingStatus(task, id, 'waived', t, reason.join(' '))
      if (f === undefined) return { text: `No finding or requirement "${id}". \`/integrity-findings\` lists ids.` }
      await changed($)
      return { text: `Waived ${f.ruleId} at ${f.file}:${f.line}: ${reason.join(' ')}. The same finding stays waived on later scans.` }
    }
    case 'integrity-reset': {
      const w = words(args)
      const all = w.includes('all')
      const task = E.activeTask(p)
      if (!all && task === undefined) return { text: 'No active task to reset.' }
      const what = all ? `all Integrity data for this project (${Object.keys(p.tasks).length} task(s))` : `task \`${task!.id}\` (${task!.contract.summary})`
      let confirmed = w.includes('confirm')
      if (!confirmed) {
        const answer = await $.ui.ask(`Delete ${what}? This cannot be undone.`, ['Delete', 'Keep']).catch(() => undefined)
        if (answer === undefined) return { text: `This deletes ${what}. Run \`/integrity-reset ${all ? 'all ' : ''}confirm\` to proceed.` }
        confirmed = answer === 'Delete'
      }
      if (!confirmed) return { text: 'Kept. Nothing was deleted.' }
      const ids = all ? Object.keys(p.tasks) : [task!.id]
      for (const id of ids) { rt.deleted.add(id); delete p.tasks[id] }
      delete p.activeTaskId
      await changed($)
      if (all) { await $.store.delete(rt.key); rt.project = E.newProject(rt.key, p.label, rt.session, t); rt.deleted.clear() }
      return { text: `Deleted ${what}.` }
    }
    case 'integrity-ui': {
      const w = words(args)
      if (w.length === 0) return { text: `Status hint ${rt.prefs.statusHint ? 'on' : 'off'} · pane auto-open ${rt.prefs.paneAutoOpen ? 'on' : 'off'} · notify ${rt.prefs.notify} · color ${rt.prefs.color ? 'on' : 'off'} · max findings ${rt.prefs.maxFindings} · layout ${rt.prefs.layout}` }
      const change: Partial<Prefs> = {}
      for (let i = 0; i < w.length; i += 2) {
        const [k, v] = [w[i], w[i + 1]]
        if (k === 'status') change.statusHint = v === 'on'
        else if (k === 'autoopen') change.paneAutoOpen = v === 'on'
        else if (k === 'color') change.color = v === 'on'
        else if (k === 'notify' && (v === 'off' || v === 'important' || v === 'all')) change.notify = v
        else if (k === 'max' && Number(v) > 0) change.maxFindings = Number(v)
        else if (k === 'pane' && v === 'open') void openPane($)
        else if (k === 'pane' && v === 'close') await $.ui.close({ id: PANE }).catch(() => undefined)
        else return { text: `Unknown setting "${k} ${v ?? ''}". \`/integrity-ui\` with no arguments shows the current ones.` }
      }
      if (Object.keys(change).length > 0) await savePrefs($, change)
      return { text: `Saved: ${Object.entries(change).map(([k, v]) => `${k}=${v}`).join(', ') || 'pane toggled'}.` }
    }
    case 'integrity-layout': {
      const l = words(args)[0]
      if (l !== 'auto' && l !== 'mini' && l !== 'compact' && l !== 'wide') return { text: `Layout: ${rt.prefs.layout}. Usage: \`/integrity-layout auto|mini|compact|wide\`` }
      await savePrefs($, { layout: l })
      return { text: `Layout set to ${l}.` }
    }
    case 'integrity-suggest':
      return { text: await suggest($) }
    case 'integrity-help':
      return { text: HELP }
  }
  return { text: `Unknown command ${command}` }
}

// ---- The pane -----------------------------------------------------------------

function actions($: EngineInterface): PaneActions {
  return {
    setUi: fn => update($, uiState, fn),
    approve: async () => (await run($, 'integrity-approve', '', { isFullscreen: false })).text,
    recheck: async () => (await check($)).text.split('\n')[1] ?? 'Re-checked.',
    exportReport: format => exportReport($, format),
    setFinding: async (id, status, reason) => {
      const task = E.activeTask(await ensure($))
      if (task === undefined) return 'No active task.'
      const f = E.setFindingStatus(task, id, status, await now($), reason)
      await changed($)
      return f ? `${f.ruleId} ${status}.` : 'Finding not found.'
    },
    waiveRequirement: async (id, reason) => (await run($, 'integrity-waive', `${id} ${reason}`, { isFullscreen: false })).text,
    close: () => $.ui.close({ id: PANE }),
  }
}

export const register: Register = (on, options) => {
  rt = freshRuntime(options)

  // ---- lifecycle -------------------------------------------------------------

  on('session.start', async ($, e, next) => {
    await Promise.all(COMMANDS.map(c => $.command.register(c)))
    await Promise.all(SHORTCUTS.map(({ to: _, ...c }) => $.command.register(c)))
    await ensure($)
    await refreshStatus($)
    if (rt.prefs.paneAutoOpen && e.isInteractive && E.activeTask(rt.project as E.ProjectRecord) !== undefined) {
      void openPane($)
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (rt.dirty || rt.writing !== undefined) await save($)
    return next(e)
  })

  // ---- Intent Fingerprint: capture --------------------------------------------

  on('prompt.submit', async ($, e, next) => {
    const human = e.origin.kind === 'composer' || e.origin.kind === 'bridge' || e.origin.kind === 'sdk'
    if (human && !e.text.trim().startsWith('/')) {
      rt.lastPrompt = e.text
      const p = await ensure($)
      if (rt.prefs.autoCapture && E.activeTask(p) === undefined && E.isMeaningfulTask(e.text)) {
        const task = E.startTask(p, e.text, 'prompt', await now($))
        await changed($, rt.prefs.notify === 'all' ? [{ key: `draft:${task.id}`, level: 'info', text: `Integrity: drafted a contract (${task.contract.requirements.length} explicit requirement(s)) · /integrity-contract` }] : [])
      }
    }
    return next(e)
  })

  // ---- The Witness: observe tool calls ----------------------------------------

  on('tool.call', async ($, e, next) => {
    const args = e as unknown as { tool: string } & Record<string, unknown>
    const p = await ensure($)
    const task = E.activeTask(p)
    const target = filePath(args)
    if (task !== undefined && target !== undefined) {
      const glob = E.deniedPath(task, p.mode, rel(target))
      if (glob !== undefined) {
        E.log(task, 'finding', `strict: refused ${args.tool} of ${rel(target)} (excluded by "${glob}")`, await now($))
        await changed($)
        return { deny: `Claude Integrity (strict mode): ${rel(target)} is excluded by the approved contract ("${glob}"). Amend the contract (/integrity-contract) or change mode (/integrity-mode) to edit it.` }
      }
    }

    const res = await next(e)
    if (task === undefined) return res
    try {
      const t = await now($)
      const ranInCore = res.ref !== undefined
      const result = res.result as Record<string, unknown> | undefined
      const hints: E.Hint[] = []

      if (target !== undefined) {
        // A refused, failed, staged or plugin-answered write changed nothing core can vouch for.
        if (res.deny === undefined && res.isError !== true && ranInCore && result?.['staged'] !== true) {
          const path = rel(target)
          const after = args.tool === 'Write' && typeof args['content'] === 'string' ? args['content'] : await readText($, target)
          const before = typeof result?.['originalFile'] === 'string' ? (result['originalFile'] as string) : result?.['originalFile'] === null ? null : undefined
          const kind = args.tool === 'Write' && result?.['type'] === 'create' ? 'create' : 'update'
          hints.push(...E.recordChange(task, { path, kind, ...(after === undefined ? {} : { after }), ...(before === undefined ? {} : { before }) }, t))
        }
      } else if (args.tool === 'Bash' || /^mcp__.*(playwright|chrome|browser|puppeteer)/i.test(args.tool)) {
        // File changes a shell command made come first: a check in the same line ran after them.
        const diff = result?.['bashEditDiff'] as { files?: { filePath: string; created?: true; deleted?: true }[] } | undefined
        for (const f of (ranInCore ? diff?.files ?? [] : []).slice(0, 30)) {
          const after = f.deleted ? undefined : await readText($, f.filePath)
          hints.push(...E.recordChange(task, { path: rel(f.filePath), kind: f.deleted ? 'delete' : f.created ? 'create' : 'update', ...(after === undefined ? {} : { after }) }, t))
        }
        const obs: E.ToolObservation = {
          tool: args.tool, input: args, ranInCore, isError: res.isError === true, text: res.text ?? '', result: res.result,
          ...(res.deny === undefined ? {} : { denied: res.deny }),
          ...(e.agentId === undefined ? {} : { agentId: e.agentId }),
          cwd: await $.session.cwd().catch(() => rt.root),
        }
        const recorded = E.recordTool(task, obs, t)
        if (recorded.evidence.length > 0) {
          const head = ranInCore ? await gitHead($) : undefined
          if (head !== undefined) for (const ev of recorded.evidence) ev.revision = head
        }
        hints.push(...recorded.hints)
        if (recorded.evidence.length === 0 && hints.length === 0 && (diff?.files ?? []).length === 0) return res
      } else return res
      await changed($, hints)
    } catch (err) {
      $.ui.log(`integrity: could not record ${args.tool} (${String(err)})`, { to: 'debug' })
    }
    return res
  })

  // ---- Completion Claim Auditor -------------------------------------------------

  on('turn.complete', async ($, e, next) => {
    const res = await next(e)
    if (e.agentId !== undefined) return res
    const p = await ensure($)
    const task = E.activeTask(p)
    if (task === undefined) return res
    const t = await now($)
    if (e.reason === 'aborted' || e.isAborted) {
      E.log(task, 'turn', 'turn interrupted: its claims were not audited', t)
      await changed($)
      return res
    }
    if (e.reason !== 'answer') return res
    const { notice } = E.recordAudit(task, e.answer, e.turnId, t, p.mode, rt.prefs.notify)
    await changed($)
    if (p.mode === 'review' && notice !== undefined) void openPane($)
    if (notice === undefined) return res
    // Another plugin's line beneath the answer stays; ours follows it. The answer itself is never rewritten.
    const theirs = res.text !== e.answer ? `${res.text}\n` : ''
    return { ...res, text: `${theirs}${notice}` }
  })

  // ---- Commands and pane ---------------------------------------------------------

  on('command.run', { command: [...COMMANDS, ...SHORTCUTS].map(c => c.name) }, async ($, e) => run($, ALIASES[e.command] ?? e.command, e.args, e.presentation))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    await read($, rev)
    const ui = await read($, uiState)
    const p = await ensure($)
    const view = { surface: e.surface, bodyColumns: e.props.bodyColumns, columns: e.viewport?.columns, placement: e.props.placement }
    return renderPane($.ui.resolve(e), view, { project: p, task: E.activeTask(p), prefs: rt.prefs, ui, actions: actions($) })
  })
}
