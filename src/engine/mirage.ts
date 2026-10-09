// Mirage Detector: deterministic rules for fake completeness in JS/TS/React
// sources. Each rule reads one file's text against the contract's intent and
// says how sure it is. Nothing here is a verdict on its own: `confirmed` is
// kept for code that literally says it is not implemented; everything else
// is `potential` (look at it) or `expected` (the contract asked for it).
//
// Token-level, not an AST: the Mod runtime has no TypeScript compiler, and a
// regex over comment-stripped text with brace matching covers these patterns
// with known, documented blind spots (docs/DETECTION-RULES.md).

import type { Confidence, ContractIntent, Severity } from './types'
import { clip, hash, isTestPath } from './util'

export type RuleContext = {
  path: string
  source: string
  /** The source with comments blanked, offsets and newlines kept. */
  code: string
  intent: ContractIntent
  /** The contract's own words, lower-cased: rules read what was asked for. */
  asked: string
}

export type RawFinding = {
  ruleId: string
  category: string
  line: number
  snippet: string
  explanation: string
  evidence: string
  severity: Severity
  confidence: Confidence
  verify: string
}

export type MirageRule = {
  id: string
  category: string
  title: string
  appliesTo: (path: string) => boolean
  detect: (ctx: RuleContext) => RawFinding[]
}

/** Blanks `//` and `/* *\/` comments outside strings, keeping every offset. */
export function stripComments(src: string): string {
  let out = ''
  let quote: string | undefined
  for (let i = 0; i < src.length; i++) {
    const c = src[i] as string
    if (quote !== undefined) {
      out += c
      if (c === '\\') out += src[++i] ?? ''
      else if (c === quote) quote = undefined
    } else if (c === '"' || c === "'" || c === '`') {
      quote = c
      out += c
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i++ }
      if (i < src.length) out += '\n'
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end < 0 ? src.length : end + 2
      out += src.slice(i, stop).replace(/[^\n]/g, ' ')
      i = stop - 1
    } else out += c
  }
  return out
}

export const lineOf = (src: string, index: number): number => src.slice(0, index).split('\n').length

const lineText = (src: string, index: number): string => {
  const start = src.lastIndexOf('\n', index - 1) + 1
  const end = src.indexOf('\n', index)
  return src.slice(start, end < 0 ? src.length : end)
}

/** Index of the `}` closing the `{` at `open`, or the end of the text. */
function closeOf(code: string, open: number): number {
  let depth = 0
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++
    else if (code[i] === '}' && --depth === 0) return i
  }
  return code.length
}

