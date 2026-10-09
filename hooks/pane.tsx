// The /integrity pane, drawn the way Claude Flightdeck draws its own: a centered
// title over a color legend, rounded cards per subsystem (title left, count
// right), a strip of requirement states, and an activity log. Everything comes
// from the engine's canonical summary, so its counts always match
// /integrity-report. Keys 1-7 switch views while the pane holds the keyboard;
// every action is also a command for headless use.

import type { ElementTable, RenderElement, ThemeKey } from 'claude-code'

import type { IntegrityTab, IntegrityUi } from '../types'
import * as E from '../src/engine/index'

export type PaneActions = {
  setUi: (fn: (u: IntegrityUi) => IntegrityUi) => Promise<unknown>
  approve: () => Promise<string>
  recheck: () => Promise<string>
  exportReport: (format: 'md' | 'json' | 'both') => Promise<string>
  setFinding: (id: string, status: 'acknowledged' | 'waived' | 'open', reason?: string) => Promise<string>
  waiveRequirement: (id: string, reason: string) => Promise<string>
  close: () => Promise<void>
}

type Prefs = { layout: E.Layout; maxFindings: number; color: boolean }

export type PaneContext = {
  project: E.ProjectRecord
  task: E.Task | undefined
  prefs: Prefs
  ui: IntegrityUi
  actions: PaneActions
}

const TABS: readonly [IntegrityTab, string, string][] = [
  ['overview', 'Overview', 'Ovw'], ['requirements', 'Requirements', 'Reqs'], ['evidence', 'Evidence', 'Evid'],
  ['findings', 'Findings', 'Find'], ['claims', 'Claims', 'Clms'], ['activity', 'Activity', 'Log'], ['report', 'Report', 'Rpt'],
]

// Theme keys, like Flightdeck's default palette: they follow light, dark and color-blind themes.
const C = {
  main: 'claude', ok: 'success', evidence: 'suggestion', warn: 'warning', bad: 'error', claims: 'merged', dim: 'inactive', faint: 'subtle',
} as const satisfies Record<string, ThemeKey>

