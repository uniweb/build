/**
 * Site data builder — runs the data pipeline without vite.
 *
 * `siteContentPlugin` (`./plugin.js`) emits site data inside vite's
 * `generateBundle` hook because today's `uniweb build` always goes through
 * vite (to produce a static-host JS bundle). For `uniweb build --link`,
 * the JS bundle is wasted CPU — the deployed Uniweb-hosted site is rendered
 * by the worker using its own runtime + the foundation served from the
 * registry; nothing from the site's vite output reaches the browser.
 *
 * This function is the shared data-emission core used by the link-mode
 * pipeline. The vite plugin keeps its own emission for the bundle-mode
 * path (where the static-host extras — sitemap, robots, search-index,
 * `_pages/*` for split content — are actually consumed). Both paths use
 * the same underlying building blocks (`collectSiteContent`,
 * `processCollections`, `processAssets`, etc.), so behavior stays
 * consistent without forcing one path through the other's lifecycle.
 */

import { writeFile, readFile, mkdir, cp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'

import { resolveDefaultLocale, DATA_DIR } from '@uniweb/core'
import { collectSiteContent } from './content-collector.js'
import { processCollections, writeCollectionFiles } from './collection-processor.js'
import { processAssets, rewriteSiteContentPaths } from './asset-processor.js'
import { processAdvancedAssets } from './advanced-processors.js'
import {
  renderSiteIndex,
  renderPageMarkdown,
  resolveAgentsConfig,
  selectIndexablePages,
  selectIndexBranches,
  pageMarkdownFilename,
  branchIndexFilename,
  INDEX_FILENAME
} from '@uniweb/projections'

/**
 * Build the site data outputs needed by `uniweb deploy` (link-mode).
 *
 * Emits to `distDir`:
 *   - `site-content.json` — full content tree, sections always inlined.
 *     The deploy CLI reads this and ships it as `payload.locales[default]`.
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
 *     sentence was true somewhere. Framework has no host client and no host
 *     knowledge (root CLAUDE.md, THE LANE CHAIN); we cannot tell consumers
 *     apart and must not write as though we can.
 *
 *     ⇒ The rule stands on its own: we do not know which consumers
 *     re-derive, so we always ship enough for the ones that do.
 *   - `data/<collection>.json` (+ per-record files for `deferred:`
 *     collections) — same shape `processCollections` produces today.
 *   - `assets/<media>` — processed images / video posters / PDF
 *     thumbnails. Filtered by the deploy CLI to MEDIA only at upload time.
 *
 * Does NOT emit:
 *   - HTML, JS, CSS, source maps, `_importmap/*` — static-host bundle
 *     artifacts; a host on this lane renders pages itself.
 *   - `_pages/<route>.json` — only meaningful for static-host bundles,
 *     where they are served as files.
 *   - `sitemap.xml`, `robots.txt` — static-host bundle territory. Note these
 *     are simply absent from Uniweb-hosted sites today: nothing in platform
 *     generates them, at publish time or at request time.
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
 *
 * @param {Object} params
 * @param {string} params.siteRoot - Absolute path to the site directory.
 * @param {string} params.distDir - Absolute path to the dist output directory.
 * @param {string} [params.foundationPath] - Absolute path to the foundation
 *   directory, when one exists locally. Used by `collectSiteContent` to
 *   resolve theme variable defaults from `foundation.js::theme.vars`.
 * @param {Object} [params.assets] - Asset processing options.
 * @param {boolean} [params.assets.process=true]
 * @param {boolean} [params.assets.convertToWebp=true]
 * @param {number} [params.assets.quality=80]
 * @param {string} [params.assets.outputDir='assets']
 * @param {boolean} [params.assets.videoPosters=true]
 * @param {boolean} [params.assets.pdfThumbnails=true]
 * @param {string} [params.basePath='/'] - Base path prefix for collection URLs.
 * @returns {Promise<{ siteContent: Object, distDir: string }>}
 */
export async function buildSiteData({
  siteRoot,
  distDir,
  foundationPath,
  assets = {},
  basePath = '/',
}) {
  if (!siteRoot) throw new Error('buildSiteData: siteRoot is required')
  if (!distDir) throw new Error('buildSiteData: distDir is required')

  const resolvedSiteRoot = resolve(siteRoot)
  const resolvedDistDir = resolve(distDir)
  const assetsOpts = {
    process: assets.process !== false,
    convertToWebp: assets.convertToWebp !== false,
    quality: assets.quality || 80,
    outputDir: assets.outputDir || 'assets',
    videoPosters: assets.videoPosters !== false,
    pdfThumbnails: assets.pdfThumbnails !== false,
  }

  await mkdir(resolvedDistDir, { recursive: true })

  // 1. Collect content (pages, sections, theme, config, assets manifest).
  //    No vite needed — collectSiteContent is a plain async function.
  //    dropUnpublished: link mode is always a published deploy — prune hidden
  //    pages + their subtree so drafts never reach the served site.
  let siteContent = await collectSiteContent(resolvedSiteRoot, { foundationPath, dropUnpublished: true, base: basePath, strict: true })

  // 2. Compile content collections (file-based markdown/yaml/json).
  //    `writeCollectionFiles` lands them under `<siteRoot>/public/data/`;
  //    in the vite plugin path that's fine because vite copies
  //    `public/` into `dist/` at build time. The link-mode pipeline
  //    has no vite, so we mirror that copy ourselves into
  //    `<distDir>/data/` — the set the CLI's `site-data-upload` lane walks at
  //    publish time. (This named `uniweb deploy::collectDataFiles` until
  //    2026-08-18; no such function has existed for some time.) Same output bytes, same paths, just
  //    without the vite intermediary.
  if (siteContent.config?.queries) {
    const collections = await processCollections(
      resolvedSiteRoot,
      siteContent.config.queries,
      siteContent.config?.paths?.entities,
      basePath
    )
    await writeCollectionFiles(resolvedSiteRoot, collections, siteContent.config.queries)

    const publicDataDir = join(resolvedSiteRoot, 'public', DATA_DIR)
    const distDataDir = join(resolvedDistDir, DATA_DIR)
    if (existsSync(publicDataDir)) {
      await cp(publicDataDir, distDataDir, { recursive: true })
    }
  }

  // 3. Process media assets — images, optional video posters and PDF
  //    thumbnails — and rewrite the in-memory content tree so its image/
  //    video/document references point at the processed paths.
  let finalContent = siteContent
  if (assetsOpts.process && siteContent?.assets) {
    const assetCount = Object.keys(siteContent.assets).length
    if (assetCount > 0) {
      const { pathMapping } = await processAssets(siteContent.assets, {
        outputDir: resolvedDistDir,
        assetsSubdir: assetsOpts.outputDir,
        convertToWebp: assetsOpts.convertToWebp,
        quality: assetsOpts.quality,
        basePath,
      })

      const advancedEnabled = assetsOpts.videoPosters || assetsOpts.pdfThumbnails
      if (advancedEnabled) {
        const { posterMapping, thumbnailMapping } = await processAdvancedAssets(
          siteContent.assets,
          {
            outputDir: resolvedDistDir,
            assetsSubdir: assetsOpts.outputDir,
            videoPosters: assetsOpts.videoPosters,
            pdfThumbnails: assetsOpts.pdfThumbnails,
            quality: assetsOpts.quality,
            basePath,
            hasExplicitPoster: siteContent.hasExplicitPoster || new Set(),
            hasExplicitPreview: siteContent.hasExplicitPreview || new Set(),
          }
        )

        finalContent = rewriteSiteContentPaths(siteContent, pathMapping)
        if (Object.keys(posterMapping).length > 0 || Object.keys(thumbnailMapping).length > 0) {
          finalContent._assetMeta = {
            posters: posterMapping,
            thumbnails: thumbnailMapping,
          }
        }
      } else {
        finalContent = rewriteSiteContentPaths(siteContent, pathMapping)
      }
    }
  } else {
    // Drop the assets manifest from the output when processing is off
    // (matches the vite plugin's behavior — manifest is internal).
    finalContent = { ...siteContent }
    delete finalContent.assets
  }

  // Strip internal-only properties that don't serialize and have no
  // place in the published payload (Sets don't JSON-roundtrip; the
  // build's split-content emit consumed them already).
  delete finalContent.hasExplicitPoster
  delete finalContent.hasExplicitPreview

  // ⛔ `config.icons` is a HOST-owned slot on this lane — drop it.
  //
  // This payload only ever goes to a backend (link mode is what `uniweb deploy`
  // runs), and `config` is site.yml spread whole, so an author's
  // `icons.cdnUrl` would otherwise ride along and land in a slot the host is
  // supposed to fill. The icon base is a property of the DEPLOYMENT, identical
  // for every site a given backend serves — not something one site gets to
  // choose [Diego, 2026-08-17].
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

  // 6. Agent projections — `llms.txt` and one `.md` per page.
  //
  //    Emitted here as well as in the vite plugin because both lanes publish
  //    a site, and an artifact derived from site content has to exist
  //    whichever lane produced it. A projection present after one publish and
  //    absent after another is worse than none: agents are told to rely on it.
  //
  //    Ungated by `features:` — projections are free, so they carry no
  //    billing intent and no entitlement to check downstream.
  await writeProjections(finalContent, resolvedDistDir)

  return { siteContent: finalContent, distDir: resolvedDistDir }
}

/**
 * Write the agent projections into `distDir`.
 *
 * Mirrors the vite plugin's `emitProjections`, differing only in how bytes
 * reach disk (`writeFile` vs. Rollup's `emitFile`) — the generators, options
 * and filenames come from `@uniweb/projections`, so the two lanes cannot
 * disagree about what they produce.
 *
 * @param {Object} siteContent - Final site content for the default locale
 * @param {string} distDir - Resolved output directory
 * @returns {Promise<void>}
 */
async function writeProjections(siteContent, distDir) {
  const agents = resolveAgentsConfig(siteContent?.config)
  if (!agents.index && !agents.markdown) return
  if (!siteContent?.pages?.length) return

  const defaultLocale = resolveDefaultLocale(siteContent.config)
  const options = {
    baseUrl: siteContent.config?.seo?.baseUrl || '',
    locale: siteContent.config?.activeLocale || defaultLocale,
    defaultLocale
  }

  if (agents.index) {
    const index = renderSiteIndex(siteContent, { ...options, exclude: agents.exclude })
    await writeFile(join(distDir, INDEX_FILENAME), index)

    // Additive scoped indexes; the root one above stays complete. See
    // `selectIndexBranches` for why this is not a delegation.
    if (agents.branchIndexes) {
      const branches = selectIndexBranches(siteContent.pages, {
        exclude: agents.exclude,
        minPages: agents.branchMinPages
      })
      for (const branch of branches) {
        const target = join(distDir, branchIndexFilename(branch.route))
        await mkdir(dirname(target), { recursive: true })
        await writeFile(
          target,
          renderSiteIndex(siteContent, { ...options, exclude: agents.exclude, branch: branch.route })
        )
      }
    }
  }

  if (!agents.markdown) return

  for (const page of selectIndexablePages(siteContent.pages, { exclude: agents.exclude })) {
    const markdown = renderPageMarkdown(page)
    if (!markdown) continue
    const target = join(distDir, pageMarkdownFilename(page.route))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, markdown)
  }
}
