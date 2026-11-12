/**
 * A foundation's or library's vendor functions — `vendors/<name>.js`, one plain-JS module per file:
 * small pure functions a backend's integration calls by `file#export`, run outside every backend.
 *
 * ```js
 * // src/vendors/courses.js
 * export function grade(input) {
 *   …
 *   return { points, max }
 * }
 * ```
 *
 * ⭐ THE FILE IS SHIPPED AS WRITTEN. Nothing is built, bundled or minified: the bytes on disk are
 * what registers (their `sha256` and `size`) and what is uploaded. So the file must stand alone, and
 * the build refuses what would stop it:
 *
 *   - a file that does not parse as an ES module;
 *   - an `import` (static or dynamic) or an `export … from`: one file is the whole unit;
 *   - a default export: an integration names a function by its name, `file#export`;
 *   - a named export that is not a function, or whose name is not a JavaScript identifier;
 *   - a file that exports no function.
 *
 * And it WARNS, never refuses, of a function that writes to something declared outside itself at
 * the top of the file — `keys[input.quiz] = …`, `cache.set(…)`, `count++` — since a call must change
 * nothing outside itself: one running copy serves many calls, from many sites. Building a table
 * once, at the top of the file, is fine. The check reads names, so a write through another name for
 * the same object gets past it.
 *
 * The limits on a file's size and its number of exports are the registry's to state, and its
 * refusal names them; the build doesn't restate them.
 *
 * Vendors are editor-time only: they ride in `schema.json` as `_vendors` (each file's `exports`) and
 * never reach a page.
 *
 * @module
 */

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'

/** The folder, under a foundation's source root or a library's root. */
export const VENDORS_DIR = 'vendors'

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/**
 * The vendor files a package defines, by name, sorted. A `.js` file is one by being there; a name
 * with a leading `_` is left out.
 *
 * @param {string} srcDir - a foundation's source root, or a library's root
 * @returns {{ name: string, file: string }[]}
 */
export function ownVendorFiles(srcDir) {
  const dir = join(srcDir, VENDORS_DIR)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .sort()
    .filter((file) => extname(file) === '.js' && !file.startsWith('_'))
    .map((file) => ({ name: basename(file, '.js'), file: join(dir, file) }))
}

/**
 * What registers for one file: its bytes' digest and length, as on disk.
 *
 * @param {string} file
 * @returns {{ sha256: string, size: number }}
 */
export function vendorFileDigest(file) {
  const bytes = readFileSync(file)
  return { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }
}

/**
 * Read and check one vendor file.
 *
 * @param {string} file
 * @returns {Promise<{ exports: string[], problems: string[], warnings: string[] }>}
 */
export async function readVendorFile(file) {
  const source = readFileSync(file, 'utf8')
  return checkVendorSource(source)
}

/**
 * Check a vendor module's source. Exported for tests.
 *
 * @param {string} source
 * @returns {Promise<{ exports: string[], problems: string[], warnings: string[] }>}
 */