/** The body of the innermost function around `index`: `function ... {` or `=> {`. */
export function enclosingFunction(code: string, index: number): { start: number; body: string } | undefined {
  const starts = [...code.slice(0, index).matchAll(/(\bfunction\b[^{;]*|=>\s*)\{/g)]
  for (let i = starts.length - 1; i >= 0; i--) {
    const m = starts[i] as RegExpMatchArray
    const open = (m.index ?? 0) + m[0].length - 1
    const close = closeOf(code, open)
    if (close >= index) return { start: m.index ?? 0, body: code.slice(open, close + 1) }
  }
  return undefined
}

const byIntent = (intent: ContractIntent, production: Severity, unknown: Severity): Severity =>
  intent === 'production' ? production : unknown

const find = (ctx: RuleContext, re: RegExp, make: (m: RegExpMatchArray) => Omit<RawFinding, 'line' | 'snippet'> | undefined): RawFinding[] =>
  [...ctx.code.matchAll(re)].flatMap(m => {
    const made = make(m)
    const at = m.index ?? 0
    return made === undefined ? [] : [{ ...made, line: lineOf(ctx.code, at), snippet: clip(lineText(ctx.source, at), 140) }]
  })

const SOURCE = (path: string): boolean => /\.(c|m)?(t|j)sx?$/i.test(path) && !isTestPath(path) && !/\.d\.ts$/i.test(path)
const UI = (path: string): boolean => SOURCE(path) && (/\.(j|t)sx$/i.test(path) || /(^|\/)(components?|pages|app|views|screens|routes)\//i.test(path))
const FIXTURE_PATH = /(^|\/)(mocks?|__mocks__|fixtures?|stories|storybook|seed|demo)(\/|\.)|\.(stories|mock|fixture)\.\w+$/i

/** Route handlers: Next.js app/pages API, Express-style `app.post(...)`. */
const HANDLER = /export\s+(?:async\s+)?function\s+(POST|PUT|PATCH|DELETE)\b|export\s+const\s+(POST|PUT|PATCH|DELETE)\s*=|\b(?:app|router|server)\.(post|put|patch|delete)\s*\(/g
const IO = /\b(await\s+(?!(?:req|request)\.(?:json|text|formData)\(\))[\w.]+\(|prisma|db\.|sql`|\.query\(|\.insert|\.update\(|\.upsert|\.save\(|\.create\(|\.delete\(|writeFile|fetch\(|axios|supabase|firestore|mongo|redis|knex|drizzle|kv\.|repository\.|\w+Service\.)/
const SUCCESS = /\b(success|ok)\s*:\s*true|status\(\s*20[01]\s*\)|status:\s*20[01]|Response\.json\(|NextResponse\.json\(|res\.(json|send)\(|return\s+new\s+Response\(/

export const RULES: readonly MirageRule[] = [
  {
    id: 'MIR-E1', category: 'E. Placeholder implementation', title: 'Throws "not implemented"', appliesTo: SOURCE,
    detect: ctx => find(ctx, /throw\s+new\s+\w*Error\(\s*['"`](not\s+(yet\s+)?implemented|unimplemented|todo)\b/gi, () => ({
      ruleId: 'MIR-E1', category: 'E. Placeholder implementation', severity: 'high', confidence: 'confirmed',
      explanation: 'This code path throws "not implemented": the behaviour does not exist yet.',
      evidence: 'Literal throw of a not-implemented error in a non-test source file.',
      verify: 'Implement the branch, or record it as an explicit exclusion in the contract.',
    })),
  },
  {
    id: 'MIR-E2', category: 'E. Placeholder implementation', title: 'TODO that defers the real work', appliesTo: SOURCE,
    // TODOs live in comments, so this rule reads the raw source; plain TODOs are not flagged.
    detect: ctx => [...ctx.source.matchAll(/(\/\/|\/\*|\{\s*\/\*)\s*(TODO|FIXME|XXX)\b[:\s-]*(.{0,120})/g)]
      .filter(m => /\b(implement|wire|hook up|connect|persist|save|real|call (the )?api|backend|replace|fetch|auth)/i.test(m[3] ?? ''))
      .map(m => ({
        ruleId: 'MIR-E2', category: 'E. Placeholder implementation', line: lineOf(ctx.source, m.index ?? 0),
        snippet: clip(lineText(ctx.source, m.index ?? 0), 140), severity: byIntent(ctx.intent, 'medium', 'low'), confidence: 'potential' as Confidence,
        explanation: 'A TODO says the real behaviour is still to be wired up here.',
        evidence: `Comment: "${clip(m[3] ?? '', 80)}"`,
        verify: 'Confirm the deferred work is done elsewhere, or track it as unfinished.',
      })),
  },
  {
    id: 'MIR-E3', category: 'E. Placeholder implementation', title: 'Placeholder endpoint or key', appliesTo: SOURCE,
    detect: ctx => find(ctx, /['"`](https?:\/\/(api\.)?example\.(com|org)[^'"`]*|\/api\/(todo|placeholder|xxx|example)[^'"`]*|YOUR_[A-Z_]+|<your[^>]*>|REPLACE_ME)['"`]/gi, m => ({
      ruleId: 'MIR-E3', category: 'E. Placeholder implementation', severity: byIntent(ctx.intent, 'high', 'medium'), confidence: 'potential',
      explanation: 'A placeholder URL or credential stands where a real one is needed.',
      evidence: `Literal ${clip(m[1] ?? '', 60)}`,
      verify: 'Point it at the real endpoint or configuration value.',
    })),
  },
  {
    id: 'MIR-B1', category: 'B. Simulated success', title: 'Handler returns success without doing the work',
    appliesTo: SOURCE,
    detect: ctx => [...ctx.code.matchAll(HANDLER)].flatMap(m => {
      const at = m.index ?? 0
      const open = ctx.code.indexOf('{', at)
      if (open < 0) return []
      const body = ctx.code.slice(open, closeOf(ctx.code, open) + 1)
      if (!SUCCESS.test(body) || IO.test(body)) return []
      const sev: Severity = ctx.intent === 'prototype' ? 'info' : byIntent(ctx.intent, 'high', 'medium')
      return [{
        ruleId: 'MIR-B1', category: 'B. Simulated success', line: lineOf(ctx.code, at), snippet: clip(lineText(ctx.source, at), 140),
        severity: sev, confidence: (ctx.intent === 'prototype' ? 'expected' : 'potential') as Confidence,
        explanation: `The ${m[1] ?? m[2] ?? m[3]?.toUpperCase()} handler answers success but performs no write, query or outbound call.`,
        evidence: 'Success response in the handler body; no database, fetch, service or file call found in it.',
        verify: 'Run a request against the endpoint and confirm the change is persisted.',
      }]
    }),
  },
  {
    id: 'MIR-B2', category: 'B. Simulated success', title: 'Artificial delay standing in for a request', appliesTo: SOURCE,
    detect: ctx => find(ctx, /await\s+new\s+Promise\s*\(\s*\(?\s*\w+\s*\)?\s*=>\s*setTimeout\s*\(|await\s+(sleep|delay|wait)\s*\(\s*\d+/g, m => {
      const fn = enclosingFunction(ctx.code, m.index ?? 0)
      const body = fn?.body ?? ''
      const fakesSuccess = /\b(setSuccess|setSaved|setDone|toast\.success|setStatus\(\s*['"](success|saved|done))|success\s*:\s*true/i.test(body)
      if (!fakesSuccess || /\bfetch\(|axios|mutate|api\.\w+\(/.test(body)) return undefined
      return {
        ruleId: 'MIR-B2', category: 'B. Simulated success', severity: ctx.intent === 'prototype' ? 'info' : 'high',
        confidence: ctx.intent === 'prototype' ? 'expected' : 'potential',
        explanation: 'A timer delay is followed by a success state, with no request in between: it imitates a backend call.',
        evidence: 'setTimeout/sleep plus a success state in the same function; no fetch or mutation call.',
        verify: 'Replace the delay with the real request and check its failure path.',
      }
    }),
  },
  {
    id: 'MIR-C1', category: 'C. Non-functional control', title: 'Control with an empty or log-only action', appliesTo: UI,
    detect: ctx => find(ctx, /\b(on(?:Click|Press|Submit|Change|Select))=\{\s*(\(\s*\w*\s*\)\s*=>\s*(\{\s*\}|null|undefined|console\.\w+\([^)]*\)|alert\([^)]*\)|\w+\.preventDefault\(\))|undefined|null)\s*\}|\bhref=["'](#|javascript:void\(0\);?)?["']/g, m => ({
      ruleId: 'MIR-C1', category: 'C. Non-functional control', severity: 'medium', confidence: 'potential',
      explanation: 'This control is drawn but its action does nothing (empty, log-only or placeholder link).',
      evidence: `Handler: ${clip(m[0], 80)}`,
      verify: 'Press the control and confirm it does what the requirement says.',
    })),
  },
  {
    id: 'MIR-A1', category: 'A. Mock data as production data', title: 'Hardcoded or fixture data in a shipped view',
    appliesTo: path => UI(path) && !FIXTURE_PATH.test(path),
    detect: ctx => {
      const named = /\b(?:const|let|var)\s+((?:mock|fake|dummy|sample|placeholder|hardcoded|static|test)\w*)\s*(?::[^=]+)?=\s*[[{]/gi
      const imported = /\bimport\s+[^;]*?from\s+['"]([^'"]*(?:mocks?|fixtures?|sample|fake|dummy)[^'"]*)['"]/gi
      const confidence: Confidence = ctx.intent === 'prototype' ? 'expected' : 'potential'
      const severity: Severity = ctx.intent === 'prototype' ? 'info' : byIntent(ctx.intent, 'high', 'medium')
      const why = ctx.intent === 'prototype'
        ? 'Fixture data, as the contract asks for a prototype.'
        : 'A view renders fixture data; nothing shows it is replaced by real data.'
      return [
        ...find(ctx, named, m => ({
          ruleId: 'MIR-A1', category: 'A. Mock data as production data', severity, confidence, explanation: why,
          evidence: `Data declared as "${m[1]}" in a UI source file.`,
          verify: 'Check where the view gets its data at runtime; trace it to the API or store.',
        })),
        ...find(ctx, imported, m => ({
          ruleId: 'MIR-A1', category: 'A. Mock data as production data', severity, confidence, explanation: why,
          evidence: `Imports from "${m[1]}".`,
          verify: 'Check where the view gets its data at runtime; trace it to the API or store.',
        })),
      ]
    },
  },
  {
    id: 'MIR-D1', category: 'D. Incomplete data integration', title: 'Fetched response is discarded', appliesTo: SOURCE,
    detect: ctx => find(ctx, /\b(?:const|let)\s+(\w+)\s*=\s*await\s+(fetch|axios(?:\.\w+)?|api\.\w+|\w+Client\.\w+)\s*\(/g, m => {
      const name = m[1] as string
      const uses = ctx.code.match(new RegExp(`\\b${name}\\b`, 'g'))?.length ?? 0
      if (uses > 1) return undefined
      return {
        ruleId: 'MIR-D1', category: 'D. Incomplete data integration', severity: byIntent(ctx.intent, 'high', 'medium'), confidence: 'potential',
        explanation: `The response "${name}" is requested and never read: the request runs but its data is not used.`,
        evidence: `"${name}" is assigned from ${m[2]}(...) and referenced nowhere else in the file.`,
        verify: 'Confirm the UI renders the response, not static data.',
      }
    }),
  },
  {
    id: 'MIR-F1', category: 'F. Missing persistence', title: 'Submit updates local state only',
    appliesTo: UI,
    detect: ctx => {
      if (!/\b(persist|save|saved|store|database|db|backend|server|api)\b/.test(ctx.asked) && ctx.intent !== 'production') return []
      return find(ctx, /\b(?:const|function)\s+(handleSubmit|onSubmit|submit\w*|save\w*|handleSave\w*|create\w*)\b/g, m => {
        const fn = enclosingFunction(ctx.code, (m.index ?? 0) + m[0].length + 40)
        if (fn === undefined || fn.start < (m.index ?? 0)) return undefined
        const body = fn.body
        if (!/\bset[A-Z]\w*\(|toast|alert\(/.test(body)) return undefined
        if (/\bfetch\(|axios|mutate|mutation|\bapi\.|\bpost\(|\bput\(|\bdb\.|prisma|supabase|firestore|localStorage|indexedDB|action\(|Action\(|startTransition|\bsave\w*\(|\bcreate\w*\(|\bupdate\w*\(/.test(body.replace(/\bset[A-Z]\w*\(/g, ''))) return undefined
        return {
          ruleId: 'MIR-F1', category: 'F. Missing persistence', severity: 'high', confidence: 'potential',
          explanation: `${m[1]} changes component state but sends nothing anywhere, while the task asks for saved data.`,
          evidence: 'State setter or toast in the handler; no request, mutation or storage call.',
          verify: 'Submit, reload the page, and confirm the data is still there.',
        }
      })
    },
  },
  {
    id: 'MIR-G1', category: 'G. Authorization omission', title: 'Permission enforced in the UI only', appliesTo: SOURCE,
    detect: ctx => {
      const out: RawFinding[] = []
      const mutatesClient = /method:\s*['"](POST|PUT|PATCH|DELETE)['"]/i.test(ctx.code)
      if (UI(ctx.path) && mutatesClient) {
        out.push(...find(ctx, /\b(?:user|session|currentUser|me)\??\.(?:role|isAdmin|permissions?)\b|\bisAdmin\s*&&|\bcan\w*\s*&&\s*</g, () => ({
          ruleId: 'MIR-G1', category: 'G. Authorization omission', severity: 'medium', confidence: 'potential',
          explanation: 'The UI hides or shows an action by role; a hidden button is not authorization.',
          evidence: 'Client-side role check in a component that sends a mutating request.',
          verify: 'Call the endpoint as an unprivileged user and confirm it is refused.',
        })).slice(0, 1))
      }
      if (/\b(auth|permission|admin|role|owner|only)\b/.test(ctx.asked)) {
        out.push(...[...ctx.code.matchAll(HANDLER)].flatMap(m => {
          const open = ctx.code.indexOf('{', m.index ?? 0)
          const body = ctx.code.slice(open, closeOf(ctx.code, open) + 1)
          if (/\b(auth|session|getServerSession|currentUser|requireUser|verify\w*Token|role|permission|forbidden|401|403)\b/i.test(body)) return []
          return [{
            ruleId: 'MIR-G1', category: 'G. Authorization omission', line: lineOf(ctx.code, m.index ?? 0),
            snippet: clip(lineText(ctx.source, m.index ?? 0), 140), severity: 'high' as Severity, confidence: 'potential' as Confidence,
            explanation: 'The task mentions permissions, and this mutating handler checks no session, role or token.',
            evidence: 'No auth, session, role or 401/403 reference in the handler body.',
            verify: 'Call it without credentials and confirm it is refused.',
          }]
        }))
      }
      return out
    },
  },
  {
    id: 'MIR-H1', category: 'H. Missing failure handling', title: 'Request with no failure path', appliesTo: SOURCE,
    detect: ctx => find(ctx, /\bawait\s+fetch\s*\(/g, m => {
      const fn = enclosingFunction(ctx.code, m.index ?? 0)
      const body = fn?.body ?? ctx.code
      if (/\btry\s*\{|\.catch\(|\.ok\b|\.status\b|throwOnError|onError|catch\s*\(/.test(body)) return undefined
      return {
        ruleId: 'MIR-H1', category: 'H. Missing failure handling', severity: byIntent(ctx.intent, 'medium', 'low'), confidence: 'potential',
        explanation: 'A request is awaited with no try/catch, .catch or status check: a failure has no defined behaviour.',
        evidence: 'await fetch(...) in a function with no error or status handling.',
        verify: 'Make the request fail (offline, 500) and check what the user sees.',
      }
    }),
  },
]

/** Runs every rule that applies to `path`. Findings carry a fingerprint id stable across line moves. */
export function scanSource(path: string, source: string, intent: ContractIntent, asked: string): (RawFinding & { id: string })[] {
  if (source.length > 400_000) return []
  const ctx: RuleContext = { path, source, code: stripComments(source), intent, asked: asked.toLowerCase() }
  const seen = new Map<string, number>()
  return RULES.filter(r => r.appliesTo(path)).flatMap(r => r.detect(ctx)).map(f => {
    const base = hash(`${f.ruleId}|${path}|${f.snippet.replace(/\s+/g, '')}`)
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return { ...f, id: n === 0 ? base : `${base}-${n}` }
  })
}

/** Literal `/api/...` URLs a file requests (template literals with substitutions are skipped). */
export function apiCalls(source: string): { path: string; line: number }[] {
  const code = stripComments(source)
  return [...code.matchAll(/\b(?:fetch|axios(?:\.(?:get|post|put|patch|delete))?|\w+\.(?:get|post|put|patch|delete))\(\s*['"`](\/api\/[^'"`?#$]*)['"`?#]/g)]
    .map(m => ({ path: (m[1] as string).replace(/\/$/, ''), line: lineOf(code, m.index ?? 0) }))
}

/** The endpoint a Next.js route file serves, or undefined. Route groups `(x)` are dropped. */
export function routeOf(path: string): string | undefined {
  const app = path.match(/(?:^|\/)app\/((?:.+\/)?api(?:\/.+)?)\/route\.(?:t|j)sx?$/)
  if (app) return '/' + (app[1] as string).split('/').filter(s => !/^\(.*\)$/.test(s)).join('/')
  const pages = path.match(/(?:^|\/)pages\/(api(?:\/.+?)?)(?:\/index)?\.(?:t|j)sx?$/)
  return pages ? `/${pages[1]}` : undefined
}

/** `/api/events/[id]` serves `/api/events/42`; `[...slug]` serves the rest. */
export function routeMatches(route: string, call: string): boolean {
  const r = route.split('/')
  const c = call.split('/')
  for (let i = 0; i < r.length; i++) {
    const seg = r[i] as string
    if (/^\[\[?\.\.\./.test(seg)) return true
    if (c[i] === undefined) return false
    if (!/^\[.+\]$/.test(seg) && seg !== c[i]) return false
  }
  return r.length === c.length
}
