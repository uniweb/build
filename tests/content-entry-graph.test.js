/**
 * What `@uniweb/build/content` loads.
 *
 * The entry exists for a host with no native modules and no bundler: a standalone binary
 * compiled from it has no `sharp` to load, and a module on its chain that imports one at the
 * top stops that binary starting, on every command. So the promise in its header is enforced,
 * over the real import graph, so that it fails on a transitive import and not only a direct one.
 *
 * Only what loads with the entry counts: an `import()` runs when it is reached, and whoever
 * reaches one decides what to do without it.
 */

import { readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'content', 'index.js')

/** What the entry's header promises it does not bring. */
const REFUSED = ['sharp', 'vite', 'react', 'react-dom']

function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** The specifiers a file imports or re-exports when it loads. */
function staticSpecifiers(source) {
  const code = stripComments(source)
  const found = []
  for (const pattern of [
    /(?:^|[\n;])\s*import\s+[^'"();]*?from\s*['"]([^'"]+)['"]/g,
    /(?:^|[\n;])\s*export\s+[^'"();]*?from\s*['"]([^'"]+)['"]/g,
    /(?:^|[\n;])\s*import\s*['"]([^'"]+)['"]/g,
  ]) {
    for (const match of code.matchAll(pattern)) found.push(match[1])
  }
  return found
}

function resolveRelative(from, specifier) {
  const target = resolve(dirname(from), specifier)
  if (existsSync(target) && statSync(target).isFile()) return target
  for (const candidate of [`${target}.js`, join(target, 'index.js')]) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`${from} imports ${specifier}, which does not resolve`)
}

/** Each bare package the entry's own chain loads, with the file that first loads it. */
function packagesLoadedBy(entry) {
  const seen = new Set([entry])
  const queue = [entry]
  const packages = new Map()
  while (queue.length) {
    const file = queue.shift()
    for (const specifier of staticSpecifiers(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('.')) {
        const next = resolveRelative(file, specifier)
        if (!seen.has(next)) {
          seen.add(next)
          queue.push(next)
        }
      } else if (!packages.has(specifier)) {
        packages.set(specifier, file)
      }
    }
  }
  return packages
}

describe('@uniweb/build/content', () => {
  const loaded = packagesLoadedBy(ENTRY)

  it.each(REFUSED)('does not load %s', (name) => {
    const hits = [...loaded.entries()]
      .filter(([specifier]) => specifier === name || specifier.startsWith(`${name}/`))
      .map(([specifier, file]) => `${specifier} from ${file}`)
    expect(hits).toEqual([])
  })

  it('reads the chain it is checking', () => {
    // A control: an instrument that found nothing would pass the checks above.
    expect(loaded.has('@uniweb/semantic-parser')).toBe(true)
    expect(loaded.has('js-yaml')).toBe(true)
  })
})