export async function checkVendorSource(source) {
  const { parseAst } = await import('vite')
  let ast
  try {
    ast = parseAst(source)
  } catch (err) {
    return { exports: [], problems: [`does not parse as a JavaScript module: ${String(err?.message || err).split('\n')[0]}`], warnings: [] }
  }

  const problems = []
  const exported = new Map() // exported name → local name
  const topFunctions = new Set() // top-level names bound to a function
  const topNames = new Set() // every top-level binding

  for (const node of ast.body) {
    const decl = node.type === 'ExportNamedDeclaration' ? node.declaration : node
    if (decl?.type === 'FunctionDeclaration' && decl.id) {
      topFunctions.add(decl.id.name)
      topNames.add(decl.id.name)
    } else if (decl?.type === 'ClassDeclaration' && decl.id) {
      topNames.add(decl.id.name)
    } else if (decl?.type === 'VariableDeclaration') {
      for (const d of decl.declarations) {
        for (const name of patternNames(d.id)) topNames.add(name)
        if (d.id.type === 'Identifier' && isFunctionNode(d.init) && decl.kind === 'const') topFunctions.add(d.id.name)
      }
    }
  }

  for (const node of ast.body) {
    switch (node.type) {
      case 'ImportDeclaration':
        problems.push(`imports \`${node.source.value}\`: a vendor file has no imports. Keep a helper inside the file; a function that needs a package is a real vendor.`)
        break
      case 'ExportAllDeclaration':
        problems.push(`re-exports \`${node.source.value}\`: a vendor file has no imports, so it exports only functions it defines.`)
        break
      case 'ExportDefaultDeclaration':
        problems.push('has a default export: an integration names a function by its name, `file#export`. Export each function by name.')
        break
      case 'ExportNamedDeclaration': {
        if (node.source) {
          problems.push(`re-exports from \`${node.source.value}\`: a vendor file has no imports, so it exports only functions it defines.`)
          break
        }
        const decl = node.declaration
        if (decl?.type === 'FunctionDeclaration') {
          exported.set(decl.id.name, decl.id.name)
        } else if (decl?.type === 'VariableDeclaration') {
          for (const d of decl.declarations) {
            if (d.id.type !== 'Identifier') {
              problems.push('exports a destructured binding: export each function by name.')
            } else if (decl.kind !== 'const' || !isFunctionNode(d.init)) {
              problems.push(`exports \`${d.id.name}\`, which is not a function: a vendor file exports only functions. Keep a table or a constant unexported.`)
            } else {
              exported.set(d.id.name, d.id.name)
            }
          }
        } else if (decl) {
          problems.push(`exports a ${decl.type === 'ClassDeclaration' ? 'class' : 'value'}, which is not a function: a vendor file exports only functions.`)
        }
        for (const spec of node.specifiers || []) {
          const local = spec.local.name ?? spec.local.value
          const name = spec.exported.name ?? spec.exported.value
          if (name === 'default') {
            problems.push('has a default export: an integration names a function by its name, `file#export`. Export each function by name.')
          } else if (!topFunctions.has(local)) {
            problems.push(`exports \`${name}\`, which is not a function the file defines: a vendor file exports only functions.`)
          } else {
            exported.set(name, local)
          }
        }
        break
      }
      default:
        break
    }
  }

  for (const name of exported.keys()) {
    if (!IDENTIFIER.test(name)) {
      problems.push(`exports \`${name}\`, which is not a JavaScript name: an integration names it as \`file#${name}\`.`)
    }
  }

  // Dynamic `import()` anywhere in the file.
  walk(ast, (node) => {
    if (node.type === 'ImportExpression') {
      problems.push('calls `import()`: a vendor file has no imports. Keep a helper inside the file; a function that needs a package is a real vendor.')
    }
  })

  const exports = [...exported.keys()].filter((n) => IDENTIFIER.test(n)).sort()
  if (!exports.length && !problems.length) {
    problems.push('exports no function: export each function an integration calls by name, `export function grade(input) { … }`.')
  }

  return { exports, problems: [...new Set(problems)], warnings: callWrites(ast, topNames) }
}

/**
 * Read and check every vendor file a package defines.
 *
 * @param {string} srcDir - a foundation's source root, or a library's root
 * @param {object} [opts]
 * @param {string} [opts.shownIn] - the folder as its messages name it (a library's is `vendors`)
 * @returns {Promise<{ map: Object<string, { exports: string[] }>, warnings: string[] }>}
 *   `{ '@/<name>': { exports } }`
 * @throws {Error} naming every file that cannot be registered, and why
 */
export async function buildVendorMap(srcDir, { shownIn = `src/${VENDORS_DIR}` } = {}) {
  const files = ownVendorFiles(srcDir)
  const map = {}
  const found = []
  const warnings = []
  for (const { name, file } of files) {
    const at = `${shownIn}/${basename(file)}`
    const { exports, problems, warnings: w } = await readVendorFile(file)
    if (problems.length) found.push(...problems.map((p) => `${at} ${p}`))
    else map[`@/${name}`] = { exports }
    warnings.push(...w.map((x) => `${at}: ${x}`))
  }
  if (found.length) {
    throw new Error(
      found.length === 1
        ? `[uniweb] ${found[0]}`
        : `[uniweb] vendor files that cannot be registered:\n${found.map((f) => `  - ${f}`).join('\n')}`
    )
  }
  return { map, warnings }
}

// --- the call-writes check -----------------------------------------------------------------------

