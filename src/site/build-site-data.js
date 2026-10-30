/**
 * Site data builder — runs the data pipeline without vite.
 *
 * `siteContentPlugin` (`./plugin.js`) emits site data inside vite's
 * `generateBundle` hook, on the bundle lane, where vite builds a JS bundle for
 * a static host. `uniweb build --link`, which `uniweb publish` runs, needs no
 * bundle: what `publish` sends a backend carries no JS. The content goes over
 * the sync wire, read from the site's source files (`../uwx/`), and the site
 * names its foundation by registered version.
 *
 * ⛔ *Until 2026-10-19 this said a Uniweb-hosted site "is rendered by the worker
 * using its own runtime" — a statement about a host, which framework cannot
 * make (the note under `site-content.json` below).*
 *
 * This function is the shared data-emission core used by the link-mode
 * pipeline. The vite plugin keeps its own emission for the bundle-mode
 * path (where the static-host extras — sitemap, robots, search-index,
 * `llms.txt` and the `.md` projections, `_pages/*` for split content — are
 * actually consumed). Both paths use
 * the same underlying building blocks (`collectSiteContent`,
 * `processQueries`, etc.), so behavior stays consistent without forcing
 * one path through the other's lifecycle. Media processing — WebP copies and
 * video posters — is the bundle path's alone (below).
 */

