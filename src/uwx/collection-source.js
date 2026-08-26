// Read a file-based collection's ORIGINAL source records for sync — the author's
// files, untouched. This is deliberately NOT `processCollections`
// (`build/src/site/collection-processor.js`): that is the DELIVERY pipeline that
// builds `public/data/<name>.json` — it converts markdown bodies to ProseMirror,
// derives excerpt/image, rewrites asset paths, and copies files into
// `public/collections/`. Sync carries the source, so it must read the source:
// raw frontmatter + raw markdown body, raw YAML/JSON mappings, raw BibTeX entries.
// No conversion, no derivation, no filter/sort/limit, no asset side effects.
//
// A collection `.md` is NOT a page-section `.md`: its frontmatter is structured
// DATA whose schema is the collection type's data schema (the `model:` Model), and
// its body is the value of the Model's content body field (a markup `text` field,
// or a `format: prosemirror` json field) — not foundation/runtime config. See
// docs/reference/entity-content.md §"Markdown (frontmatter + body)".

import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, basename, extname, resolve } from 'node:path'
import yaml from 'js-yaml'
import { parseBibtex } from '@citestyle/bibtex'

const SOURCE_EXTENSIONS = new Set(['.md', '.yml', '.yaml', '.json', '.bib'])

/**
 * Split YAML frontmatter from a markdown body. Mirrors the collection
 * processor's split (`---\n` delimited) so a record read here re-renders to the
 * same shape the back-fill writer produces. A file with no frontmatter yields an
 * empty mapping and the whole text as body.
 *
 * @param {string} raw
 * @returns {{ frontmatter: object, body: string }}
 */
export function parseFrontmatter(raw) {
  if (!raw.trimStart().startsWith('---')) {
    return { frontmatter: {}, body: raw }
  }
  const parts = raw.split('---\n')
  if (parts.length < 3) {
    return { frontmatter: {}, body: raw }
  }
  try {
    const frontmatter = yaml.load(parts[1]) || {}
    const body = parts.slice(2).join('---\n')
    return { frontmatter, body }
  } catch {
    return { frontmatter: {}, body: raw }
  }
}

// Format key from a file extension. Single source of the format vocabulary the
// reader emits and the writer dispatches on.
function formatFor(ext) {
  if (ext === '.md') return 'md'
  if (ext === '.json') return 'json'
  if (ext === '.yml' || ext === '.yaml') return 'yaml'
  if (ext === '.bib') return 'bib'
  return null
}

async function readOneFile(filepath) {
  const ext = extname(filepath).toLowerCase()
  const format = formatFor(ext)
  const slugFromName = basename(filepath, ext)
  const raw = await readFile(filepath, 'utf-8')

  if (format === 'md') {
    const { frontmatter, body } = parseFrontmatter(raw)
    const slug = frontmatter.slug || slugFromName
    return [{ slug, format, data: frontmatter, body, sourceFile: filepath, multiRecord: false }]
  }

  if (format === 'bib') {
    // BibTeX always yields an array — the cite key is the slug/$id. Multi-record
    // file → write-back deferred (no natural in-file `$uuid` slot in v1).
    const entries = parseBibtex(raw)
    return entries
      .filter((e) => e && e.id)
      .map((e) => ({ slug: e.id, format, data: e, body: undefined, sourceFile: filepath, multiRecord: true }))
  }

  // yaml / json
  const data = format === 'json' ? JSON.parse(raw) : yaml.load(raw)
  if (Array.isArray(data)) {
    // Many records in one file — each carries its own slug. Write-back deferred.
    return data
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({
        slug: item.slug,
        format,
        data: item,
        body: undefined,
        sourceFile: filepath,
        multiRecord: true,
      }))
  }
  const mapping = data && typeof data === 'object' ? data : {}
  const slug = mapping.slug || slugFromName
  return [{ slug, format, data: mapping, body: undefined, sourceFile: filepath, multiRecord: false }]
}

/**
 * Read every source record in a collection directory, untouched.
 *
 * @param {string} collectionDir - absolute path to the collection folder
 * @returns {Promise<Array<{ slug, format, data, body, sourceFile, multiRecord }>>}
 *   `data` is the raw frontmatter / mapping / entry; `body` is the raw markdown
 *   body (md only, else undefined); `multiRecord` is true for array-form / bib
 *   files (write-back deferred). No delivery processing of any kind.
 */
export async function readCollectionRecords(collectionDir) {
  if (!existsSync(collectionDir)) {
    throw new Error(`uwx/collection-source: collection folder not found: ${collectionDir}`)
  }
  const entries = await readdir(collectionDir, { withFileTypes: true })
  const files = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((f) => !f.startsWith('_') && SOURCE_EXTENSIONS.has(extname(f).toLowerCase()))
    .sort() // stable order — the wire's package digest depends on it

  await reportNestedRecords(collectionDir, entries)

  const records = []
  for (const file of files) {
    const recs = await readOneFile(resolve(collectionDir, file))
    records.push(...recs)
  }
  return records
}

/**
 * Report source records nested below a collection's top level.
 *
 * ⛔ THIS LANE IS FLAT AND THAT IS A CONTRACT, NOT AN OVERSIGHT. The delivery
 * build reads a collection recursively — an author may organise records into
 * branches, and `path` + the `under` predicate address them
 * (`build/src/site/collection-processor.js`). Sync cannot follow yet: the
 * folder shape agreed with the entity store is one level, records as direct
 * leaves of a collection's branch, and going deeper needs that renegotiated
 * with an explicit order axis rather than assumed.
 *
 * ⚠️ The two lanes therefore disagree, and the failure mode is the dangerous
 * shape: a nested record BUILDS and RENDERS locally, then is simply absent from
 * everything the sync produced — no error, no empty result, just a smaller set
 * than the author is looking at. Losing records silently is the one outcome
 * that must not happen, so this says so. It does not throw: a static site with
 * nested collections is completely valid and must keep working, and an author
 * who never syncs should not be blocked by a lane they do not use.
 */
async function reportNestedRecords(collectionDir, entries) {
  const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
  if (dirs.length === 0) return

  const nested = []
  for (const dir of dirs) {
    nested.push(...(await findSourceFiles(resolve(collectionDir, dir.name), dir.name)))
  }
  if (nested.length === 0) return

  const shown = nested.slice(0, 5).join(', ')
  const more = nested.length > 5 ? `, and ${nested.length - 5} more` : ''
  console.warn(
    `[uwx/collection-source] ${nested.length} record(s) below the top level of ` +
      `"${basename(collectionDir)}" are NOT synced: ${shown}${more}. ` +
      `Collection sync is one level deep; these build and render locally but are ` +
      `absent from the synced set. Move them to the collection's top level to sync them.`
  )
}

/** Every source file at or below `dir`, as paths relative to the collection root. */
async function findSourceFiles(dir, rel) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue
    const relPath = `${rel}/${entry.name}`
    if (entry.isDirectory()) out.push(...(await findSourceFiles(resolve(dir, entry.name), relPath)))
    else if (SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) out.push(relPath)
  }
  return out
}