type ReqState = Exclude<keyof E.Summary['requirements'], 'total'>
const REQ_GLYPH: Record<ReqState, string> = { verified: '✓', stale: '⧗', failed: '✗', waived: '–', implemented: '◐', unverified: '?' }
const REQ_COLOR: Record<ReqState, ThemeKey> = { verified: C.ok, implemented: C.evidence, unverified: C.dim, stale: C.warn, failed: C.bad, waived: C.faint }
const REQ_LABEL: Record<ReqState, string> = {
  verified: 'Verified', stale: 'Stale', failed: 'Failed', waived: 'Waived', implemented: 'Implemented, not verified', unverified: 'Not verified',
}
const LEGEND: readonly ReqState[] = ['verified', 'implemented', 'unverified', 'stale', 'failed']
const SEV_GLYPH: Record<E.Severity, string> = { high: '‼', medium: '!', low: '·', info: '○' }
const KIND_COLOR: Record<E.Activity['kind'], ThemeKey> = {
  task: C.main, contract: C.main, approval: C.main, requirement: C.main, mode: C.main, evidence: C.evidence,
  invalidated: C.warn, finding: C.warn, resolved: C.ok, waiver: C.dim, claims: C.claims, turn: 'text',
}

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`)
const time = (at: number): string => new Date(at).toTimeString().slice(0, 5)
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
/** Flightdeck's gauge: ▰ filled, ▱ empty. */
const gauge = (ratio: number, cells: number): { on: string; off: string } => {
  const n = Math.max(0, Math.min(cells, Math.round(ratio * cells)))
  return { on: '▰'.repeat(n), off: '▱'.repeat(cells - n) }
}

/** Inline above the prompt the pane is a short summary, as Flightdeck's mini; docked it follows the width. */
export function layoutFor(columns: number, pref: E.Layout, placement: 'dock' | 'inline' = 'dock'): Exclude<E.Layout, 'auto'> {
  if (pref !== 'auto') return pref
  if (placement === 'inline') return 'mini'
  return columns < 56 ? 'mini' : columns < 110 ? 'compact' : 'wide'
}

/** What the pane is drawn into: the Pane site's body width and placement, and the viewport's width when measured. */
export type PaneView = {
  surface: 'terminal' | 'desktop' | 'mobile' | 'vscode'
  bodyColumns: number
  columns?: number | undefined
  placement?: 'dock' | 'inline' | undefined
}

export function renderPane(els: ElementTable, view: PaneView, ctx: PaneContext): RenderElement {
  const { Box, Text, Button } = els
  // The mobile app draws no field yet: waivers there go through the command.
  const Input = view.surface !== 'mobile' && 'Input' in els ? els.Input : undefined
  const { task, prefs, ui, actions, project } = ctx
  const W = Math.max(24, view.bodyColumns || view.columns || 80)
  const layout = layoutFor(W, prefs.layout, view.placement)
  const isMini = layout === 'mini'
  // Color supplements the glyphs and words, never replaces them, so it can be switched off.
  const fg = (c: ThemeKey): { color?: ThemeKey } => (prefs.color ? { color: c } : {})
  const faint = prefs.color ? { color: C.faint } : { dimColor: true }
  const s = E.summarize(task, project.mode)

  const go = (tab: IntegrityTab, selected?: string) => (): void => {
    void actions.setUi(u => ({ tab, page: 0, ...(selected === undefined ? {} : { selected: u.selected === selected && u.tab === tab ? undefined : selected }) }))
  }
  const flash = (p: Promise<string>): void => {
    void p.then(msg => actions.setUi(u => ({ ...u, flash: msg, waiving: undefined })))
  }

  /** A card: a rounded border in the section's color, its title left and a count right. Mini drops the border. */
  const card = (key: string, color: ThemeKey, title: string, right: string, w: number, body: (RenderElement | null | false)[], double = false): RenderElement =>
    isMini ? (
      <Box key={key} flexDirection="column" width={w}>
        <Text key={`${key}:title`} wrap="truncate-end">
          <Text bold {...fg(color)}>{title}</Text>
          {right !== '' ? <Text dimColor>{`  ${right}`}</Text> : null}
        </Text>
        {body}
      </Box>
    ) : (
      <Box key={key} flexDirection="column" borderStyle={double ? 'double' : 'round'} {...(prefs.color ? { borderColor: color } : {})} paddingX={1} width={w}>
        <Box key={`${key}:title`} justifyContent="space-between">
          <Text bold wrap="truncate-end" {...fg(color)}>{title}</Text>
          {right !== '' ? <Text dimColor>{right}</Text> : null}
        </Box>
        {body}
      </Box>
    )
  /** Inside a card's border and padding. */
  const inner = (w: number): number => (isMini ? w : w - 4)
  const rail = (key: string, w: number): RenderElement => <Text key={key} {...faint}>{'─'.repeat(Math.max(1, w))}</Text>

  const tabBar = (
    <Box key="tabs" flexDirection="row" flexWrap="wrap" columnGap={1} {...(isMini ? {} : { justifyContent: 'center' as const })}>
      {TABS.map(([id, long, short], i) => (
        <Button key={`tab:${id}`} plain hotkey={String(i + 1)} label={layout === 'wide' ? long : short}
          variant={ui.tab === id ? 'primary' : 'secondary'} dimColor={ui.tab !== id} onPress={go(id)} />
      ))}
    </Box>
  )

  if (!s.hasTask || task === undefined) {
    return (
      <Box flexDirection="column" width={W}>
        {!isMini && (
          <Box key="head" justifyContent="center">
            <Text bold wrap="truncate-end">INTEGRITY<Text {...faint}> · </Text><Text dimColor>NO CONTRACT</Text></Text>
          </Box>
        )}
        {card('c-empty', C.faint, 'CONTRACT · none yet', '', W, [
          <Text key="none" dimColor wrap="wrap">◇ No task contract. Nothing is tracked as verified yet.</Text>,
          <Text key="how" wrap="wrap">Describe what you want built (an implementation prompt drafts a contract, no model call), or run /integrity-start &lt;task&gt;.</Text>,
          <Text key="help" dimColor wrap="wrap">/integrity-help explains the workflow · /ig is short for /integrity</Text>,
        ])}
      </Box>
    )
  }

  const inForce = s.requirements.total - s.requirements.waived
  const approval = s.approval === 'approved' ? `approved v${s.version}` : s.approval === 'amended' ? 'amended · re-approve' : `draft v${s.version}`

  // ---- header: Flightdeck's centered title and legend ------------------------------------

  const legend = (() => {
    const out: ReqState[] = []
    let used = 0
    for (const st of LEGEND) {
      const cell = st.length + 4
      if (used + cell > W) break
      out.push(st)
      used += cell
    }
    return out
  })()
  const header = isMini ? null : (
    <Box key="header" flexDirection="column">
      <Box key="head" justifyContent="center">
        <Text bold wrap="truncate-end">
          <Text>INTEGRITY</Text>
          <Text {...faint}> · </Text>
          <Text {...fg(C.main)}>{s.mode.toUpperCase()}</Text>
          <Text> MODE</Text>
          <Text {...faint}> · </Text>
          <Text {...fg(s.approval === 'approved' ? C.ok : C.warn)}>{approval.toUpperCase()}</Text>
        </Text>
      </Box>
      <Box key="legend" justifyContent="center" columnGap={2}>
        {legend.map(st => (
          <Text key={`lg:${st}`}>
            <Text {...fg(REQ_COLOR[st])}>{prefs.color ? '■' : REQ_GLYPH[st]}</Text>
            <Text dimColor>{` ${st}`}</Text>
          </Text>
        ))}
      </Box>
    </Box>
  )
  const footer = ui.flash ? <Text key="flash" dimColor wrap="truncate-end">{ui.flash}</Text> : null

  // ---- overview pieces --------------------------------------------------------------------

  /** One cell per requirement, colored by state (its glyph when color is off), like Flightdeck's gate strip. */
  const strip = (w: number): RenderElement => {
    const reqs = task.contract.requirements
    const shown = reqs.slice(0, Math.max(4, w - 10))
    return (
      <Text key="strip" wrap="truncate-end">
        <Text dimColor>reqs </Text>
        {shown.map(r => {
          const st = E.requirementState(r, task).state
          return <Text key={`st:${r.id}`} {...fg(REQ_COLOR[st])}>{prefs.color ? '■' : REQ_GLYPH[st]}</Text>
        })}
        {reqs.length > shown.length ? <Text dimColor>{` +${reqs.length - shown.length}`}</Text> : null}
        {reqs.length === 0 ? <Text dimColor>none yet</Text> : null}
      </Text>
    )
  }
  const progress = (w: number): RenderElement => {
    const g = gauge(s.progress, Math.max(5, Math.min(14, w - 34)))
    return (
      <Text key="progress" wrap="truncate-end">
        <Text {...fg(C.ok)}>{g.on}</Text>
        <Text {...faint}>{g.off}</Text>
        <Text bold>{` ${s.requirements.verified}/${inForce} verified`}</Text>
        <Text dimColor>{` · must ${s.must.verified}/${s.must.total}`}</Text>
      </Text>
    )
  }
  const notVerified = s.requirements.unverified + s.requirements.implemented
  const badClaims = s.claims.contradicted + s.claims.unsupported
  const parts: [string, ThemeKey][] = [
    ...(notVerified > 0 ? [[`? ${notVerified} not verified`, C.dim] as [string, ThemeKey]] : []),
    ...(s.requirements.stale > 0 ? [[`⧗ ${s.requirements.stale} stale`, C.warn] as [string, ThemeKey]] : []),
    ...(s.requirements.failed > 0 ? [[`✗ ${s.requirements.failed} failed`, C.bad] as [string, ThemeKey]] : []),
    ...(s.findings.open > 0 ? [[`! ${plural(s.findings.open, 'finding')}${s.findings.high ? ` (${s.findings.high} high)` : ''}`, C.warn] as [string, ThemeKey]] : []),
    ...(badClaims > 0 ? [[`✗ ${badClaims} claim(s)`, C.bad] as [string, ThemeKey]] : []),
  ]
  const counts = (
    <Text key="counts" wrap="truncate-end">
      {parts.length === 0 ? <Text {...fg(C.ok)}>no open problems recorded</Text> : parts.map(([text, color], i) => (
        <Text key={`n${i}`}>
          {i > 0 ? <Text {...faint}> · </Text> : null}
          <Text {...fg(color)}>{text}</Text>
        </Text>
      ))}
    </Text>
  )

  const contractCard = (w: number): RenderElement =>
    card('c-contract', C.main, `CONTRACT · ${approval}`, `intent ${s.intent}`, w, [
      <Text key="title" wrap="truncate-end">◆ {s.title}</Text>,
      strip(inner(w)),
      progress(inner(w)),
      counts,
    ])

  const evidenceCard = (w: number): RenderElement =>
    card('c-evidence', C.evidence, 'EVIDENCE · witness', plural(s.evidence.total, 'check'), w,
      s.evidence.latest.length === 0
        ? [<Text key="none" dimColor wrap="wrap">Not observed: no test, build, lint or typecheck run yet.</Text>]
        : s.evidence.latest.map(ev => {
          const stale = ev.freshness === 'stale'
          const color = ev.outcome === 'fail' ? C.bad : ev.outcome !== 'pass' ? C.dim : stale ? C.warn : C.ok
          return (
            <Text key={`latest:${ev.check}`} wrap="truncate-end">
              <Text {...fg(color)}>{ev.outcome === 'pass' ? '✓' : ev.outcome === 'fail' ? '✗' : '·'}</Text>
              {` ${ev.check} ${ev.outcome} · `}
              <Text {...(stale ? fg(C.warn) : {})}>{stale ? '⧗ stale' : ev.freshness}</Text>
              <Text dimColor>{` · ${time(ev.at)} ${ev.id}`}</Text>
            </Text>
          )
        }))

  const order: Record<E.Severity, number> = { high: 0, medium: 1, low: 2, info: 3 }
  const sorted = task.findings.filter(f => f.status !== 'resolved')
    .sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || order[a.severity] - order[b.severity])
  const findingLabel = (f: E.Finding): string =>
    `${f.confidence === 'expected' ? '○' : SEV_GLYPH[f.severity]} ${f.ruleId} ${f.file}:${f.line} ${f.category.replace(/^\w\.\s*/, '')}${f.status !== 'open' ? ` (${f.status})` : f.confidence === 'confirmed' ? ' [confirmed]' : ''}`

  const findingsCard = (w: number): RenderElement => {
    const top = sorted.filter(f => f.status === 'open' && f.confidence !== 'expected').slice(0, 3)
    return card('c-findings', C.warn, 'FINDINGS · mirage + drift', `${s.findings.open} open`, w, [
      <Text key="sev" wrap="truncate-end">
        <Text {...fg(C.bad)}>‼</Text>{` ${s.findings.high} high · `}
        <Text {...fg(C.warn)}>!</Text>{` ${s.findings.medium} medium · · ${s.findings.low + s.findings.info} low · ○ ${s.findings.expected} expected · ${s.findings.waived} waived`}
      </Text>,
      ...(top.length === 0
        ? [<Text key="none" dimColor wrap="truncate-end">none open · checked on every observed edit</Text>]
        : top.map(f => <Button key={`ovf:${f.id}`} plain label={clip(findingLabel(f), inner(w))} onPress={go('findings', f.id)} />)),
    ])
  }

  const claimsCard = (w: number): RenderElement => {
    const worst = s.claims.latest.filter(c => c.verdict === 'contradicted' || c.verdict === 'unsupported').slice(0, 2)
    return card('c-claims', C.claims, 'CLAIMS · last answer', `${s.claims.total} checked`, w, [
      s.claims.total === 0
        ? <Text key="none" dimColor wrap="wrap">Not assessed: no completion claims audited yet.</Text>
        : (
          <Text key="verdicts" wrap="truncate-end">
            <Text {...fg(C.ok)}>✓</Text>{` ${s.claims.supported} supported · ◐ ${s.claims.partial} partial · `}
            <Text {...fg(C.warn)}>?</Text>{` ${s.claims.unsupported} unsupported · `}
            <Text {...fg(C.bad)}>✗</Text>{` ${s.claims.contradicted} contradicted · · ${s.claims.notAssessable} n/a`}
          </Text>
        ),
      ...worst.map(c => (
        <Text key={`wc:${c.id}`} wrap="truncate-end">
          <Text {...fg(c.verdict === 'contradicted' ? C.bad : C.warn)}>{E.GLYPH[c.verdict]}</Text>
          {` "${clip(c.text, 40)}": `}
          <Text dimColor>{c.reason}</Text>
        </Text>
      )),
    ])
  }

  // Flightdeck's receipt: one line in its own card, here the top concern.
  const receipt = (w: number): RenderElement => {
    const line = s.concern
      ? [
        <Text key="concern" wrap="truncate-end" {...fg(C.warn)}>▸ {clip(s.concern.text, Math.max(10, inner(w) - 12))} </Text>,
        <Button key="concern-go" plain label="inspect" hotkey="i" onPress={go(s.concern.tab)} />,
      ]
      : [<Text key="concern" {...fg(C.ok)}>✓ No outstanding concern.</Text>]
    return isMini
      ? <Box key="receipt" flexDirection="row">{line}</Box>
      : <Box key="receipt" flexDirection="row" borderStyle="round" {...(prefs.color ? { borderColor: s.concern ? C.warn : C.ok } : {})} borderDimColor={s.concern === undefined} paddingX={1} width={w}>{line}</Box>
  }

  const actionRow = (
    <Box key="actions" flexDirection="row" columnGap={2} {...(isMini ? {} : { paddingX: 1 })}>
      {s.approval !== 'approved' && <Button key="approve" plain hotkey="a" label="approve contract" onPress={() => flash(actions.approve())} />}
      <Button key="recheck" plain hotkey="c" label="re-check" onPress={() => flash(actions.recheck())} />
      {ui.tab === 'overview' && !isMini && <Button key="ov-report" plain hotkey="r" label="report" dimColor onPress={go('report')} />}
    </Box>
  )

  /** Flightdeck's session log: dim time, colored kind, the text. */
  const log = (key: string, title: string, w: number, rows: number): RenderElement => {
    const lines = task.activity.slice(-rows).reverse()
    const body = lines.length === 0 ? [<Text key="none" {...faint}>nothing yet</Text>] : lines.map((a, i) => (
      <Box key={`a${i}`} flexDirection="row">
        <Box key="t" width={6} flexShrink={0}><Text {...faint}>{time(a.at)}</Text></Box>
        <Box key="k" width={12} flexShrink={0}><Text bold wrap="truncate-end" {...fg(KIND_COLOR[a.kind])}>{a.kind}</Text></Box>
        <Text key="x" wrap="truncate-end">{a.text}</Text>
      </Box>
    ))
    return isMini
      ? <Box key={key} flexDirection="column">{body}</Box>
      : (
        <Box key={key} flexDirection="column" borderStyle="round" {...(prefs.color ? { borderColor: C.faint } : {})} paddingX={1} width={w}>
          <Text key="title" dimColor>{title}</Text>
          {body}
        </Box>
      )
  }

  const overview = (): RenderElement => {
    if (isMini) {
      const g = gauge(s.progress, 6)
      return (
        <Box flexDirection="column" width={W}>
          <Text key="mini1" wrap="truncate-end">
            <Text bold {...fg(C.main)}>Integrity </Text>
            <Text {...fg(C.ok)}>{g.on}</Text>
            <Text {...faint}>{g.off}</Text>
            <Text bold>{` ${s.requirements.verified}/${inForce} verified`}</Text>
            <Text dimColor>{` · ${approval} · ${s.mode}`}</Text>
          </Text>
          {counts}
          {receipt(W)}
          {actionRow}
        </Box>
      )
    }
    if (layout === 'wide') {
      const colW = Math.floor((W - 2) / 2)
      return (
        <Box flexDirection="column" width={W}>
          <Box key="cols" flexDirection="row" columnGap={2}>
            <Box key="left" flexDirection="column" width={colW}>
              {contractCard(colW)}
              {rail('rail-l', colW)}
              {evidenceCard(colW)}
            </Box>
            <Box key="right" flexDirection="column" width={colW}>
              {findingsCard(colW)}
              {rail('rail-r', colW)}
              {claimsCard(colW)}
            </Box>
          </Box>
          {receipt(W)}
          {actionRow}
          {log('c-log', 'activity log', W, 6)}
        </Box>
      )
    }
    return (
      <Box flexDirection="column" width={W}>
        {contractCard(W)}
        {rail('rail-1', W)}
        {evidenceCard(W)}
        {rail('rail-2', W)}
        {findingsCard(W)}
        {rail('rail-3', W)}
        {claimsCard(W)}
        {receipt(W)}
        {actionRow}
        {log('c-log', 'activity log', W, 4)}
      </Box>
    )
  }

  // ---- list views with a drill-down -------------------------------------------------------

  const hasDetail = layout === 'wide' && ui.selected !== undefined
  const listW = hasDetail ? W - Math.floor(W / 2) - 2 : W
  const rowWidth = inner(listW)

  const detail = (color: ThemeKey, lines: (string | RenderElement)[]): RenderElement => (
    <Box key="detail" flexDirection="column" borderStyle="double" {...(prefs.color ? { borderColor: color } : {})} paddingX={1}
      {...(layout === 'wide' ? { width: Math.floor(W / 2) } : { marginTop: 1 })}>
      {lines.map((l, i) => (typeof l === 'string' ? <Text key={`d${i}`} wrap="wrap">{l}</Text> : l))}
      <Button key="detail-close" plain hotkey="x" label="close detail" dimColor onPress={() => void actions.setUi(u => ({ ...u, selected: undefined, waiving: undefined }))} />
    </Box>
  )

  const waiveField = (id: string, kind: 'finding' | 'requirement'): RenderElement => (
    ui.waiving === id
      ? Input !== undefined
        ? <Input key="waive-reason" label="Waiver reason" placeholder="why this is acceptable" autoFocus
          onSubmit={reason => { if (reason.trim() !== '') flash(kind === 'finding' ? actions.setFinding(id, 'waived', reason) : actions.waiveRequirement(id, reason)) }} />
        : <Text key="waive-reason" dimColor>Type /integrity-waive {id} &lt;reason&gt; to waive.</Text>
      : <Button key="waive" plain hotkey="w" label="waive (with reason)" onPress={() => void actions.setUi(u => ({ ...u, waiving: id }))} />
  )

  const split = (list: RenderElement, side: RenderElement | null): RenderElement =>
    layout === 'wide' && side !== null
      ? <Box flexDirection="row" columnGap={2}><Box flexDirection="column" width={listW}>{list}</Box>{side}</Box>
      : <Box flexDirection="column">{list}{side}</Box>

  const requirements = (): RenderElement => {
    const reqs = task.contract.requirements
    const list = card('v-req', C.main, 'REQUIREMENTS', `${s.requirements.verified}/${inForce} verified`, listW, [
      ...(reqs.length === 0 ? [<Text key="none" dimColor>No requirements. /integrity-contract add &lt;requirement&gt;</Text>] : []),
      ...reqs.map(r => {
        const st = E.requirementState(r, task).state
        return (
          <Button key={`req:${r.id}`} plain label={clip(`${REQ_GLYPH[st]} ${r.id} [${r.criticality}] ${r.description}`, rowWidth)}
            dimColor={st === 'waived'} onPress={go('requirements', r.id)} />
        )
      }),
      task.contract.exclusions.length > 0 && <Text key="excl" dimColor wrap="truncate-end">Exclusions: {task.contract.exclusions.join(', ')}</Text>,
    ])
    const r = reqs.find(x => x.id === ui.selected)
    if (r === undefined) return list
    const st = E.requirementState(r, task)
    return split(list, detail(REQ_COLOR[st.state], [
      `${REQ_GLYPH[st.state]} ${r.id}: ${REQ_LABEL[st.state]}`,
      r.description,
      `${r.criticality} · ${r.category} · verified by ${r.verification} evidence · ${r.origin}`,
      `Why: ${st.reason}`,
      ...(r.checks.length ? [`Checks: ${r.checks.join(', ')}`] : ['No declared check: /integrity-contract check ' + r.id + ' <command>']),
      ...(st.evidence.length ? st.evidence.slice(-5).map(ev => `  ${ev.id} ${ev.check} ${ev.outcome} · ${E.freshness(ev, task)} · ${ev.basis}`) : ['No linked evidence. /integrity-verify ' + r.id + ' <what you checked>']),
      ...(r.waiver ? [`Waived: ${r.waiver.reason}`] : [waiveField(r.id, 'requirement')]),
    ]))
  }

  const evidence = (): RenderElement => {
    const shown = task.evidence.slice(-(isMini ? 6 : 20)).reverse()
    const list = card('v-ev', C.evidence, 'EVIDENCE', `${s.evidence.fresh} fresh · ${s.evidence.stale} stale`, listW, [
      ...(shown.length === 0 ? [<Text key="none" dimColor wrap="wrap">Not observed: no checks yet. Test, build, lint and typecheck runs Claude makes appear here. Nothing is verified without one.</Text>] : []),
      ...shown.map(ev => {
        const fresh = E.freshness(ev, task)
        const mark = ev.synthetic ? '⊘' : ev.outcome === 'pass' ? '✓' : ev.outcome === 'fail' ? '✗' : '·'
        return (
          <Button key={`ev:${ev.id}`} plain onPress={go('evidence', ev.id)} dimColor={fresh === 'stale' || ev.outcome === 'inconclusive'}
            label={clip(`${mark} ${ev.id} ${ev.check} ${ev.outcome} · ${fresh === 'stale' ? '⧗ stale' : fresh} · ${ev.command ?? ev.source}`, rowWidth)} />
        )
      }),
    ])
    const ev = task.evidence.find(x => x.id === ui.selected)
    if (ev === undefined) return list
    const fresh = E.freshness(ev, task)
    return split(list, detail(ev.outcome === 'fail' ? C.bad : fresh === 'stale' ? C.warn : C.evidence, [
      `${ev.id} · ${ev.kind} · ${ev.check} ${ev.outcome}${ev.synthetic ? ' · SYNTHETIC (never proof)' : ''}`,
      `Basis: ${ev.basis}`,
      `Freshness: ${fresh}${fresh === 'stale' ? ` (changed since: ${E.staleBecause(ev, task).slice(0, 4).join(', ')})` : ''}`,
      ...(ev.command ? [`Command: ${ev.command}`] : []),
      ...(ev.counts ? [`Counts: ${ev.counts.passed} passed, ${ev.counts.failed} failed, ${ev.counts.skipped} skipped`] : []),
      `Scope: ${ev.scope.length ? ev.scope.join(', ') : 'whole project'}${ev.truncated ? ' · output truncated' : ''}`,
      `Source: ${ev.source}${ev.agentId ? ` (subagent ${ev.agentId})` : ''} · ${new Date(ev.timestamp).toISOString()}`,
      ...(ev.revision ? [`Revision: ${ev.revision}`] : []),
      ...(ev.cwd ? [`Working dir: ${ev.cwd}`] : []),
      `Requirements: ${ev.requirementIds.join(', ') || 'none linked (/integrity-evidence link ' + ev.id + ' R#)'}`,
    ]))
  }

  const findings = (): RenderElement => {
    const per = isMini ? Math.min(4, prefs.maxFindings) : prefs.maxFindings
    const pages = Math.max(1, Math.ceil(sorted.length / per))
    const page = Math.min(ui.page, pages - 1)
    const list = card('v-find', C.warn, 'FINDINGS', `${s.findings.open} open`, listW, [
      ...(sorted.length === 0 ? [<Text key="none" dimColor wrap="wrap">No open findings. Mirage and drift checks run on every observed edit.</Text>] : []),
      ...sorted.slice(page * per, page * per + per).map(f => (
        <Button key={`f:${f.id}`} plain onPress={go('findings', f.id)} dimColor={f.status !== 'open' || f.confidence === 'expected'}
          label={clip(findingLabel(f), rowWidth)} />
      )),
      pages > 1 && (
        <Box key="pager" flexDirection="row" columnGap={1}>
          <Text dimColor>page {page + 1}/{pages}</Text>
          {page > 0 && <Button key="prev" plain hotkey="p" label="prev" onPress={() => void actions.setUi(u => ({ ...u, page: page - 1 }))} />}
          {page < pages - 1 && <Button key="next" plain hotkey="n" label="next" onPress={() => void actions.setUi(u => ({ ...u, page: page + 1 }))} />}
        </Box>
      ),
    ])
    const f = task.findings.find(x => x.id === ui.selected)
    if (f === undefined) return list
    return split(list, detail(f.severity === 'high' ? C.bad : C.warn, [
      `${SEV_GLYPH[f.severity]} ${f.severity} · ${f.confidence} · ${f.status} · ${f.ruleId} (${f.system})`,
      `${f.file}:${f.line}`,
      <Text key="snippet" dimColor wrap="truncate-end">  {f.snippet}</Text>,
      f.explanation,
      `Evidence: ${f.evidence}`,
      `Verify: ${f.verify}`,
      ...(f.requirementIds.length ? [`Requirements: ${f.requirementIds.join(', ')}`] : []),
      ...(f.waiver ? [`Waived: ${f.waiver.reason}`] : []),
      <Box key="f-actions" flexDirection="row" columnGap={1}>
        {f.status === 'open' && <Button key="ack" plain hotkey="k" label="acknowledge" onPress={() => flash(actions.setFinding(f.id, 'acknowledged'))} />}
        {f.status !== 'open' && <Button key="reopen" plain hotkey="o" label="reopen" onPress={() => flash(actions.setFinding(f.id, 'open'))} />}
      </Box>,
      ...(f.status === 'waived' ? [] : [waiveField(f.id, 'finding')]),
    ]))
  }

  const claims = (): RenderElement => {
    const shown = task.claims.slice(-(isMini ? 4 : 12)).reverse()
    const list = card('v-claims', C.claims, 'CLAIMS', `${task.claims.length} audited`, listW, [
      ...(shown.length === 0 ? [<Text key="none" dimColor wrap="wrap">Not assessed: no completion claims audited yet. They are checked when Claude finishes an answer.</Text>] : []),
      ...shown.map(c => (
        <Button key={`c:${c.id}`} plain onPress={go('claims', c.id)} dimColor={c.verdict === 'not-assessable'}
          label={clip(`${E.GLYPH[c.verdict]} ${c.verdict}: "${c.text}"`, rowWidth)} />
      )),
    ])
    const c = task.claims.find(x => x.id === ui.selected)
    if (c === undefined) return list
    return split(list, detail(c.verdict === 'contradicted' ? C.bad : c.verdict === 'supported' ? C.ok : C.claims, [
      `${E.GLYPH[c.verdict]} ${c.verdict} · ${c.kind} · ${time(c.at)}`,
      `"${c.text}"`,
      `Why: ${c.reason}`,
      `Evidence: ${c.evidenceIds.join(', ') || (c.verdict === 'unsupported' ? 'none observed (absence of evidence, not proof of failure)' : 'none')}`,
    ]))
  }

  const activity = (): RenderElement => log('v-log', 'ACTIVITY', W, isMini ? 6 : 30)

  const report = (): RenderElement =>
    card('v-report', C.main, 'REPORT', `task ${task.id}`, W, [
      <Text key="same" wrap="wrap">Same counts as /integrity-report: {s.requirements.verified}/{inForce} verified, {s.requirements.stale} stale, {s.requirements.failed} failed, {s.findings.open} open findings, {s.evidence.fresh} fresh passing checks.</Text>,
      <Box key="exports" flexDirection="row" columnGap={2}>
        <Button key="export-md" plain hotkey="e" label="export Markdown" onPress={() => flash(actions.exportReport('md'))} />
        <Button key="export-json" plain hotkey="j" label="export JSON" onPress={() => flash(actions.exportReport('json'))} />
      </Box>,
      <Text key="where" dimColor wrap="wrap">Files go to .claude/integrity/{task.id}.md|.json in the project. Headless: /integrity-report [md|json] [export].</Text>,
    ])

  const views: Record<IntegrityTab, () => RenderElement> = { overview, requirements, evidence, findings, claims, activity, report }

  return (
    <Box flexDirection="column" width={W}>
      {header}
      {tabBar}
      <Box key="body" flexDirection="column" marginTop={isMini ? 0 : 1}>{views[ui.tab]()}</Box>
      {footer}
    </Box>
  )
}
