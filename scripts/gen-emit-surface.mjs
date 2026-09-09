#!/usr/bin/env node
/**
 * Generate `src/uwx/emit-surface.json` — the published statement of which site.yml
 * keys this package emits into which Section of the `@uniweb/site-content`
 * document.
 *
 * ⭐ WHY IT IS PUBLISHED. A consumer that stores the document must declare
 * every key we can emit: a key in a Section the consumer's model does not
 * declare is refused WHOLE, not degraded. Without a published statement the
 * consumer keeps a hand-maintained copy of our emit — which is a cache with no
 * invalidation, and it has gone stale twice.
 *
 * ⛔ IT IS A CAPABILITY STATEMENT, NOT A PAYLOAD ONE, which is why it cannot
 * ride the wire. The question is "what can this producer ever emit?" — a given
 * document shows only the keys that one site happened to declare.
 *
 * ⭐ DERIVED FROM THE PRODUCER SOURCE, never hand-written. Static extraction is
 * exhaustive where a fixture-derived contract is not: `_contracts/surface`
 * derives its `wire.json` by walking a real document, so it states only what
 * the fixture exercises — measured 2026-09-09 at 6 of 19 `settings` keys. That
 * is the failure this file exists to avoid, so it must not be reintroduced by
 * generating from a sample.
 *
 * ⚠️ AND STATIC EXTRACTION HAS THE MIRROR-IMAGE WEAKNESS: it reads the emit
 * PATTERNS below, so an emit written some other way is missed SILENTLY. Two
 * guards, and neither is optional:
 *   - `build/tests/emit-surface.test.js` regenerates and diffs (this file is
 *     checked in, so drift fails the suite).
 *   - `_contracts/emit-surface-covers-the-wire.test.js` walks a REAL document
 *     and asserts this file is a SUPERSET of it — the runtime check that
 *     catches a pattern this script cannot see.
 *
 * Run: node scripts/gen-emit-surface.mjs [--check]
 *   --check  exit 1 on drift instead of writing (what the test uses)
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = dirname(HERE)
const PRODUCER = join(PKG, 'src/uwx/site.js')
const OUT = join(PKG, 'src/uwx/emit-surface.json')

const SCHEMA_VERSION = 1

/**
 * Sections whose key set is NOT a fixed list, declared here because that is a
 * structural property of the producer rather than something to read off it.
 *
 * ⛔ The roster is still drift-guarded: every `doc.<name> =` in the producer
 * must appear here and vice versa (`reconcileSections` below), so adding a
 * Section without classifying it fails rather than passing silently.
 */
const NON_CLOSED = {
  // Author keys copied verbatim — `serviceRecords` has no allowlist, by
  // design: an unrecognized key is the consumer's to judge, not ours.
  // ⛔ A consumer MUST NOT assert a closed key set for these.
  services: { kind: 'passthrough', authoredAs: 'site.yml::$services' },
  secrets: { kind: 'passthrough', authoredAs: 'site.yml::$secrets' },
  // Content records with their own field shapes — not site.yml config keys.
  pages: { kind: 'records' },
  layout_sections: { kind: 'records' },
  extensions: { kind: 'records' },
  queries: { kind: 'records' }
}

// Sections built by scanning the producer for their key emits. The value is
// the variable the producer accumulates into.
const CLOSED = ['info', 'settings']

// Keys the document carries that are the consumer's own system vocabulary.
const SYSTEM_KEYS = ['$uuid', '$id', '$model']

const src = readFileSync(PRODUCER, 'utf8')

/**
 * Every `site.yml` path an expression reads, as `site.yml::<path>`. An emit
 * may read more than one (`siteYml.fetch ?? fromShorthand(siteYml.data)`), and
 * some read none — a value assembled from a separate file (`theme.yml`,
 * `head.html`) or computed. `null` there is honest: the key exists, its source
 * is not a site.yml key.
 */
function sourcesOf(expr) {
  const out = [...expr.matchAll(/\bsiteYml\.([A-Za-z_$][\w$]*)/g)].map(
    (m) => `site.yml::${m[1]}`
  )
  return out.length ? [...new Set(out)] : null
}

/** Balanced-paren read of one `setIf(<varname>, '<key>', <expr>)` argument list. */
function* setIfCalls(body, varName) {
  const re = new RegExp(`setIf\\(\\s*${varName}\\s*,\\s*'([^']+)'\\s*,`, 'g')
  let m
  while ((m = re.exec(body))) {
    let depth = 1
    let i = re.lastIndex
    while (i < body.length && depth > 0) {
      if (body[i] === '(') depth++
      else if (body[i] === ')') depth--
      i++
    }
    yield { key: m[1], expr: body.slice(re.lastIndex, i - 1) }
  }
}