const MUTATORS = new Set(['set', 'add', 'delete', 'clear', 'push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin'])

/**
 * Each place a function writes to a binding declared at the top of the file, by name: an
 * assignment or `++`/`--` whose target is that binding or a member of it, a mutating method call on
 * it (`cache.set(…)`, `list.push(…)`), or `Object.assign` onto it. A name the function declares
 * itself (a parameter, a `let`, a nested function) shadows the top-level one.
 */
function callWrites(ast, topNames) {
  const found = new Set()
  const visit = (node, shadowed, inFunction) => {
    if (!node || typeof node.type !== 'string') return
    if (isFunctionNode(node) || node.type === 'FunctionDeclaration') {
      const local = new Set(shadowed)
      for (const p of node.params) for (const n of patternNames(p)) local.add(n)
      if (node.id?.name && node.type !== 'FunctionDeclaration') local.add(node.id.name)
      for (const n of declaredIn(node.body)) local.add(n)
      visit(node.body, local, true)
      return
    }
    if (inFunction) {
      let target = null
      if (node.type === 'AssignmentExpression') target = node.left
      else if (node.type === 'UpdateExpression') target = node.argument
      else if (node.type === 'UnaryExpression' && node.operator === 'delete') target = node.argument
      else if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
        const prop = node.callee.computed ? null : node.callee.property.name
        if (prop && MUTATORS.has(prop)) target = node.callee.object
        if (prop === 'assign' && rootName(node.callee.object) === 'Object' && node.arguments[0]) target = node.arguments[0]
      }
      const name = target && rootName(target)
      if (name && topNames.has(name) && !shadowed.has(name)) found.add(name)
    }
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end') continue
      const child = node[key]
      if (Array.isArray(child)) for (const c of child) visit(c, shadowed, inFunction)
      else if (child && typeof child.type === 'string') visit(child, shadowed, inFunction)
    }
  }
  visit(ast, new Set(), false)
  return [...found].map(
    (name) =>
      `a function writes to \`${name}\`, which is declared at the top of the file, so it outlives the call. ` +
      'A call must change nothing outside itself: one running copy serves many calls, from many sites. ' +
      'Build a table once at the top of the file, and keep what a call computes inside the call.'
  )
}

function rootName(node) {
  let at = node
  while (at && (at.type === 'MemberExpression' || at.type === 'ChainExpression')) {
    at = at.type === 'ChainExpression' ? at.expression : at.object
  }
  return at?.type === 'Identifier' ? at.name : null
}

/** The names a function body declares at any depth that is still its own (not a nested function's). */
function declaredIn(body) {
  const out = new Set()
  const visit = (node) => {
    if (!node || typeof node.type !== 'string') return
    if (node.type === 'VariableDeclaration') {
      for (const d of node.declarations) for (const n of patternNames(d.id)) out.add(n)
    }
    if (node.type === 'FunctionDeclaration' && node.id) {
      out.add(node.id.name)
      return
    }
    if (node.type === 'ClassDeclaration' && node.id) out.add(node.id.name)
    if (node.type === 'CatchClause' && node.param) for (const n of patternNames(node.param)) out.add(n)
    if (isFunctionNode(node)) return
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end') continue
      const child = node[key]
      if (Array.isArray(child)) child.forEach(visit)
      else if (child && typeof child.type === 'string') visit(child)
    }
  }
  visit(body)
  return out
}

function patternNames(p) {
  if (!p) return []
  switch (p.type) {
    case 'Identifier':
      return [p.name]
    case 'AssignmentPattern':
      return patternNames(p.left)
    case 'RestElement':
      return patternNames(p.argument)
    case 'ArrayPattern':
      return p.elements.flatMap(patternNames)
    case 'ObjectPattern':
      return p.properties.flatMap((prop) => patternNames(prop.type === 'RestElement' ? prop : prop.value))
    default:
      return []
  }
}

function isFunctionNode(node) {
  return node?.type === 'ArrowFunctionExpression' || node?.type === 'FunctionExpression'
}

function walk(node, fn) {
  if (!node || typeof node.type !== 'string') return
  fn(node)
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end') continue
    const child = node[key]
    if (Array.isArray(child)) for (const c of child) walk(c, fn)
    else if (child && typeof child.type === 'string') walk(child, fn)
  }
}
