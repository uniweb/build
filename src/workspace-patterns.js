// THE WORKSPACE'S PACKAGES, READ AS PNPM READS THEM: the reading half of the CLI's
// `utils/workspace-packages.js`, in a module of its own, so that `@uniweb/build` holds the same rule
// without either package importing the other.
//
// ⛔ THIS FILE IS MIRRORED, BYTE FOR BYTE: `framework/cli/src/utils/workspace-patterns.js` and
// `framework/build/src/workspace-patterns.js`. The CLI's startup path reads it before any project,
// and so any `@uniweb/build`, is installed; the build reads it to find a data schema another package
// of the workspace defines (`foundation/shared-types.js`). Edit one and copy it over the other:
// `_contracts/workspace-patterns-mirror.test.js` fails until they match.
//
// A workspace lists its packages as folder patterns: `packages:` in pnpm-workspace.yaml, or
// `workspaces` in package.json for npm and yarn. Patterns are read as pnpm reads them: `*`, `?` and
// `[...]` within one folder name, `**` for any depth, `{a,b}` for alternatives, and a leading `!` to
// exclude what the other patterns match. A folder a wildcard finds counts when it holds a
// package.json, as pnpm counts it — so `**` never sweeps in a `pages/` or `dist/` folder — and a
// wildcard never enters `node_modules` or a dot-folder. A folder listed by its own path counts if it
// exists: listing it says it is one, and a command that reads content only (`validate`) works on a
// folder with no manifest yet. Any other syntax is refused by name, never read as a path.
//
// Node built-ins and js-yaml only.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'

export const WORKSPACE_FILE = 'pnpm-workspace.yaml'

// Read as the build reads YAML (`build/src/utils/yaml-schema.js`): js-yaml's types without the
// implicit timestamp, so a folder named like a date, `packages: [2025-06-01]`, stays its name instead
// of becoming a Date that the list then drops. Restated here, since this file imports only js-yaml.
const YAML_OPTIONS = Object.freeze({ schema: yaml.CORE_SCHEMA.extend({ implicit: [yaml.types.merge] }) })

// ─── Reading ────────────────────────────────────────────────────────────────

/**
 * The package patterns a workspace declares, and the file they are read from:
 * pnpm-workspace.yaml when the workspace has one, else package.json's `workspaces`.
 *
 * @param {string} rootDir
 * @returns {{ source: string|null, patterns: string[] }}
 */
export function readWorkspacePatterns(rootDir) {
  const ymlPath = join(rootDir, WORKSPACE_FILE)
  if (existsSync(ymlPath)) {
    const doc = yaml.load(readFileSync(ymlPath, 'utf8'), YAML_OPTIONS)
    return { source: WORKSPACE_FILE, patterns: strings(doc?.packages) }
  }
  try {
    const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'))
    if (Array.isArray(pkg.workspaces)) return { source: 'package.json', patterns: strings(pkg.workspaces) }
  } catch {
    // No package.json, or not JSON — a workspace with no packages declared.
  }
  return { source: null, patterns: [] }
}

/**
 * The workspace's packages: the folders its patterns name.
 *
 * @param {string} rootDir
 * @returns {string[]} see {@link resolveWorkspacePackages}
 */
export function workspacePackages(rootDir) {
  return resolveWorkspacePackages(rootDir, readWorkspacePatterns(rootDir).patterns)
}

/**
 * The folders `patterns` name under `rootDir`, as workspace-relative paths in `/`
 * form, each once, in the order of the first pattern that names it — alphabetical
 * within a pattern. A folder a wildcard finds counts only when it holds a
 * package.json; one a pattern names by its own path counts if it exists.
 *
 * @param {string} rootDir
 * @param {string[]} patterns
 * @returns {string[]}
 */
export function resolveWorkspacePackages(rootDir, patterns) {
  const { include, exclude } = parsePatterns(patterns)
  const seen = new Set()
  const out = []
  for (const pattern of include) {
    const byWildcard = pattern.some((segment) => segment === '**' || hasMagic(segment))
    for (const rel of expand(rootDir, pattern, [], 0, [])) {
      // The root is the workspace itself, never one of its packages.
      if (!rel || seen.has(rel)) continue
      if (byWildcard && !existsSync(join(rootDir, rel, 'package.json'))) continue
      if (exclude.some((ex) => matches(ex, rel.split('/')))) continue
      seen.add(rel)
      out.push(rel)
    }
  }
  return out
}

/**
 * Do `patterns` cover the folder at `relPath` — would it be one of the workspace's
 * packages? Answered from the patterns alone, so it holds for a folder about to be
 * created.
 *
 * @param {string[]} patterns
 * @param {string} relPath - workspace-relative
 * @returns {boolean}
 */
export function patternsCover(patterns, relPath) {
  const path = normalizePath(relPath)
  if (!path) return false
  const segments = path.split('/')
  const { include, exclude } = parsePatterns(patterns)
  return (
    include.some((p) => matches(p, segments)) &&
    !exclude.some((p) => matches(p, segments))
  )
}

// ─── Patterns ───────────────────────────────────────────────────────────────