import { writeFile, mkdir, cp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { resolveDefaultLocale, DATA_DIR } from '@uniweb/core'
import { collectSiteContent } from './content-collector.js'
import { processQueries, writeQueryFiles } from './query-processor.js'
import { resolveRecordsDir } from './entity-pool.js'

/**
 * Build the site data for `uniweb build --link`, which `uniweb publish` runs.
 * `publish` reads two things back from `distDir`: the files of the queries that
 * have no data schema, which it uploads, and the languages to make live.
 *
 * Emits to `distDir`:
 *   - `site-content.json` — full content tree, sections always inlined.
 *     `publish` reads the languages to make live from it and from the
 *     `<locale>/site-content.json` files beside it (`languagesFromContent`);
 *     the content itself goes over the sync wire, built from source.
 *     ⛔ *Until 2026-10-19 this said the deploy CLI shipped this file as
 *     `payload.locales[default]`.*
 *
 *     ⛔ Ship FULL sections; never strip them per the split-content rule.
 *     A stripped manifest is what prerender emits for static-host bundles,
 *     and a consumer that re-derives split content from the full payload
 *     would mis-detect split and serve broken pages.
 *
 *     ⚠️ This used to justify the rule by stating what the receiving host
 *     does with the payload. Removed 2026-08-18: the description was
 *     accurate about one deployment and false about another, and both were
 *     live at once — so naming "the worker" was wrong even though the
 *     sentence was true somewhere. The framework has no host client and no
 *     knowledge of hosts; we cannot tell consumers apart and must not write
 *     as though we can.
 *
 *     ⇒ The rule stands on its own: we do not know which consumers
 *     re-derive, so we always ship enough for the ones that do.
 *   - `data/<query>.json` (+ each record's own file, `data/<query>/<$name>.json`) —
 *     same shape `processQueries` produces today. `publish` uploads the files of
 *     the queries that have no data schema (`collectSchemalessData`).
 *   - `records/<path under the records directory>` — the records' co-located assets, where
 *     the compiled records point.
 *
 * Does NOT emit:
 *   - `assets/<media>` — no media is processed here, and a media ref in
 *     `site-content.json` stays the site's own path. `publish` uploads a
 *     site's media from the site's own files (the CLI's `uploadSiteMedia`), so
 *     processed copies would be built for nothing. ⛔ *Until 2026-10-19 this
 *     lane made WebP copies, video posters and PDF thumbnails into
 *     `dist/assets/` on every publish, and rewrote the refs to them.*
 *   - HTML, JS, CSS, source maps, `_importmap/*` — static-host bundle
 *     artifacts; a host on this lane renders pages itself.
 *   - `_pages/<route>.json` — only meaningful for static-host bundles,
 *     where they are served as files.
 *   - `sitemap.xml`, `robots.txt` — static-host bundle territory.
 *   - ANY search index — neither the single-file `search-index.json` nor the
 *     split `_search/{locale}/*.json`. This lane emitted both until
 *     2026-08-01 and emits neither now; see step 5 for why. A host that
 *     stores the content derives search from it.
 *
 *     ⚠️ This entry claimed the opposite until 2026-08-26 — that link mode
 *     emitted the split files "instead", and named a consumer for them. It
 *     described an emission its own step 5 had already removed, in the
 *     paragraph a reader consults BEFORE the code, and it was read as
 *     evidence by a downstream consumer.
 *   - `llms.txt`, a branch's, or any page's `.md`, in any language — see step 6.
 *     A host that serves the site derives its own from the content.
 *
 * @param {Object} params
 * @param {string} params.siteRoot - Absolute path to the site directory.
 * @param {string} params.distDir - Absolute path to the dist output directory.
 * @param {string} [params.foundationPath] - Absolute path to the foundation
 *   directory, when one exists locally. Used by `collectSiteContent` to
 *   resolve the defaults of the theme variables it declares (its `main.js` `vars`).
 * @param {string} [params.basePath='/'] - Base path prefix for collection URLs.
 * @returns {Promise<{ siteContent: Object, distDir: string }>}
 */
export async function buildSiteData({
  siteRoot,
  distDir,
  foundationPath,
  basePath = '/',
}) {
  if (!siteRoot) throw new Error('buildSiteData: siteRoot is required')
  if (!distDir) throw new Error('buildSiteData: distDir is required')

  const resolvedSiteRoot = resolve(siteRoot)
  const resolvedDistDir = resolve(distDir)

  await mkdir(resolvedDistDir, { recursive: true })

  // 1. Collect content (pages, sections, theme, config, assets manifest).
  //    No vite needed — collectSiteContent is a plain async function.
  //    dropUnpublished: link mode is the build `publish` runs, so it reads
  //    the site as published — hidden pages and their subtree pruned.
  let siteContent = await collectSiteContent(resolvedSiteRoot, { foundationPath, dropUnpublished: true, base: basePath, strict: true })

  // 2. Compile content collections (file-based markdown/yaml/json).
  //    `writeQueryFiles` lands them under `<siteRoot>/public/data/`;
  //    in the vite plugin path that's fine because vite copies
  //    `public/` into `dist/` at build time. The link-mode pipeline
  //    has no vite, so we mirror that copy ourselves into
  //    `<distDir>/data/` — the set the CLI's `site-data-upload` lane walks at
  //    publish time. (This named `uniweb deploy::collectDataFiles` until
  //    2026-08-18; no such function has existed for some time.) Same output bytes, same paths, just
  //    without the vite intermediary.
  if (siteContent.config?.queries) {
    const byQuery = await processQueries(
      resolvedSiteRoot,
      siteContent.config.queries,
      resolveRecordsDir(resolvedSiteRoot, siteContent.config?.paths).rel,
      basePath,
      { locale: resolveDefaultLocale(siteContent.config) ?? null }
    )
    await writeQueryFiles(resolvedSiteRoot, byQuery, siteContent.config.queries)

    const publicDataDir = join(resolvedSiteRoot, 'public', DATA_DIR)
    const distDataDir = join(resolvedDistDir, DATA_DIR)
    if (existsSync(publicDataDir)) {
      await cp(publicDataDir, distDataDir, { recursive: true })
    }

    // ⭐ AND THE RECORDS' CO-LOCATED ASSETS — `public/records/<path under records/>`,
    // where the compiled records point (`/records/…`), mirrored the way vite mirrors
    // all of `public/` on the bundle lane. ⛔ Until 2026-09-14 only `public/data` was
    // copied, so a record's image URL named a file this lane's `dist/` did not have.
    const publicRecordsDir = join(resolvedSiteRoot, 'public', 'records')
    if (existsSync(publicRecordsDir)) {
      await cp(publicRecordsDir, join(resolvedDistDir, 'records'), { recursive: true })
    }
  }

  // 3. No media processing (header, "Does NOT emit"). The collector's asset
  //    manifest is internal, so it is dropped — as the vite plugin drops it
  //    when processing is off.
  let finalContent = { ...siteContent }
  delete finalContent.assets

  // Strip internal-only properties that don't serialize (Sets don't
  // JSON-roundtrip): the collector records them for media processing.
  delete finalContent.hasExplicitPoster

  // ⛔ `config.icons` is a HOST-owned slot on this lane — drop it.
  //
  // This is the build for a backend (link mode is what `uniweb publish` runs),
  // and `config` is site.yml spread whole, so an author's `icons.base` would
  // otherwise sit in a slot the host is supposed to fill. The icon base is a
  // property of the DEPLOYMENT, identical for every site a given backend
  // serves — not something one site gets to choose [Diego, 2026-08-17].
  // ⛔ *Until 2026-10-19 this said the payload "only ever goes to a backend":
  // `publish` reads it for its languages, and sends the content over the sync
  // wire, which never had this exposure (below).*
  //
  // The reason it cannot be a site's call is that the base and the NAMESPACE
  // are coupled: icon filenames are minted by whoever built the corpus, so
  // content carrying one host's names 404s wholesale against a different base.
  // A site-level override here is a broken site, not a preference.
  //
  // The sync lane never had this exposure — `uwx/site.js` builds `info.*` from
  // a key-by-key allowlist with no `icons` entry. This makes the two agree.
  // `site.yml::icons` stays fully live on the bundled/static lanes, which have
  // no host to ask.
  //
  // Rebuilt rather than mutated: `finalContent` is sometimes `siteContent`
  // itself, and `config` is shared by reference through the shallow copies
  // above.
  if (finalContent.config?.icons !== undefined) {
    const { icons: _hostOwnedIcons, ...configWithoutIcons } = finalContent.config
    finalContent = { ...finalContent, config: configWithoutIcons }
  }

  // 4. Write `dist/site-content.json` with FULL sections inlined.
  //    Important: do NOT strip sections per the split-content rule here.
  //    Stripping would silently break split-mode sites on any consumer that
  //    re-derives split content from the full payload. See the header for
  //    why this no longer names one.
  const contentPath = join(resolvedDistDir, 'site-content.json')
  await writeFile(contentPath, JSON.stringify(finalContent, null, 2))

  // 5. (removed 2026-08-01) This lane used to emit a search index — the split
  //    `_search/{locale}/*.json` for a server, and `search-index.json` for the
  //    browser — gated by `features: [search]`.
  //
  //    Both are gone because only ONE of the two publishers produced them. A
  //    CLI deploy did; a CMS publish did not, so a site's search existed or
  //    vanished depending on who published it last. That is the flicker rule,
  //    and the fix is not to make the app produce them too — it is that a host
  //    storing the content derives search from it, one input that exists
  //    identically on both lanes.
  //
  //    The browser one was doubly dead: nothing ever uploaded it. `dist/` on
  //    this lane reaches a backend only through the data ball and the media
  //    refs, and the ball read `dist/data` and `dist/_search` — never the dist
  //    root. So it was serialized on every publish and dropped.
  //
  //    ⚠️ The static index for hosts with NO backend is untouched and still
  //    emitted by the bundle lane (`site/plugin.js` → `search-index.json`).
  //    That is what GitHub Pages and every other static target serve, and the
  //    framework has more targets than one backend.

  // 6. (removed 2026-10-25) This lane wrote `llms.txt` and a `.md` per page, for the default
  //    language only, on the ground that both lanes publish a site. Nothing read them: `publish`
  //    reads the schema-less query files and the languages, and a host that serves the site
  //    derives its projections from the content, as it derives its search. The static host’s are
  //    the bundle lane’s, in every language (`./projections.js`).

  return { siteContent: finalContent, distDir: resolvedDistDir }
}
