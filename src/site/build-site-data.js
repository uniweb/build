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
import { join, resolve } from 'node:path'

import { resolveDefaultLocale } from '@uniweb/core'
import { collectSiteContent } from './content-collector.js'
import { processCollections, writeCollectionFiles } from './collection-processor.js'
import { processAssets, rewriteSiteContentPaths } from './asset-processor.js'
import { processAdvancedAssets } from './advanced-processors.js'
import { generateSearchIndex } from '../search/generate.js'
import { generateCollectionIndex } from '../search/collections.js'

/**
 * Build the site data outputs needed by `uniweb deploy` (link-mode).
 *
 * Emits to `distDir`:
 *   - `site-content.json` — full content tree, sections always inlined.
 *     The deploy CLI reads this and ships it as `payload.locales[default]`
 *     to the worker. Keeping sections inlined is load-bearing: the worker
 *     re-evaluates split-content from the full payload it receives, and
 *     emits `_pages/<lang>/<route>.json` itself when split is active.
 *     If we shipped a stripped manifest (as prerender does for static-host
 *     bundles), the worker would mis-detect split and serve broken pages.
 *   - `data/<collection>.json` (+ per-record files for `deferred:`
 *     collections) — same shape `processCollections` produces today.
 *   - `assets/<media>` — processed images / video posters / PDF
 *     thumbnails. Filtered by the deploy CLI to MEDIA only at upload time.
 *
 * Does NOT emit:
 *   - HTML, JS, CSS, source maps, `_importmap/*` — none of these are
 *     consumed by Uniweb-edge; the worker generates HTML at request time.
 *   - `_pages/<route>.json` — only meaningful for static-host bundles
 *     where they're served as static assets. Worker derives them from
 *     `payload.locales[lang].pages[].sections` server-side.
 *   - `sitemap.xml`, `robots.txt`, `search-index.json` — worker generates
 *     sitemap/robots at request time; search-index is currently
 *     bundle-mode-only territory.
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
  let siteContent = await collectSiteContent(resolvedSiteRoot, { foundationPath, dropUnpublished: true, base: basePath })

  // 2. Compile content collections (file-based markdown/yaml/json).
  //    `writeCollectionFiles` lands them under `<siteRoot>/public/data/`;
  //    in the vite plugin path that's fine because vite copies
  //    `public/` into `dist/` at build time. The link-mode pipeline
  //    has no vite, so we mirror that copy ourselves into
  //    `<distDir>/data/` — the path `uniweb deploy::collectDataFiles`
  //    walks at upload time. Same output bytes, same paths, just
  //    without the vite intermediary.
  if (siteContent.config?.collections) {
    const collectionsBase = siteContent.config?.paths?.collections
      ? resolve(resolvedSiteRoot, siteContent.config.paths.collections)
      : null
    const collections = await processCollections(
      resolvedSiteRoot,
      siteContent.config.collections,
      collectionsBase,
      basePath
    )
    await writeCollectionFiles(resolvedSiteRoot, collections, siteContent.config.collections)

    const publicDataDir = join(resolvedSiteRoot, 'public', 'data')
    const distDataDir = join(resolvedDistDir, 'data')
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

  // 4. Write `dist/site-content.json` with FULL sections inlined.
  //    Important: do NOT strip sections per the split-content rule here.
  //    The link-mode deploy ships full content; the worker re-evaluates
  //    split + emits `_pages/<lang>/<route>.json` itself. Stripping at
  //    this stage would silently break split-mode sites in production.
  const contentPath = join(resolvedDistDir, 'site-content.json')
  await writeFile(contentPath, JSON.stringify(finalContent, null, 2))

  // 5. Generate `_search/{locale}/pages.json` and per-collection indexes.
  //    Gated by `features: [search]` in site.yml — consistent with the billing
  //    model where features: is the single declaration of intent. The hosting
  //    worker has its own entitlement gate (searchEnabled) that decides whether
  //    to store these files, but no point generating them when the site hasn't
  //    declared the feature at all.
  const siteFeatures = finalContent.config?.features || []
  if (Array.isArray(siteFeatures) && siteFeatures.includes('search')) {
    const defaultLocale = resolveDefaultLocale(finalContent.config)
    const searchDir = join(resolvedDistDir, '_search', defaultLocale)
    await mkdir(searchDir, { recursive: true })

    // pages.json — static pages + sections
    const pagesIndex = generateSearchIndex(finalContent, {
      locale: defaultLocale,
      search: finalContent.config?.search,
    })
    const { version: _v, count: _c, ...pagesRest } = pagesIndex
    await writeFile(join(searchDir, 'pages.json'), JSON.stringify({ type: 'pages', ...pagesRest }))

    // Collection indexes — one per routed + search-configured collection
    const collections = finalContent.config?.collections || {}
    for (const [collName, collConfig] of Object.entries(collections)) {
      if (!collConfig.search?.enabled || !collConfig.route) continue
      const cascadeFile = join(resolvedDistDir, 'data', `${collName}.json`)
      if (!existsSync(cascadeFile)) continue
      let collectionData
      try {
        collectionData = JSON.parse(await readFile(cascadeFile, 'utf8'))
      } catch {
        continue
      }
      const collIndex = generateCollectionIndex(collName, collConfig, collectionData, defaultLocale)
      await writeFile(join(searchDir, `${collName}.json`), JSON.stringify(collIndex))
    }
  }

  return { siteContent: finalContent, distDir: resolvedDistDir }
}