// `@(…)`, `+(…)`, `!(…)`, `*(…)`, `?(…)` — extended globs, which this does not read.
const EXTGLOB = /[@+!*?]\(/
const warned = new Set()

/** Positive and negative patterns as folder-name lists, `{a,b}` expanded. */
function parsePatterns(patterns) {
  const include = []
  const exclude = []
  for (const raw of strings(patterns)) {
    let pattern = raw.trim()
    const negated = pattern.startsWith('!')
    if (negated) pattern = pattern.slice(1)
    if (EXTGLOB.test(pattern)) {
      if (!warned.has(raw)) {
        warned.add(raw)
        process.stderr.write(
          `⚠ uniweb does not read the workspace pattern "${raw}" (extended glob syntax) — ` +
            `list the folders it stands for instead.\n`
        )
      }
      continue
    }
    for (const one of expandBraces(pattern)) {
      const path = normalizePath(one)
      if (path) (negated ? exclude : include).push(path.split('/'))
    }
  }
  return { include, exclude }
}

/** `a/{b,c}/d` → `a/b/d`, `a/c/d`; nested lists expand innermost first. */
function expandBraces(pattern) {
  const m = /\{([^{}]*)\}/.exec(pattern)
  if (!m) return [pattern]
  const options = m[1].split(',')
  // `{x}` lists nothing to choose between: a literal brace, as in pnpm.
  if (options.length < 2) return [pattern]
  const head = pattern.slice(0, m.index)
  const tail = pattern.slice(m.index + m[0].length)
  return options.flatMap((o) => expandBraces(head + o + tail))
}

/** `./a//b/` → `a/b`; `\` becomes `/`; `.` and `` are the root. */
function normalizePath(path) {
  let s = String(path).replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  while (s.startsWith('./')) s = s.slice(2)
  s = s.replace(/^\/+/, '').replace(/\/+$/, '')
  return s === '.' ? '' : s
}

const hasMagic = (segment) => /[*?[]/.test(segment)

/** Can a wildcard step into this folder? Never `node_modules`, never a dot-folder. */
const wildcardMayEnter = (name) => !name.startsWith('.') && name !== 'node_modules'

const regexCache = new Map()

/** One folder-name pattern as a regex: `*`, `?` and `[...]`, everything else literal. */
function segmentRegex(segment) {
  let re = regexCache.get(segment)
  if (re) return re
  let src = ''
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]
    if (c === '*') src += '[^/]*'
    else if (c === '?') src += '[^/]'
    else if (c === '[' && segment.indexOf(']', i + 2) > i) {
      const end = segment.indexOf(']', i + 2)
      let body = segment.slice(i + 1, end).replace(/\\/g, '\\\\')
      if (body.startsWith('!')) body = `^${body.slice(1)}`
      src += `[${body}]`
      i = end
    } else src += c.replace(/[.+^$(){}|\\[\]]/g, '\\$&')
  }
  re = new RegExp(`^${src}$`)
  regexCache.set(segment, re)
  return re
}

function segmentMatches(segment, name) {
  if (!hasMagic(segment)) return segment === name
  // A wildcard does not match a dot-folder unless the pattern spells the dot.
  if (name.startsWith('.') && !segment.startsWith('.')) return false
  if (name === 'node_modules') return false
  return segmentRegex(segment).test(name)
}

/** Does the folder-name list `path` match the pattern `pattern`? `**` is any depth. */
function matches(pattern, path, i = 0, j = 0) {
  if (i === pattern.length) return j === path.length
  if (pattern[i] === '**') {
    for (let k = j; k <= path.length; k++) {
      if (k > j && !wildcardMayEnter(path[k - 1])) break
      if (matches(pattern, path, i + 1, k)) return true
    }
    return false
  }
  if (j === path.length || !segmentMatches(pattern[i], path[j])) return false
  return matches(pattern, path, i + 1, j + 1)
}

/** The folders under `rootDir` that `pattern` names, found on disk. */
function expand(rootDir, pattern, base, i, out) {
  if (i === pattern.length) {
    out.push(base.join('/'))
    return out
  }
  const segment = pattern[i]
  const here = join(rootDir, ...base)
  if (segment === '**') {
    expand(rootDir, pattern, base, i + 1, out)
    // Real folders only: a symlink back up the tree would never end.
    for (const name of subfolders(here, { followLinks: false })) {
      if (wildcardMayEnter(name)) expand(rootDir, pattern, [...base, name], i, out)
    }
    return out
  }
  if (!hasMagic(segment)) {
    if (segment === '.') return expand(rootDir, pattern, base, i + 1, out)
    if (isFolder(join(here, segment))) expand(rootDir, pattern, [...base, segment], i + 1, out)
    return out
  }
  for (const name of subfolders(here)) {
    if (segmentMatches(segment, name)) expand(rootDir, pattern, [...base, name], i + 1, out)
  }
  return out
}

function subfolders(dir, { followLinks = true } = {}) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter(
      (e) => e.isDirectory() || (followLinks && e.isSymbolicLink() && isFolder(join(dir, e.name)))
    )
    .map((e) => e.name)
    .sort()
}

function isFolder(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export function strings(list) {
  return Array.isArray(list) ? list.filter((v) => typeof v === 'string') : []
}
