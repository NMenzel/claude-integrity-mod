// Small pure helpers: hashing, paths, globs and redaction.

/** cyrb53: a fast, deterministic 53-bit string hash, hex. Not cryptographic; identity only. */
export function hash(text: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0')
}

export function newId(prefix: string, now: number): string {
  return `${prefix}-${now.toString(36)}-${Math.floor(Math.random() * 1679616).toString(36).padStart(4, '0')}`
}

const CODE_EXT = /\.(c|m)?(t|j)sx?$|\.(py|go|rs|java|kt|rb|php|cs|swift|vue|svelte|sql|prisma)$/i
const DOC_EXT = /\.(md|mdx|txt|rst|adoc)$|(^|\/)(LICENSE|CHANGELOG)[^/]*$/i
const TEST_PATH = /(^|\/)(__tests__|tests?|spec|e2e|__mocks__)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$/i

export const isCodePath = (path: string): boolean => CODE_EXT.test(path)
export const isDocPath = (path: string): boolean => DOC_EXT.test(path)
export const isTestPath = (path: string): boolean => TEST_PATH.test(path)
export const isScannable = (path: string): boolean => /\.(c|m)?(t|j)sx?$/i.test(path)

/** Forward slashes, and relative to `root` when inside it (compared case-insensitively for Windows drives). */
export function normalizePath(path: string, root?: string): string {
  const p = path.replace(/\\/g, '/')
  if (root === undefined || root === '') return p
  const r = root.replace(/\\/g, '/').replace(/\/$/, '')
  return p.toLowerCase().startsWith(r.toLowerCase() + '/') ? p.slice(r.length + 1) : p
}

/** `**` any depth, `*` within a segment, `?` one character. A pattern without `/` matches the base name too. */
export function globToRegExp(glob: string): RegExp {
  const g = glob.replace(/\\/g, '/').replace(/^\.\//, '')
  let out = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i] as string
    if (c === '*' && g[i + 1] === '*') {
      out += g[i + 2] === '/' ? '(?:.*/)?' : '.*'
      i += g[i + 2] === '/' ? 2 : 1
    } else if (c === '*') out += '[^/]*'
    else if (c === '?') out += '[^/]'
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(g.includes('/') ? `^${out}$` : `(^|/)${out}$`, 'i')
}

export const matchesGlob = (path: string, glob: string): boolean => globToRegExp(glob).test(path.replace(/\\/g, '/'))

/** Looks like a path glob rather than prose: has a slash, a star or a file extension, and no spaces. */
export const isPathPattern = (text: string): boolean => !/\s/.test(text.trim()) && /[/*]|\.\w{1,5}$/.test(text.trim())

const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[private key]'],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, '[aws key]'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, '[github token]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, '[slack token]'],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[api key]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[jwt]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***'],
  [/(\/\/)[^/\s:@]+:[^/\s@]+@/g, '$1***:***@'],
  [/\b([A-Za-z0-9_]*(?:api[_-]?key|token|secret|passw(?:or)?d|pwd|credential|auth)[A-Za-z0-9_]*)(\s*[:=]\s*|\s+)("[^"]*"|'[^']*'|[^\s'"&;|]+)/gi, '$1$2***'],
]

/** Removes secrets and personal home paths. Applied to everything stored or exported. */
export function redact(text: string): string {
  let out = text
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement)
  return out
    .replace(/\b[A-Za-z]:[\\/]Users[\\/][^\\/\s]+/gi, '~')
    .replace(/\/(home|Users)\/[^/\s]+/g, '~')
}

export function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : `${one.slice(0, Math.max(0, max - 1))}…`
}

export const sentences = (text: string): string[] =>
  text
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/(?<=[.!?])\s+|\n+/)
    .map(s => s.replace(/^[\s>*\-•\d.)#]+/, '').trim())
    .filter(s => s.length > 3)

/** The store key of a project: its repository root and remote, so two repositories never share a contract. */
export const projectKey = (root: string, remote: string | null | undefined): string =>
  `p:${hash(`${normalizePath(root).replace(/\/$/, '').toLowerCase()}|${remote ?? ''}`)}`
