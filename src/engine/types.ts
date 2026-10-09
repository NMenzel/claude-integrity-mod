// Claude Integrity engine: the data model. Plain JSON-safe types, no runtime
// dependencies, so the engine runs in a Mod, a CLI or a CI job alike.

export type Mode = 'observe' | 'review' | 'strict'
export type NotifyLevel = 'off' | 'important' | 'all'
export type Layout = 'auto' | 'mini' | 'compact' | 'wide'

export type RequirementCategory = 'functional' | 'constraint' | 'non-functional' | 'test' | 'preservation'
export type Criticality = 'must' | 'should' | 'optional'
export type VerificationKind = 'static' | 'test' | 'runtime' | 'manual' | 'unknown'
/** Stored status: what a person or the engine decided. Display state adds freshness. */
export type RequirementStatus = 'unverified' | 'implemented' | 'verified' | 'failed' | 'waived'

export type Requirement = {
  id: string
  description: string
  category: RequirementCategory
  criticality: Criticality
  verification: VerificationKind
  /** `explicit`: quoted from the prompt; `manual`: typed by the person; `proposed`: a model suggestion awaiting approval. */
  origin: 'explicit' | 'manual' | 'proposed'
  /** Command substrings whose passing run verifies this requirement (`npm test -- events`). */
  checks: string[]
  /** Set by a person: the code for it exists. Never by a model. */
  implemented?: boolean
  /** Evidence a person linked by hand (`/integrity-link`). */
  evidenceIds: string[]
  waiver?: { reason: string; at: number }
}

export type ContractIntent = 'production' | 'prototype' | 'unknown'

export type ContractSnapshot = {
  summary: string
  requirements: Requirement[]
  exclusions: string[]
  scope: string[]
  assumptions: string[]
  intent: ContractIntent
}

export type Revision = { version: number; at: number; change: string; snapshot: ContractSnapshot }

export type Contract = ContractSnapshot & {
  taskId: string
  prompt: { hash: string; excerpt: string; capturedAt: number; source: 'prompt' | 'manual' }
  createdAt: number
  updatedAt: number
  version: number
  approval: { status: 'draft' | 'approved'; at?: number; version?: number }
  /** Frozen at first approval; amendments become revisions, never overwrite it. */
  baseline?: ContractSnapshot
  revisions: Revision[]
}

export type CheckKind = 'test' | 'build' | 'typecheck' | 'lint' | 'migration' | 'browser' | 'manual' | 'static' | 'other'
export type EvidenceKind = 'tool-result' | 'static-analysis' | 'test-result' | 'runtime-check' | 'manual-confirmation'
export type Outcome = 'pass' | 'fail' | 'inconclusive'

export type Evidence = {
  id: string
  requirementIds: string[]
  kind: EvidenceKind
  check: CheckKind
  outcome: Outcome
  timestamp: number
  /** The tool that ran (`Bash`, `mcp__playwright__browser_snapshot`, `person`). */
  source: string
  summary: string
  /** Redacted, length-bounded command line. */
  command?: string
  /** Why the outcome is what it is: `exit 0`, `exit non-zero`, `denied`, `synthetic`, ... */
  basis: string
  /** Paths the command targeted; empty means the whole project. */
  scope: string[]
  counts?: { passed: number; failed: number; skipped: number }
  truncated?: boolean
  /** Answered by a plugin, not by the tool: never proof of execution. */
  synthetic?: boolean
  cwd?: string
  revision?: string
  agentId?: string
  /** The task's change sequence when this evidence was recorded. */
  seq: number
  artifactPath?: string
}

export type Freshness = 'fresh' | 'stale' | 'unrelated'

export type FileState = {
  path: string
  created: boolean
  deleted: boolean
  firstSeq: number
  lastSeq: number
  changes: number
  hash?: string
  /** Literal `/api/...` endpoints the file calls, for the cross-file endpoint check. */
  calls?: { path: string; line: number }[]
  /** The endpoint a route file serves (`app/api/events/route.ts` → `/api/events`). */
  route?: string
}

export type Severity = 'high' | 'medium' | 'low' | 'info'
/** `confirmed`: deterministic proof; `potential`: suspicious, needs a look; `expected`: matches the contract (a prototype's mock). */
export type Confidence = 'confirmed' | 'potential' | 'expected'
export type FindingStatus = 'open' | 'acknowledged' | 'waived' | 'resolved'

export type Finding = {
  id: string
  ruleId: string
  system: 'mirage' | 'drift' | 'policy'
  category: string
  file: string
  line: number
  snippet: string
  explanation: string
  evidence: string
  severity: Severity
  confidence: Confidence
  requirementIds: string[]
  verify: string
  status: FindingStatus
  waiver?: { reason: string; at: number }
  firstSeq: number
  lastSeq: number
}

export type ClaimKind =
  | 'tests-pass' | 'build' | 'typecheck' | 'lint' | 'migration' | 'implemented'
  | 'production-ready' | 'responsive' | 'browser' | 'live-data' | 'works'
export type ClaimVerdict = 'supported' | 'partial' | 'unsupported' | 'contradicted' | 'not-assessable'

export type Claim = {
  id: string
  turnId: string
  text: string
  kind: ClaimKind
  verdict: ClaimVerdict
  reason: string
  evidenceIds: string[]
  at: number
}

export type ActivityKind =
  | 'task' | 'contract' | 'approval' | 'requirement' | 'evidence' | 'invalidated'
  | 'finding' | 'resolved' | 'waiver' | 'claims' | 'mode' | 'turn'
export type Activity = { at: number; kind: ActivityKind; text: string }

export type Task = {
  id: string
  createdAt: number
  updatedAt: number
  contract: Contract
  evidence: Evidence[]
  files: Record<string, FileState>
  findings: Finding[]
  claims: Claim[]
  activity: Activity[]
  /** Monotonic count of observed source changes; evidence freshness is measured against it. */
  seq: number
  /** Keys of hints already shown, so a repeat never toasts twice. */
  notified: string[]
  nextEvidence: number
}

export type ProjectRecord = {
  schema: 1
  key: string
  label: string
  /** Bumped on every write; a writer that finds another rev merges instead of overwriting. */
  rev: number
  writer: string
  updatedAt: number
  activeTaskId?: string
  mode: Mode
  tasks: Record<string, Task>
}

/** A hint the adapter may show, already deduplicated by the engine. */
export type Hint = { key: string; level: 'important' | 'info'; text: string }

/** One observed tool call, normalised by the adapter from `tool.call`. */
export type ToolObservation = {
  tool: string
  input: Record<string, unknown>
  /** Core's answer had `ref`: the tool really ran. */
  ranInCore: boolean
  denied?: string
  isError: boolean
  text: string
  result: unknown
  cwd?: string
  revision?: string
  agentId?: string
}

export type FileChange = {
  path: string
  kind: 'create' | 'update' | 'delete'
  /** The file's text after the change, when known (Write content, a read after Edit). */
  after?: string
  /** The text before, when the tool reported it. */
  before?: string | null
}