/** `<varname>.<key> = <expr>` up to the end of the line. */
function* directAssignments(body, varName) {
  const re = new RegExp(`\\b${varName}\\.([A-Za-z_][\\w]*)\\s*=\\s*([^\\n]+)`, 'g')
  let m
  while ((m = re.exec(body))) yield { key: m[1], expr: m[2] }
}

function collectKeys(body, varName) {
  const keys = {}
  for (const { key, expr } of setIfCalls(body, varName)) keys[key] = sourcesOf(expr)
  for (const { key, expr } of directAssignments(body, varName)) {
    if (!(key in keys)) keys[key] = sourcesOf(expr)
  }
  return Object.fromEntries(Object.entries(keys).sort(([a], [b]) => a.localeCompare(b)))
}

/**
 * ⛔ The roster must reconcile with the producer, or this file becomes the
 * hand-maintained list it replaces. Every `doc.<name> =` is either classified
 * above or scanned as closed; anything else is a hard failure.
 */
function reconcileSections() {
  // ⚠️ NOT line-anchored: several Sections are assigned conditionally
  // (`if (settings) doc.settings = settings`), so `doc.` is mid-line. An
  // anchored match silently saw six of nine — caught by this guard on its
  // first run, which is the argument for having it.
  const emitted = new Set(
    [...src.matchAll(/\bdoc\.(\$?[A-Za-z_][\w$]*)\s*=[^=]/g)].map((m) => m[1])
  )
  const classified = new Set([...CLOSED, ...Object.keys(NON_CLOSED), ...SYSTEM_KEYS])
  const unclassified = [...emitted].filter((s) => !classified.has(s))
  if (unclassified.length) {
    throw new Error(
      `emit-surface: the producer emits Section(s) this generator does not classify: ` +
        `${unclassified.join(', ')}.\n` +
        `  Add each to CLOSED (a fixed key set) or NON_CLOSED (passthrough / records) ` +
        `in scripts/gen-emit-surface.mjs.`
    )
  }
  const missing = [...classified].filter((s) => !emitted.has(s))
  if (missing.length) {
    throw new Error(
      `emit-surface: classified Section(s) no longer emitted by the producer: ` +
        `${missing.join(', ')}. Remove them from the generator.`
    )
  }
}

function build() {
  reconcileSections()

  const sections = {}
  for (const name of CLOSED) {
    // `settings` is one function; `info` is assembled inline across the
    // producer, so scan the whole file and rely on the variable name.
    const body =
      name === 'settings'
        ? src.match(/function settingsNested\([\s\S]*?\n}/)?.[0]
        : src
    if (!body) throw new Error(`emit-surface: could not locate the ${name} producer`)
    const keys = collectKeys(body, name)
    if (Object.keys(keys).length === 0) {
      throw new Error(
        `emit-surface: extracted ZERO keys for \`${name}\` — the emit pattern changed ` +
          `and this script can no longer see it. Fix the extractor; do not ship an empty set.`
      )
    }
    sections[name] = { kind: 'closed', keys }
  }
  for (const [name, meta] of Object.entries(NON_CLOSED)) sections[name] = meta

  return {
    schemaVersion: SCHEMA_VERSION,
    model: '@uniweb/site-content',
    producer: '@uniweb/build/src/uwx/site.js',
    kinds: {
      closed: 'A fixed key set. Every key is listed; a consumer may assert it.',
      passthrough:
        'Author keys copied verbatim, with no allowlist. ⛔ No closed key set exists — a consumer must NOT assert one.',
      records: 'Content records with their own field shapes, not site.yml config keys.'
    },
    systemKeys: SYSTEM_KEYS,
    sections
  }
}

const next = build()
const serialized = JSON.stringify(next, null, 2) + '\n'

if (process.argv.includes('--check')) {
  let current = null
  try {
    current = readFileSync(OUT, 'utf8')
  } catch {}
  if (current !== serialized) {
    console.error(
      'emit-surface.json is out of date — run `node scripts/gen-emit-surface.mjs`.'
    )
    process.exit(1)
  }
  console.log('emit-surface.json is current.')
} else {
  writeFileSync(OUT, serialized)
  const closed = CLOSED.map(
    (s) => `${s} ${Object.keys(next.sections[s].keys).length}`
  ).join(', ')
  console.log(`emit-surface.json written — ${closed}`)
}
