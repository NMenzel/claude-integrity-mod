// Delivery reports, Markdown and JSON, built from the same summary the UI shows.

import type { Mode, Task } from './types'
import { freshness } from './evidence'
import { requirementState } from './status'
import { summarize, type Summary } from './summary'
import { redact } from './util'

const LIMITATIONS = [
  'Verification covers observed tool calls in Claude Code sessions with this Mod loaded; commands run elsewhere are not seen.',
  'Mirage and drift rules are deterministic pattern checks: "potential" findings need a person to confirm them.',
  'A passing check verifies only the requirements linked to it; static analysis cannot prove runtime behaviour.',
]

export function toJson(task: Task, mode: Mode, project: string, now: number): Record<string, unknown> {
  const summary = summarize(task, mode)
  const { latest: _latest, ...claimCounts } = summary.claims
  return {
    schema: 'claude-integrity/report@1',
    generatedAt: new Date(now).toISOString(),
    project: redact(project),
    mode,
    summary: { ...summary, claims: claimCounts },
    contract: {
      taskId: task.id, summary: task.contract.summary, intent: task.contract.intent, version: task.contract.version,
      approval: task.contract.approval, promptHash: task.contract.prompt.hash, exclusions: task.contract.exclusions,
      scope: task.contract.scope, assumptions: task.contract.assumptions, revisions: task.contract.revisions.map(r => ({ version: r.version, at: r.at, change: r.change })),
    },
    requirements: task.contract.requirements.map(r => {
      const s = requirementState(r, task)
      return { ...r, state: s.state, reason: s.reason, linkedEvidence: s.evidence.map(e => e.id) }
    }),
    evidence: task.evidence.map(e => ({ ...e, freshness: freshness(e, task) })),
    findings: task.findings,
    claims: task.claims,
    limitations: LIMITATIONS,
  }
}

const STATE_GLYPH: Record<string, string> = { verified: '✓', stale: '⧗', failed: '✗', waived: '–', implemented: '◐', unverified: '?' }

export function toMarkdown(task: Task, mode: Mode, project: string, now: number): string {
  const s: Summary = summarize(task, mode)
  const c = task.contract
  const out: string[] = []
  out.push(`# Claude Integrity report`, '')
  out.push(`- Task: ${c.summary} (\`${task.id}\`)`)
  out.push(`- Project: ${redact(project)}`)
  out.push(`- Contract: ${s.approval} v${c.version}, intent ${c.intent}; mode ${mode}`)
  out.push(`- Generated: ${new Date(now).toISOString()}`, '')
  out.push(`## Summary`, '')
  out.push(`| Verified | Stale | Failed | Implemented | Unverified | Waived | Open findings | Fresh passing checks |`)
  out.push(`|---|---|---|---|---|---|---|---|`)
  out.push(`| ${s.requirements.verified}/${s.requirements.total - s.requirements.waived} | ${s.requirements.stale} | ${s.requirements.failed} | ${s.requirements.implemented} | ${s.requirements.unverified} | ${s.requirements.waived} | ${s.findings.open} | ${s.evidence.fresh} |`, '')
  if (s.concern) out.push(`**Top concern:** ${s.concern.text}`, '')

  out.push(`## Requirements`, '')
  if (c.requirements.length === 0) out.push('_No requirements recorded._')
  for (const r of c.requirements) {
    const st = requirementState(r, task)
    out.push(`- ${STATE_GLYPH[st.state]} **${r.id}** [${r.criticality}, ${r.category}] ${r.description}`)
    out.push(`  - ${st.state}: ${st.reason}${st.evidence.length ? ` · evidence ${st.evidence.map(e => e.id).join(', ')}` : ''}`)
  }
  if (c.exclusions.length) out.push('', `Exclusions: ${c.exclusions.map(x => `\`${x}\``).join(', ')}`)
  out.push('', `## Evidence`, '')
  if (task.evidence.length === 0) out.push('_No checks observed._')
  for (const e of task.evidence.slice(-40)) {
    out.push(`- ${e.id} ${e.check} **${e.outcome}** (${freshness(e, task)}) ${e.command ? `\`${e.command}\`` : e.source}: ${e.basis}${e.revision ? ` @ ${e.revision}` : ''}`)
  }
  out.push('', `## Findings`, '')
  const findings = task.findings.filter(f => f.status !== 'resolved')
  if (findings.length === 0) out.push('_No open findings._')
  for (const f of findings.slice(0, 60)) {
    out.push(`- [${f.severity}/${f.confidence}/${f.status}] ${f.ruleId} \`${f.file}:${f.line}\`: ${f.explanation}`)
    out.push(`  - Evidence: ${f.evidence} · Verify: ${f.verify}${f.waiver ? ` · Waived: ${f.waiver.reason}` : ''}`)
  }
  out.push('', `## Completion claims (latest turn)`, '')
  if (s.claims.latest.length === 0) out.push('_No claims audited._')
  for (const cl of s.claims.latest) out.push(`- **${cl.verdict}**: "${cl.text}": ${cl.reason}`)
  out.push('', `## Limitations`, '', ...LIMITATIONS.map(l => `- ${l}`), '')
  return out.join('\n')
}
