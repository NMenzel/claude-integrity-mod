// The world beneath the plugin in tests: a repository on disk (in memory), a
// session, a store, a clock, and the UI calls recorded. Every answer is
// deterministic; nothing touches a real file system, network or process.

import type { CommandRunInput, On, ToolCallResult } from 'claude-code'
import { mock, type MockClock } from 'claude-code/testing'

export type World = {
  clock: MockClock
  /** The plugin's `$.store`, inspectable. */
  store: Map<string, unknown>
  files: Map<string, string>
  written: Map<string, string>
  status: (string | undefined)[]
  toasts: string[]
  logs: string[]
  opened: string[]
  /** Names passed to `$.command.register`. */
  commands: string[]
  argv: string[][]
  /** What the test's tool.call hook answers next, standing in for core. */
  answer: (e: Record<string, unknown>) => ToolCallResult
}

export const ROOT = '/repo/app'

const posix = (path: string): string => path.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/')

export function world(on: On, opts: { root?: string; remote?: string | null; store?: Record<string, unknown>; files?: Record<string, string> } = {}): World {
  const root = opts.root ?? ROOT
  const w: World = {
    clock: mock.clock(on, { now: 1_760_000_000_000 }),
    store: new Map(Object.entries(opts.store ?? {}).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))])),
    files: new Map(Object.entries(opts.files ?? {}).map(([k, v]) => [`${root}/${k}`, v])),
    written: new Map(),
    status: [], toasts: [], logs: [], opened: [], commands: [], argv: [],
    answer: () => ({ ref: 1, result: { stdout: '', stderr: '', interrupted: false }, text: '' }),
  }
  // A store the test can read back; values cross as JSON, as the engine's do.
  on('store.get', ($, e) => ({ value: w.store.has(e.key) ? JSON.parse(JSON.stringify(w.store.get(e.key))) : undefined }))
  on('store.set', ($, e) => (w.store.set(e.key, JSON.parse(JSON.stringify(e.value))), { value: undefined }))
  on('store.delete', ($, e) => (w.store.delete(e.key), { value: undefined }))
  on('store.keys', () => ({ value: [...w.store.keys()] }))
  on('session.repo', () => ({ value: { root, remote: opts.remote === undefined ? 'git@example.org:acme/app.git' : opts.remote, internal: false, name: null } }))
  on('session.root', () => ({ value: root }))
  on('session.cwd', () => ({ value: root }))
  on('session.id', () => ({ value: 'session-1' }))
  on('command.register', ($, e) => (w.commands.push(e.name), { value: { command: e.name } }))
  on('ui.status', ($, e) => (w.status.push(e.text), { value: undefined }))
  on('ui.toast', ($, e) => (w.toasts.push(e.text), { value: undefined }))
  on('ui.log', ($, e) => (w.logs.push(e.text), { value: undefined }))
  on('ui.open', ($, e) => (w.opened.push(e.id), { value: { isPlaced: true as const } }))
  on('ui.close', () => ({ value: undefined }))
  // The engine resolves paths natively before raising fs events (`C:\repo\app\x` on Windows): key by the POSIX form.
  on('fs.read', ($, e) => {
    const text = w.files.get(posix(e.path))
    return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
  })
  on('fs.exists', ($, e) => ({ value: w.files.has(posix(e.path)) }))
  on('fs.write', ($, e) => (w.written.set(posix(e.path), e.text), { value: undefined }))
  on('process.run', ($, e) => {
    w.argv.push([...e.argv])
    const stdout = e.argv.includes('rev-parse') ? 'abc1234\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', ($, e) => w.answer(e as unknown as Record<string, unknown>))
  // The engine's own core for the lifecycle events: echo, as core does.
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 'session-1' }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  return w
}

/** Core's answer to a Bash call: exit 0 unless `isError`, with the runner's output. */
export const bash = (stdout: string, isError = false, extra: Record<string, unknown> = {}): ToolCallResult =>
  (isError
    ? { ref: 1, isError: true, result: stdout, text: `Error: Exit code 1\n${stdout}` }
    : { ref: 1, result: { stdout, stderr: '', interrupted: false, ...extra }, text: stdout }) as ToolCallResult

export const write = (type: 'create' | 'update', originalFile: string | null = null): ToolCallResult =>
  ({ ref: 1, result: { type, filePath: '', content: '', structuredPatch: [], originalFile }, text: 'ok' }) as ToolCallResult

export const PANE = { plugin: 'integrity', component: 'Pane' as const, requestId: 'integrity' }

export const paneProps = (bodyColumns: number, placement: 'dock' | 'inline' = 'dock') => ({
  title: 'Integrity', isFocused: true, bodyColumns, placement,
  scroll: { offset: 0, bodyRows: 30 }, view: {},
})

/** `command.run`'s input as the person typing `/command args` makes it. */
export const cmd = (command: string, args = '', isFullscreen = false): CommandRunInput =>
  ({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen, columns: 120 } })

export const START = { cwd: ROOT, surface: 'terminal' as const, isInteractive: true }
