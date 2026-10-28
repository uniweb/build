/**
 * Vite Plugin: Site Content
 *
 * Collects site content from pages/ directory and injects it into HTML.
 * Watches for changes in development mode.
 *
 * States where the site lives (`config.url`, `./site-address.js`) and its effective `seo`, which
 * the runtime writes every page's head tags from. No page's tags are written here: the shell is
 * the same for every page, and the prerender writes each page's own (`injectPageContent`). The
 * sitemap and `robots.txt` are the prerender's too, from the pages it wrote (`./seo-files.js`).
 *
 * @module @uniweb/build/site
 *
 * @example
 * import { siteContentPlugin } from '@uniweb/build/site'
 *
 * export default defineConfig({
 *   plugins: [
 *     siteContentPlugin({
 *       sitePath: './site',
 *       inject: true,
 *       // Over `site.yml::seo`, key by key — a staging build's origin, say.
 *       seo: { origin: 'https://staging.example.com' }
 *     })
 *   ]
 * })
 */

import { resolve, join, relative, sep } from 'node:path'
import { watch, existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { resolveDefaultLocale, resolveFetchConfigs, DATA_DIR } from '@uniweb/core'
import { partitionKnowledgePages, INDEX_FILENAME } from '@uniweb/projections'
import { collectSiteContent, mountEntriesOf } from './content-collector.js'
import { processAssets, rewriteSiteContentPaths } from './asset-processor.js'
import { processAdvancedAssets } from './advanced-processors.js'
import { devMediaPaths } from './dev-media.js'
import { processQueries, writeQueryFiles } from './query-processor.js'
import { RECORDS_DIR, resolveRecordsDir } from './entity-pool.js'
import { executeFetch, mergeDataIntoContent, toFetchList } from './data-fetcher.js'
import { shouldSplitContent } from './split-content.js'
import { jsonForScript } from '@uniweb/core/data-script'
// A favicon's MIME type by its extension — the rule a host's page shell types it by too.
import { faviconType } from '@uniweb/core/page-shell'
import { FONT_LINKS_MARKER } from './head-markers.js'
import { effectiveSeo, resolveSiteAddress } from './site-address.js'
import { collectExtensionAssets, isBrowserAsset } from './emit-extensions.js'
import { extensionNameOf, findSiteExtension } from './workspace-extension.js'
import { faviconHref, touchIconHref } from './favicon.js'

// BCP 47 locale code pattern: en, zh-CN, zh-Hant, pt-BR, fr-CA, sr-Latn, etc.
const LOCALE_RE = '[a-z]{2,3}(?:-[A-Za-z]{2,4})?'

const EXTENSION_CONTENT_TYPES = {
  js: 'text/javascript',
  mjs: 'text/javascript',
  css: 'text/css',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm'
}

/** The Content-Type the dev server answers an extension's built file with. */
function extensionContentType(file) {
  return EXTENSION_CONTENT_TYPES[file.split('.').pop()?.toLowerCase()] || 'application/octet-stream'
}

/**
 * Should this fetch config be pre-executed at build time and embedded into the
 * dev boot payload, or left for the runtime to fetch live?
 *
 * Dev has no prerender step, so there is no server-rendered HTML to hydrate and
 * nothing to gain from embedding fetched data — while embedding it *costs*
 * freshness: the boot payload is a one-time snapshot, so editing a local
 * collection regenerates `/data/*.json` but the runtime keeps reading the stale
 * embed until the dev server is restarted.
 *
 * So in dev we embed only what the browser genuinely cannot fetch itself. Asked of
 * a RESOLVED config (`resolveFetchConfigs`), since only the query says where its
 * records live:
 *   - a query over the site's records (`/data/<query>.json`) is served by Vite and
 *     always browser-reachable, so we never embed it — the runtime fetches it live
 *     and picks up edits on reload;
 *   - `prerender: false` opts a source out of build-time fetching by definition —
 *     and it is an external query's default;
 *   - an external query whose binding says `prerender: true` may target an
 *     endpoint only the build can reach (no CORS), so we keep pre-fetching and
 *     embedding it, mirroring what prod prerender does.
 *
 * Prod is unaffected: prerender still embeds fetched data for flash-free SSG
 * hydration (see build/src/prerender.js executeAllFetches / injectBuildData).
 *
 * @param {Object|null} cfg - A resolved fetch config
 * @returns {boolean}
 */
export function shouldPrefetchInDev(cfg) {
  if (!cfg) return false
  if (!cfg.path && !cfg.url) return false // nothing to fetch
  if (cfg.prerender === false) return false // author opted into runtime fetch
  if (cfg.path && !cfg.url) return false // local file — runtime fetches it live
  return true // remote build-time fetch — keep embedding in dev
}

/**
 * What a change to a file at the site root asks the dev server to redo — or null
 * for a file it does not read.
 *
 *   - `'queries'` — re-collect the site, re-materialize every query file from the
 *     query list just collected, reload. `queries.yml` declares queries, and so does
 *     `site.yml` (`queries:`), beside the rest of the site's configuration.
 *   - `'records'` — re-materialize the query files, reload. Only the retired
 *     `records.yml` maps here now, so that the rebuild REPORTS it: the folder's
 *     organization is `records/folder.yml` since 2026-09-21, and an edit to it is
 *     seen by the records directory's own recursive watch.
 *   - `'content'` — re-collect the site, reload.
 *
 * ⛔ Until 2026-09-14 nothing watched `records.yml` or `queries.yml`, a `site.yml`
 * edit re-collected the pages alone, and the query list was the one read at startup
 * — so an edit to what DEFINES a query file changed nothing until a restart.
 *
 * @param {string|null} filename - the changed entry's name, as `fs.watch` reports it
 * @returns {'queries'|'records'|'content'|null}
 */
export function siteRootChange(filename) {
  switch (filename) {
    case 'site.yml':
    case 'queries.yml':
      return 'queries'
    case 'records.yml': // retired — watched so the rebuild refuses it
      return 'records'
    case 'theme.yml':
    case 'head.html':
      return 'content'
    default:
      return null
  }
}

/**
 * Execute the dev fetches that should be embedded (see shouldPrefetchInDev) and
 * collect them as `fetchedData` for DataStore pre-population. Local file-based
 * collections and `prerender: false` sources are intentionally skipped so the
 * runtime fetches them live — keeping the dev payload free of dynamic data and
 * ensuring edits to `/data/*.json` show up on reload without a dev restart.
 *
 * @param {Object} siteContent - The collected site content
 * @param {string} siteDir - Path to site directory
 */
async function executeDevFetches(siteContent, siteDir) {
  // The page's locale, which a `sort` collates texts in.
  const locale = siteContent.config?.activeLocale ?? resolveDefaultLocale(siteContent.config) ?? null
  const fetchOptions = { siteRoot: siteDir, publicDir: 'public', locale }
  const fetchedData = []
  // Resolved the way the runtime resolves it (see prerender.js::executeAllFetches
  // for why): the SPA hydrates by the cache key of ITS resolved config.
  const resolveOptions = {
    locale: siteContent.config?.activeLocale ?? null,
    defaultLocale: resolveDefaultLocale(siteContent.config) ?? null,
    queries: siteContent.config?.queries ?? null,
    records: null,
  }
  const resolveForDev = (one) => resolveFetchConfigs([one], resolveOptions).get(one.as) ?? one
  const entry = (cfg, data) => ({ config: cfg, data, meta: { depth: cfg.depth } })

  // Site-level fetch — every declaration.
  for (const siteFetch of toFetchList(siteContent.config?.fetch)) {
    const cfg = resolveForDev(siteFetch)
    if (!shouldPrefetchInDev(cfg)) continue
    const result = await executeFetch(cfg, fetchOptions)
    if (result.data && !result.error) {
      fetchedData.push(entry(cfg, result.data))
    }
  }

  // Process each page
  for (const page of siteContent.pages || []) {
    // Page-level fetch — every declaration.
    for (const pageFetch of toFetchList(page.fetch)) {
      const cfg = resolveForDev(pageFetch)
      if (!shouldPrefetchInDev(cfg)) continue
      const result = await executeFetch(cfg, fetchOptions)
      if (result.data && !result.error) {
        fetchedData.push(entry(cfg, result.data))
      }
    }

    // Section-level fetches (own fetch → parsedContent.data) — ⛔ never on a
    // parametric page, whose sections the runtime fills per URL (as prerender does).
    if (!page.isDynamic) await processDevSectionFetches(page.sections, fetchOptions, resolveForDev)
  }

  // Store on siteContent for runtime DataStore pre-population
  siteContent.fetchedData = fetchedData
}

/**
 * Process fetches for sections recursively
 * Section-level fetches fill parsedContent.data, each under its own key (not cascaded).
 *
 * @param {Array} sections - Sections to process
 * @param {Object} fetchOptions - Options for executeFetch
 */
async function processDevSectionFetches(sections, fetchOptions, resolve) {
  if (!sections || !Array.isArray(sections)) return

  for (const section of sections) {
    // Execute every section-level fetch, so dev shows what prerender will.
    for (const sectionFetch of toFetchList(section.fetch)) {
      const cfg = resolve(sectionFetch)
      if (!shouldPrefetchInDev(cfg)) continue
      const result = await executeFetch(cfg, fetchOptions)
      if (result.data && !result.error) {
        // A section's own fetch goes to content.data, matching prerender.
        section.parsedContent = mergeDataIntoContent(
          section.parsedContent || {},
          result.data,
          sectionFetch.as
        )
      }
    }

    // Process subsections recursively
    if (section.subsections && section.subsections.length > 0) {
      await processDevSectionFetches(section.subsections, fetchOptions, resolve)
    }
  }
}
import { compiledData, recordProjections, routeOnDisk } from './record-projections.js'
import { agentFiles, describeProjections, projectionFiles, searchFiles } from './projections.js'
import { mergeTranslations } from '../i18n/merge.js'
import { dataBlockModels, NO_DATA_MODELS } from '../i18n/data-models.js'
import { refuseSearchOption } from './search-declared.js'
import { mountDevApi } from '../dev/api-mount.js'
import { mountDevSubmit } from '../dev/submit-mount.js'

/**
 * Create the site content plugin
 *
 * @param {Object} options
 * @param {string} [options.sitePath='./'] - Path to site directory
 * @param {string} [options.pagesDir='pages'] - Pages directory name
 * @param {string} [options.variableName='__SITE_CONTENT__'] - Script ID for injected content
 * @param {boolean} [options.inject=true] - Inject content into HTML
 * @param {string} [options.filename='site-content.json'] - Output filename
 * @param {boolean} [options.watch=true] - Watch for changes in dev mode
 * @param {Object} [options.seo] - SEO OVERRIDES, merged OVER `site.yml::seo` key by
 *   key into the site's `config.seo`, so the page heads, the sitemap and the agent
 *   index all read them. Its keys are `site.yml::seo`'s (`origin`, `image`, `robots`,
 *   `twitterHandle`…). The site's own block is the source; this is for a caller that
 *   must override it (a preview build pointing at a staging origin, say).
 *   ⛔ Do not reach for this to make `site.yml::seo` work — it already does.
 * @param {Object} [options.assets] - Asset processing configuration
 * @param {boolean} [options.assets.process=true] - Process assets in production builds
 * @param {boolean} [options.assets.convertToWebp=true] - Convert images to WebP
 * @param {number} [options.assets.quality=80] - WebP quality (1-100)
 * @param {string} [options.assets.outputDir='assets'] - Output subdirectory for processed assets
 * @param {boolean} [options.assets.videoPosters=true] - Extract poster frames from videos (requires ffmpeg)
 * @param {boolean} [options.assets.pdfThumbnails=true] - Generate thumbnails for PDFs (requires pdf-lib)
 * @param {string} [options.foundationPath] - Path to foundation directory (for loading theme vars)
 */
export function siteContentPlugin(options = {}) {
  refuseSearchOption(options, 'siteContentPlugin')
  const {
    sitePath = './',
    pagesDir = 'pages',
    variableName = '__SITE_CONTENT__',
    inject = true,
    filename = 'site-content.json',
    watch: shouldWatch = true,
    seo = {},
    assets: assetsConfig = {},
    foundationPath
  } = options

  // Extract asset processing options
  const assetsOptions = {
    process: assetsConfig.process !== false, // Default true
    convertToWebp: assetsConfig.convertToWebp !== false, // Default true
    quality: assetsConfig.quality || 80,
    outputDir: assetsConfig.outputDir || 'assets',
    videoPosters: assetsConfig.videoPosters !== false, // Default true
    pdfThumbnails: assetsConfig.pdfThumbnails !== false // Default true
  }

  /**
   * The collected site with its effective `seo` — `site.yml::seo`, with `options.seo` over it — and
   * the address this build states for it (`config.url`, `./site-address.js`), which the runtime
   * reads every absolute URL from, so a page's head, the sitemap and the agent index state the same
   * ones. ⭐ `config.trailingSlash`: this lane writes each page as `<route>/index.html`, which a
   * static host answers at `<route>/` — and at `<route>` with a redirect to it.
   */
  const locate = (content) => {
    const config = content?.config
    if (!config) return content
    config.seo = effectiveSeo(config.seo, seo)
    const url = resolveSiteAddress({ config, base: basePath })
    if (url) config.url = url
    config.trailingSlash = true
    return content
  }

  /**
   * Under `uniweb dev`, each local media reference rewritten to where the dev server serves its
   * file (`./dev-media.js`), by the manifest and the rewrite a build uses — so dev shows the file
   * a build ships. A build makes its own copies (`generateBundle`). The rewrite drops the
   * manifest, as a build's does: no payload carries it.
   */
  const devMedia = (content) => {
    if (isProduction || !content?.assets) return content
    const mapping = devMediaPaths(content.assets, { root: viteRoot, publicDir: resolvedPublicDir, base: basePath })
    return rewriteSiteContentPaths(content, mapping)
  }

  // Warn once per build, not once per collection — the dev server re-collects
  // on every content change and would otherwise repeat this on every keystroke.
  let warnedAboutKnowledge = false

  /**
   * Collect the site, then drop `knowledge:` pages.
   *
   * ⛔ **This is the bundle lane, and the bundle lane has no agent.**
   * `uniweb export` and `uniweb deploy --host <adapter>` both run this pipeline
   * (`cli/src/commands/export.js`, `deploy.js`), and their destinations are
   * static hosts — files served as files, with no service running over the
   * content. A `knowledge:` page is source material for such a service: prose
   * written for it to reason with, addressed to it rather than to a person.
   * Here there is no service to give it to, so publishing it would turn prose
   * written for a machine reader into pages for visitors — the only readers
   * this host has.
   *
   * ⚠️ **Not a confidentiality argument.** [Diego, 2026-08-13] *"It is not the
   * case that it's private in the sense of sensitive."* The service quotes this
   * material back to whoever prompts it, by design. The reason to drop it here
   * is that it has no reader on this lane, not that it must be kept from one.
   *
   * Measured 2026-08-13, before this existed: a knowledge page became
   * `dist/kb/index.html` — a public route — and its body rode in the
   * `__SITE_CONTENT__` of *every* prerendered page including `404.html`,
   * because that script carries the whole site.
   *
   * ⚠️ **Deliberately NOT inside `collectSiteContent`.** The link lane
   * (`build-site-data.js`) calls that same collector and **must keep** these
   * pages: it hands `site-content.json` to a backend that derives an agent
   * corpus from it and gates access to that corpus. Same flag, two correct
   * answers, decided by what is behind the destination — so the subtraction
   * belongs to the pipeline, not to the collector.
   */
  async function collectForBundle(path, options) {
    const collected = await collectSiteContent(path, options)
    const { knowledgePages, renderedPages } = partitionKnowledgePages(collected.pages || [])
    if (!knowledgePages.length) return collected

    if (!warnedAboutKnowledge) {
      warnedAboutKnowledge = true
      const routes = knowledgePages.map(page => page.route).join(', ')
      console.warn(
        `[site-content] Dropped ${knowledgePages.length} knowledge page(s) from this build: ${routes}\n` +
          `  This build targets a host that serves files only, so nothing here reads them — their prose is ` +
          `written for a site assistant, not for visitors. Use \`uniweb deploy\` to make them agent-readable.`
      )
    }

    return { ...collected, pages: renderedPages }
  }

  let siteContent = null
  // Where `uniweb dev` answers the site's services itself — `backend` with `$devBackend`'s
  // handler, `submit` when the site asks its host for one. Set in `configureServer`, so
  // never in a build.
  let devApiAddress = null
  let devSubmitAddress = null
  /**
   * The dev payload names those addresses as the site's `backend` and `submit` services:
   * the site tier, which `resolveService` reads when no host speaks. A build never gets
   * here with one.
   */
  const withDevServices = (content) => {
    if (devApiAddress && content?.config) content.config.backend = devApiAddress
    if (devSubmitAddress && content?.config) content.config.submit = devSubmitAddress
    return content
  }
  // What each section type declares its data blocks are — read once per collection of the site.
  let dataModelPromise = null
  const dataModels = () => (dataModelPromise ||= dataBlockModels(resolvedSitePath).catch(() => NO_DATA_MODELS))
  let resolvedSitePath = null
  let resolvedPublicDir = null
  let resolvedOutDir = null
  let viteRoot = null // Vite's config.root: the dev server serves a file under it by its path
  let isProduction = false
  let watcher = null
  let server = null
  let localeTranslations = {} // Cache: { locale: translations }
  let recordTranslations = {} // Cache: { locale: record translations }
  let localesDir = 'locales' // Default, updated from site config
  let queriesConfig = null // Cached for watcher setup
  let resolvedPagesPath = null // Resolved from site.yml pagesDir or default
  let resolvedMountPaths = [] // Absolute dirs mounted under pages/ via site.yml paths:
  let resolvedLayoutPath = null // Resolved from site.yml layoutDir or default
  let resolvedRecordsDir = null // site.yml `paths.records` as written, via `resolveRecordsDir`
  let headHtml = '' // Contents of site/head.html for injection
  let basePath = '/' // Vite's config.base, always has trailing slash

  /**
   * Load translations for a specific locale
   */
  async function loadLocaleTranslations(locale) {
    if (localeTranslations[locale]) {
      return localeTranslations[locale]
    }

    const localePath = join(resolvedSitePath, localesDir, `${locale}.json`)
    if (!existsSync(localePath)) {
      return null
    }

    try {
      const content = await readFile(localePath, 'utf-8')
      const translations = JSON.parse(content)
      localeTranslations[locale] = translations
      return translations
    } catch {
      return null
    }
  }

  /**
   * Load collection translations for a specific locale
   */
  async function loadRecordTranslations(locale) {
    if (recordTranslations[locale]) {
      return recordTranslations[locale]
    }

    const localePath = join(resolvedSitePath, localesDir, 'records', `${locale}.json`)
    if (!existsSync(localePath)) {
      return null
    }

    try {
      const content = await readFile(localePath, 'utf-8')
      const translations = JSON.parse(content)
      recordTranslations[locale] = translations
      return translations
    } catch {
      return null
    }
  }

  /**
   * Materialize every query the site declares into `public/data/` — at a production
   * build's start, at dev startup, and again whenever what a query file is made from
   * changes (`siteRootChange`, and an entity change).
   *
   * @param {Object|undefined} queries - the collected `config.queries`
   * @param {Object|undefined} config - the collected `config`, for the default locale a `sort` collates in
   */
  async function materializeQueries(queries, config) {
    if (!queries) return
    const byQuery = await processQueries(resolvedSitePath, queries, resolvedRecordsDir, basePath, {
      locale: resolveDefaultLocale(config ?? {}) ?? null,
      // ⭐ A draft is previewable here, as a hidden page is — `pnpm dev` is where the
      // author looks at it. A production build leaves it out (`buildStart`).
      includeDrafts: !isProduction,
    })
    await writeQueryFiles(resolvedSitePath, byQuery, queries)
  }

  /**
   * Read head.html from site root (if it exists)
   */
  async function loadHeadHtml() {
    const headPath = resolve(resolvedSitePath, 'head.html')
    try {
      return await readFile(headPath, 'utf-8')
    } catch {
      return ''
    }
  }

  /**
   * Get available locales from locales directory
   */
  async function getAvailableLocales() {
    const localesPath = join(resolvedSitePath, localesDir)
    if (!existsSync(localesPath)) {
      return []
    }

    try {
      const files = await readdir(localesPath)
      return files
        .filter(f => f.endsWith('.json') && f !== 'manifest.json' && !f.startsWith('_'))
        .map(f => f.replace('.json', ''))
    } catch {
      return []
    }
  }

  /**
   * Get translated content for a locale
   *
   * Supports both hash-based (granular) and free-form (complete replacement) translations.
   * Free-form translations are checked first, falling back to hash-based when not found.
   */
  async function getTranslatedContent(locale) {
    if (!siteContent) return null

    const translations = await loadLocaleTranslations(locale)
    // Even with no hash-based translations, free-form might exist
    const hasTranslations = translations !== null

    // Check if free-form translations exist for this locale
    const freeformDir = join(resolvedSitePath, localesDir, 'freeform', locale)
    const hasFreeform = existsSync(freeformDir)

    // If no translations at all (neither hash-based nor free-form), return null
    if (!hasTranslations && !hasFreeform) return null

    // Use free-form enabled merge
    return mergeTranslations(siteContent, translations || {}, {
      locale,
      localesDir: join(resolvedSitePath, localesDir),
      freeformEnabled: hasFreeform,
      dataModel: await dataModels()
    })
  }

  /**
   * The site's content in `locale`, as a page in that language gets it — or null when the site has
   * no translation for it (`getTranslatedContent`).
   */
  async function languageContent(locale) {
    const translated = await getTranslatedContent(locale)
    return translated && { ...translated, config: { ...translated.config, activeLocale: locale } }
  }

  /**
   * A compiled data file in `locale` — a query's list (`articles.json`) or a record's own file
   * (`articles/<$name>.json`), by its path under `data/` — translated as the localized build
   * translates it (`buildLocalizedRecords`), by the same helpers (`translateRecordData`). Null when
   * the site compiled no such file.
   */
  async function localizedDataFile(locale, filename) {
    const sourcePath = join(resolvedSitePath, 'public', DATA_DIR, filename)
    if (!existsSync(sourcePath)) return null
    const items = JSON.parse(await readFile(sourcePath, 'utf-8'))
    const record = filename.includes('/') && items && typeof items === 'object' && !Array.isArray(items)
    if (!Array.isArray(items) && !record) return items
    const queryName = record ? filename.slice(0, filename.lastIndexOf('/')) : filename.replace(/\.json$/, '')
    const { translateRecordData } = await import('../i18n/records.js')
    return translateRecordData(items, queryName, resolvedSitePath, {
      locale,
      localesDir: join(resolvedSitePath, localesDir),
      translations: (await loadRecordTranslations(locale)) || {},
      freeformEnabled: existsSync(join(resolvedSitePath, localesDir, 'freeform', locale))
    })
  }

  /**
   * The projection a dev request names — the search index, an agent index, a page's markdown — made
   * as the build makes it: by the same function, from the same language's content and records
   * (`./projections.js`). A request under a language's prefix is that language's when the site has
   * content in it; any other is the default language's. Null when the build writes no such file.
   *
   * @param {string} url - the request's path
   * @returns {Promise<{ source: string, type: string }|null>}
   */
  async function devProjection(url) {
    const search = url.endsWith('/search-index.json')
    const markdown = url.endsWith('.md')
    if (!search && !markdown && !url.endsWith(`/${INDEX_FILENAME}`)) return null
    if (!siteContent) return null
    // A static host decodes a request's path before it looks for the file.
    const fileName = routeOnDisk(url).replace(/^\/+/, '')
    const locale = fileName.match(new RegExp(`^(${LOCALE_RE})/`))?.[1]
    const localized = locale ? await languageContent(locale) : null
    const content = localized || siteContent
    // A language's records, translated as its build translates them; the default's, as compiled.
    const read = localized
      ? (path) => (path.startsWith(`/${DATA_DIR}/`) ? localizedDataFile(locale, path.slice(DATA_DIR.length + 2)) : null)
      : compiledData(resolvedPublicDir)
    const records = await recordProjections(content, { read })
    const file = (search ? searchFiles(content, records) : agentFiles(content, records)).find((f) => f.fileName === fileName)
    if (!file) return null
    const type = search ? 'application/json' : markdown ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8'
    return { source: file.source, type }
  }

  return {
    name: 'uniweb:site-content',

    async configResolved(config) {
      resolvedSitePath = resolve(config.root, sitePath)
      resolvedPublicDir = config.publicDir || resolve(config.root, 'public')
      resolvedOutDir = resolve(config.root, config.build.outDir)
      viteRoot = config.root
      isProduction = config.command === 'build'
      basePath = config.base || '/'

      // In dev mode, process collections early so JSON files exist before server starts
      // This runs before configureServer, ensuring data is available immediately
      if (!isProduction) {
        try {
          // Do an early content collection to get the collections config
          const earlyContent = await collectForBundle(resolvedSitePath, { foundationPath })
          queriesConfig = earlyContent.config?.queries

          // Resolve content directory paths from site.yml paths: group
          const paths = earlyContent?.config?.paths || {}
          resolvedPagesPath = paths.pages
            ? resolve(resolvedSitePath, paths.pages)
            : resolve(resolvedSitePath, pagesDir)
          resolvedLayoutPath = paths.layout
            ? resolve(resolvedSitePath, paths.layout)
            : resolve(resolvedSitePath, 'layout')
          resolvedRecordsDir = resolveRecordsDir(resolvedSitePath, paths).rel
          resolvedMountPaths = mountEntriesOf(paths).map(([, rel]) => resolve(resolvedSitePath, rel))

          if (queriesConfig) {
            console.log('[site-content] Materializing queries...')
            await materializeQueries(queriesConfig, earlyContent.config)
          }
        } catch (err) {
          console.warn('[site-content] Early query materialization failed:', err.message)
        }
      }

      // In production, resolve content paths from site.yml directly
      if (isProduction || !resolvedPagesPath) {
        const { readSiteConfig } = await import('./config.js')
        const cfg = readSiteConfig(resolvedSitePath)
        const paths = cfg.paths || {}
        resolvedPagesPath = paths.pages
          ? resolve(resolvedSitePath, paths.pages)
          : resolve(resolvedSitePath, pagesDir)
        resolvedLayoutPath = paths.layout
          ? resolve(resolvedSitePath, paths.layout)
          : resolve(resolvedSitePath, 'layout')
        resolvedRecordsDir = resolveRecordsDir(resolvedSitePath, paths).rel
      }
    },

    async buildStart() {
      // Collect content at build start
      try {
        // dropUnpublished only on a production build — in dev (serve) hidden
        // pages stay in the graph so in-progress drafts remain previewable.
        // strict on a production build: a mount that contributes no pages is a
        // warning while you author and a broken deploy once you ship.
        siteContent = devMedia(locate(withDevServices(await collectForBundle(resolvedSitePath, { foundationPath, dropUnpublished: isProduction, base: basePath, strict: isProduction }))))
        dataModelPromise = null
        headHtml = await loadHeadHtml()
        console.log(`[site-content] Collected ${siteContent.pages?.length || 0} pages`)

        // Materialize each query if the site declares any.
        // In dev mode, this was already done in configResolved (before server starts)
        // In production, do it here — by the same call, so a `sort` collates in the site's default
        // language in both. ⛔ Until 2026-10-25 this called `processQueries` with no language, and
        // the built file was collated in English whatever the site's language.
        if (isProduction && siteContent.config?.queries) {
          console.log('[site-content] Materializing queries...')
          await materializeQueries(siteContent.config.queries, siteContent.config)
        }

        // Execute data fetches in dev mode
        // In production, prerender handles this
        if (!isProduction) {
          await executeDevFetches(siteContent, resolvedSitePath)
        }

        // Update localesDir from site config
        if (siteContent.config?.i18n?.localesDir) {
          localesDir = siteContent.config.i18n.localesDir
        }

        // Clear translation cache on rebuild
        localeTranslations = {}
        recordTranslations = {}
      } catch (err) {
        console.error('[site-content] Failed to collect content:', err.message)
        // Production: a failed collect must fail the build — falling through
        // would publish an empty site (and would swallow deliberate hard
        // errors like an invalid publishLanguages config). Dev: keep the
        // server up with empty content so the author can fix the file.
        if (isProduction) throw err
        siteContent = { config: {}, theme: {}, pages: [] }
      }
    },

    configureServer(devServer) {
      server = devServer

      // A site's own backend, answered locally in development. `site.yml::$devBackend`
      // names a module that default-exports a fetch handler; the dev server mounts it
      // at an address of its own and names that address in the payload it serves
      // (`withDevServices`), so the site's `backend` service resolves to it.
      // ⚠️ Synchronous on purpose — see mountDevApi. An await here and the
      // middleware lands after Vite's SPA fallback, which answers the API with
      // index.html and says nothing about why.
      try {
        devApiAddress = mountDevApi(devServer, { root: resolvedSitePath })
      } catch (err) {
        console.error(`[dev-api] ${err.message}`)
      }

      // A site's forms, taken locally in development when site.yml asks its host for
      // them (`services: { submit: true }`): the dev server is that host here, so a form
      // shows and can be sent before the site is published. Synchronous for the same
      // reason as the mount above.
      try {
        devSubmitAddress = mountDevSubmit(devServer, { root: resolvedSitePath, base: basePath })
      } catch (err) {
        console.error(`[dev-submit] ${err.message}`)
      }

      // A site-relative workspace extension (`/effects/entry.js`) is served from
      // the site's own origin: the build copies its built files there
      // (`collectExtensionAssets`, in generateBundle). Dev serves the same set,
      // from the same folder, found by the same rule (`./workspace-extension.js`),
      // so `uniweb dev` and `uniweb build` cannot disagree about whether a site
      // has its extension. Its bare imports (`react`, `@uniweb/core`) resolve
      // through the import map a dev page with extensions carries (`./config.js`,
      // `serveInDev`). ⚠️ Synchronous, like the mount above, so it runs before
      // Vite's SPA fallback.
      //
      // ⛔ Until 2026-10-13 nothing served it in dev: the request reached the SPA
      // fallback, which answered `index.html` with a 200, `import()` failed on
      // it, and the runtime dropped the extension. Measured on the `extensions`
      // template.
      const warnedExtensions = new Set()
      devServer.middlewares.use(async (req, res, next) => {
        const declared = siteContent?.config?.extensions
        const named = Array.isArray(declared) && declared.length ? extensionNameOf(req.url, basePath) : null
        const entry =
          named &&
          declared
            .map((d) => (typeof d === 'string' ? d : d?.url))
            .find((url) => extensionNameOf(url, basePath)?.name === named.name)
        if (!entry || !named.rest) return next()

        const packageDir = findSiteExtension(named.name, resolvedSitePath)
        if (packageDir) {
          const distDir = join(packageDir, 'dist')
          let rest = named.rest
          try {
            rest = decodeURIComponent(rest)
          } catch {}
          const file = resolve(distDir, rest)
          if (file.startsWith(distDir + sep) && isBrowserAsset(rest) && existsSync(file)) {
            try {
              const body = await readFile(file)
              res.setHeader('Content-Type', extensionContentType(file))
              res.setHeader('Cache-Control', 'no-cache')
              res.end(body)
              return
            } catch (err) {
              return next(err)
            }
          }
        }

        // Only the declared entry is answered when its file is missing: the runtime
        // drops an extension it cannot load either way, and a 404 says what the
        // SPA's HTML would hide. Any other path under that name is left to Vite.
        if (extensionNameOf(entry, basePath)?.rest !== named.rest) return next()
        if (!warnedExtensions.has(entry)) {
          warnedExtensions.add(entry)
          console.warn(
            packageDir
              ? `[site-content] Extension '${entry}' is not built (${relative(resolvedSitePath, packageDir)}). ` +
                  `Build it — \`uniweb build\` from the workspace root — and reload.`
              : `[site-content] Extension '${entry}' is site-relative, and no workspace extension has its name. ` +
                  `A site finds one in <name>/ or extensions/<name>/, in the folder the site is in or a folder ` +
                  `above it, up to the workspace root.`
          )
        }
        res.statusCode = 404
        res.end()
      })

      // Watch for content changes in dev mode
      if (shouldWatch) {
        // Debounce rebuilds. One that `queries.yml` or `site.yml` asked for also
        // re-materializes the query files, from the query list the rebuild has just
        // collected — and a content change debounced after it, in the same window,
        // does not cancel that.
        let rebuildTimeout = null
        let rebuildQueries = false
        const scheduleRebuild = (withQueries = false) => {
          rebuildQueries = rebuildQueries || withQueries
          if (rebuildTimeout) clearTimeout(rebuildTimeout)
          rebuildTimeout = setTimeout(async () => {
            const materialize = rebuildQueries
            rebuildQueries = false
            console.log('[site-content] Content changed, rebuilding...')
            try {
              siteContent = devMedia(locate(withDevServices(await collectForBundle(resolvedSitePath, { foundationPath, base: basePath }))))
              dataModelPromise = null
              headHtml = await loadHeadHtml()
              if (materialize) {
                queriesConfig = siteContent.config?.queries
                await materializeQueries(queriesConfig, siteContent.config)
              }
              // Execute fetches for the updated content
              await executeDevFetches(siteContent, resolvedSitePath)
              console.log(`[site-content] Rebuilt ${siteContent.pages?.length || 0} pages`)

              // Send full reload to client
              server.ws.send({ type: 'full-reload' })
            } catch (err) {
              console.error('[site-content] Rebuild failed:', err.message)
            }
          }, 100)
        }

        // Debounce collection rebuilds separately (writes to file system)
        let recordRebuildTimeout = null
        const scheduleRecordRebuild = () => {
          if (recordRebuildTimeout) clearTimeout(recordRebuildTimeout)
          recordRebuildTimeout = setTimeout(async () => {
            console.log('[site-content] Records changed, regenerating JSON...')
            try {
              // The query list the last collect read — at startup, or by a rebuild
              // that `queries.yml` or `site.yml` asked for
              await materializeQueries(queriesConfig || siteContent?.config?.queries, siteContent?.config)
              // Send full reload to client
              server.ws.send({ type: 'full-reload' })
            } catch (err) {
              console.error('[site-content] Record rebuild failed:', err.message)
            }
          }, 100)
        }

        // A watcher passes `(eventType, filename)`; a content change never asks for the queries.
        const onContentChange = () => scheduleRebuild(false)

        // Track all watchers for cleanup
        const watchers = []

        // Watch pages directory (resolved from site.yml pagesDir or default)
        if (existsSync(resolvedPagesPath)) {
          try {
            watchers.push(watch(resolvedPagesPath, { recursive: true }, onContentChange))
            console.log(`[site-content] Watching ${resolvedPagesPath}`)
          } catch (err) {
            console.warn('[site-content] Could not watch pages directory:', err.message)
          }
        }

        // Watch each directory mounted under pages/ by site.yml `paths:`.
        //
        // The site's own pages/ watcher above does not reach these — a mount
        // lives outside the site, which is the whole point of one. Without this
        // an author editing a mounted docs repository sees nothing change until
        // they restart the dev server, and the natural reading of that is that
        // their edit was wrong rather than unwatched.
        for (const mountPath of resolvedMountPaths) {
          if (!existsSync(mountPath)) continue
          try {
            watchers.push(watch(mountPath, { recursive: true }, onContentChange))
            console.log(`[site-content] Watching ${mountPath} (mounted)`)
          } catch (err) {
            console.warn(`[site-content] Could not watch mounted directory ${mountPath}:`, err.message)
          }
        }

        // Watch layout directory (resolved from site.yml layoutDir or default)
        if (existsSync(resolvedLayoutPath)) {
          try {
            watchers.push(watch(resolvedLayoutPath, { recursive: true }, onContentChange))
            console.log(`[site-content] Watching ${resolvedLayoutPath}`)
          } catch (err) {
            console.warn('[site-content] Could not watch layout directory:', err.message)
          }
        }

        // Watch the site root — `site.yml`, `queries.yml`, `theme.yml`, `head.html`,
        // and the retired `records.yml` — as ONE directory rather than a watch per
        // file: a file watch cannot be set on a file created after the server started
        // (a first `queries.yml`), and an editor that saves by replacing a file ends its watch.
        // Not recursive, so what the build writes below the root (`public/data/`) is
        // not seen here. What each change redoes is `siteRootChange`.
        try {
          watchers.push(watch(resolvedSitePath, (eventType, filename) => {
            const change = siteRootChange(filename)
            if (change === 'queries') scheduleRebuild(true)
            else if (change === 'records') scheduleRecordRebuild()
            else if (change === 'content') scheduleRebuild(false)
          }))
        } catch (err) {
          console.warn('[site-content] Could not watch the site root:', err.message)
        }

        // ⭐ WATCH THE POOL, NOT A DIRECTORY PER QUERY. This used to resolve
        // `config.path` for each declaration and watch each one, so a schema
        // folder no query had mentioned yet — a new one, mid-session — was
        // watched by nothing and its records never rebuilt. `records/` is one
        // recursive root and covers every schema, present and future.
        {
          const contentPaths = new Set([
            resolve(resolvedSitePath, resolvedRecordsDir || RECORDS_DIR)
          ])

          for (const contentPath of contentPaths) {
            if (existsSync(contentPath)) {
              try {
                watchers.push(watch(contentPath, { recursive: true }, scheduleRecordRebuild))
                console.log(`[site-content] Watching ${contentPath} for record changes`)
              } catch (err) {
                console.warn('[site-content] Could not watch content directory:', err.message)
              }
            }
          }
        }

        // Store watchers for cleanup
        watcher = { close: () => watchers.forEach(w => w.close()) }
      }

      // Watch locales directory for translation changes
      const localesPath = resolve(resolvedSitePath, localesDir)
      const additionalWatchers = []

      if (existsSync(localesPath)) {
        try {
          const localeWatcher = watch(localesPath, { recursive: false }, () => {
            console.log('[site-content] Translation files changed, clearing cache...')
            localeTranslations = {}
            recordTranslations = {}
            server.ws.send({ type: 'full-reload' })
          })
          additionalWatchers.push(localeWatcher)
          console.log(`[site-content] Watching ${localesPath} for translation changes`)
        } catch (err) {
          // locales dir may not exist, that's ok
        }

        // Watch free-form translations directory
        const freeformPath = resolve(localesPath, 'freeform')
        if (existsSync(freeformPath)) {
          try {
            const freeformWatcher = watch(freeformPath, { recursive: true }, () => {
              console.log('[site-content] Free-form translation changed, reloading...')
              server.ws.send({ type: 'full-reload' })
            })
            additionalWatchers.push(freeformWatcher)
            console.log(`[site-content] Watching ${freeformPath} for free-form translation changes`)
          } catch (err) {
            // freeform dir may not exist, that's ok
          }
        }

        // Watch collection translations directory
        const recordLocalesPath = resolve(localesPath, 'records')
        if (existsSync(recordLocalesPath)) {
          try {
            const collWatcher = watch(recordLocalesPath, { recursive: false }, () => {
              console.log('[site-content] Record translations changed, clearing cache...')
              recordTranslations = {}
              server.ws.send({ type: 'full-reload' })
            })
            additionalWatchers.push(collWatcher)
            console.log(`[site-content] Watching ${recordLocalesPath} for record translation changes`)
          } catch (err) {
            // collections locales dir may not exist, that's ok
          }
        }
      }

      // Add additional watchers to cleanup
      if (additionalWatchers.length > 0 && watcher) {
        const originalClose = watcher.close
        watcher.close = () => {
          originalClose()
          additionalWatchers.forEach(w => w.close())
        }
      }

      // Serve content and SEO files
      devServer.middlewares.use(async (req, res, next) => {
        // Handle default locale site-content request
        if (req.url === `/${filename}`) {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(siteContent, null, 2))
          return
        }

        // Handle locale-prefixed site-content request (e.g., /es/site-content.json)
        const localeContentMatch = req.url.match(new RegExp(`^\\/(${LOCALE_RE})\\/site-content\\.json$`))
        if (localeContentMatch) {
          const locale = localeContentMatch[1]
          const translatedContent = await getTranslatedContent(locale)

          if (translatedContent) {
            // Add activeLocale to the content so runtime knows which locale is active
            const contentWithLocale = {
              ...translatedContent,
              config: {
                ...translatedContent.config,
                activeLocale: locale
              }
            }
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(contentWithLocale, null, 2))
            return
          }
          // If no translations, fall through to serve default content
        }

        // ⛔ No sitemap.xml or robots.txt here: the prerender writes them from the pages it
        // renders (`./seo-files.js`), and a dev server renders none ahead of a visit.

        // The projections — the search index, `llms.txt` (and a branch's), each page as markdown —
        // in every language: the file the build writes at this path, made by the same function from
        // the same language's content and records (`devProjection`), so what a developer sees here
        // is what ships. Without it they could be inspected only by deploying, and `uniweb doctor`'s
        // address warning would describe something invisible locally. ⛔ Until 2026-10-25 dev made
        // another language's search index from the default language's content, and found its `.md`
        // by the source route, so the translated links its `llms.txt` gave answered with the page
        // shell.
        const projection = await devProjection(req.url.split('?')[0])
        if (projection) {
          res.setHeader('Content-Type', projection.type)
          res.end(projection.source)
          return
        }

        // Handle localized collection data (e.g., /fr/data/articles.json), and a
        // query's per-record files (/fr/data/articles/<$name>.json) — one record
        // each, translated the same way.
        const localeDataMatch = req.url.match(new RegExp(`^\\/(${LOCALE_RE})\\/${DATA_DIR}\\/(.+\\.json)$`))
        if (localeDataMatch) {
          try {
            const translated = await localizedDataFile(localeDataMatch[1], localeDataMatch[2])
            if (translated !== null) {
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify(translated, null, 2))
              return
            }
          } catch (err) {
            console.warn(`[site-content] Failed to serve localized records ${localeDataMatch[2]}: ${err.message}`)
            // Fall through to Vite's static server
          }
        }

        // Serve per-page content on demand (dev mode, split content)
        if (siteContent && req.url.startsWith('/_pages/')) {
          const routePath = req.url.replace(/^\/_pages/, '').replace(/\.json$/, '')
          const route = routePath === '/index' ? '/' : routePath
          const page = siteContent.pages.find(p => p.route === route)
          if (page?.sections) {
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ sections: page.sections }))
            return
          }
        }

        next()
      })
    },

    async transformIndexHtml(html, ctx) {
      if (!siteContent) return html

      // Detect locale from URL (e.g., /es/about → 'es')
      let contentToInject = siteContent
      let activeLocale = null

      if (ctx?.originalUrl) {
        const localeMatch = ctx.originalUrl.match(new RegExp(`^\\/(${LOCALE_RE})(\\/|$)`))
        if (localeMatch) {
          activeLocale = localeMatch[1]
          const translatedContent = await getTranslatedContent(activeLocale)
          if (translatedContent) {
            contentToInject = {
              ...translatedContent,
              config: {
                ...translatedContent.config,
                activeLocale
              }
            }
          }
        }
      }

      let headInjection = ''

      // Inject user's head.html (analytics, third-party scripts)
      if (headHtml) {
        headInjection += headHtml + '\n'
      }

      // Inject the theme's font <link> tags (before theme CSS so the browser
      // starts DNS/fetch early). This is every font link in one place:
      // preconnects, the merged Google Fonts stylesheet, and preload hints for
      // self-hosted faces.
      //
      // These used to be dropped. The theme CSS once carried `@import
      // url(<google>)` and this spot only had to add a preconnect in front of
      // it; when @uniweb/theming replaced that @import with a `links` string,
      // nothing here started consuming it — so the build preconnected to
      // Google Fonts and then never requested the stylesheet, leaving every
      // imported family undefined and silently falling back.
      if (contentToInject.theme?.links) {
        headInjection += `    ${FONT_LINKS_MARKER}\n${contentToInject.theme.links}\n`
      }

      // Inject theme CSS
      if (contentToInject.theme?.css) {
        headInjection += `    <style id="uniweb-theme">\n${contentToInject.theme.css}\n    </style>\n`
      }

      // ⛔ No page's head tags — canonical, Open Graph, hreflang — go into the shell, which every
      // page is rendered into: the prerender writes each page's own (`injectPageContent`), and the
      // browser keeps them (`useHeadMeta`). Until 2026-10-25 the home page's were written here.

      // The favicon: site.yml's `favicon:`, else the one public/ holds (`./favicon.js`).
      const favicon = faviconHref(contentToInject?.config?.favicon, resolvedPublicDir, basePath)
      if (favicon) {
        const type = faviconType(favicon)
        const typeAttr = type ? ` type="${type}"` : ''
        headInjection += `    <link rel="icon"${typeAttr} href="${favicon}">\n`
      }
      // The touch icon: site.yml's `touchIcon:`, the PNG iOS puts on a home screen.
      const touchIcon = touchIconHref(contentToInject?.config?.touchIcon, basePath)
      if (touchIcon) headInjection += `    <link rel="apple-touch-icon" href="${touchIcon}">\n`

      // Inject content as JSON script tag
      if (inject) {
        headInjection += `    <script type="application/json" id="${variableName}">${jsonForScript(contentToInject)}</script>\n`
      }

      let result = html

      // Update <html lang> for non-default locales
      if (activeLocale) {
        result = result.replace(/<html([^>]*)\slang="[^"]*"/, `<html$1 lang="${activeLocale}"`)
      }

      if (!headInjection) return result

      // Insert before </head>
      return result.replace('</head>', headInjection + '  </head>')
    },

    async generateBundle() {
      let finalContent = siteContent

      // Process assets in production builds
      if (isProduction && assetsOptions.process && siteContent?.assets) {
        const assetCount = Object.keys(siteContent.assets).length

        if (assetCount > 0) {
          console.log(`[site-content] Processing ${assetCount} assets...`)

          // Process standard assets (images)
          const { pathMapping, results, files } = await processAssets(siteContent.assets, {
            outputDir: resolvedOutDir,
            assetsSubdir: assetsOptions.outputDir,
            convertToWebp: assetsOptions.convertToWebp,
            quality: assetsOptions.quality,
            basePath
          })

          // Process advanced assets (videos, PDFs)
          const advancedEnabled = assetsOptions.videoPosters || assetsOptions.pdfThumbnails
          let advancedResults = null

          if (advancedEnabled) {
            const { posterMapping, thumbnailMapping, results: advResults } = await processAdvancedAssets(
              siteContent.assets,
              {
                outputDir: resolvedOutDir,
                assetsSubdir: assetsOptions.outputDir,
                videoPosters: assetsOptions.videoPosters,
                pdfThumbnails: assetsOptions.pdfThumbnails,
                quality: assetsOptions.quality,
                basePath,
                // Pass explicit poster/preview sets to skip auto-generation
                hasExplicitPoster: siteContent.hasExplicitPoster || new Set(),
                hasExplicitPreview: siteContent.hasExplicitPreview || new Set()
              }
            )
            advancedResults = advResults

            // Log advanced processing results
            if (advResults.videos.processed > 0) {
              console.log(`[site-content] Extracted ${advResults.videos.processed} video posters`)
            }
            if (advResults.videos.explicit > 0) {
              console.log(`[site-content] Skipped ${advResults.videos.explicit} videos with explicit posters`)
            }
            if (advResults.pdfs.processed > 0) {
              console.log(`[site-content] Generated ${advResults.pdfs.processed} PDF thumbnails`)
            }
            if (advResults.pdfs.explicit > 0) {
              console.log(`[site-content] Skipped ${advResults.pdfs.explicit} PDFs with explicit previews`)
            }

            // Merge poster and thumbnail mappings into the path mapping
            // Videos: add a .poster property to the content (not replace the src)
            // PDFs: add a .thumbnail property to the content
            finalContent = rewriteSiteContentPaths(siteContent, pathMapping, files)

            // Add poster and thumbnail metadata to the site content
            if (Object.keys(posterMapping).length > 0 || Object.keys(thumbnailMapping).length > 0) {
              finalContent._assetMeta = {
                posters: posterMapping,
                thumbnails: thumbnailMapping
              }
            }
          } else {
            // Rewrite paths in content
            finalContent = rewriteSiteContentPaths(siteContent, pathMapping, files)
          }

          // Log results
          const sizeKB = (results.totalSize / 1024).toFixed(1)
          console.log(`[site-content] Processed ${results.processed} assets (${results.converted} converted to WebP, ${sizeKB}KB total)`)

          if (results.failed > 0) {
            console.warn(`[site-content] ${results.failed} assets failed to process`)
          }
        }
      } else {
        // In dev or when processing is disabled, just remove the assets manifest
        finalContent = { ...siteContent }
        delete finalContent.assets
      }

      // Clean up internal properties that shouldn't be in the output (Sets don't serialize)
      delete finalContent.hasExplicitPoster
      delete finalContent.hasExplicitPreview

      // Note: theme.css is kept here so prerender can inject it into HTML
      // Prerender will strip it from the JSON it injects into each page

      // Check if split content mode is active
      const splitContent = shouldSplitContent(
        finalContent.config?.build?.splitContent,
        finalContent.pages
      )

      if (splitContent) {
        // Emit per-page content files as baseline (prerender overwrites with post-fetch versions)
        for (const page of finalContent.pages) {
          if (!page.sections?.length) continue
          if (page.isDynamic) continue
          const routePath = page.route === '/' ? 'index' : page.route.replace(/^\//, '')
          this.emitFile({
            type: 'asset',
            fileName: `_pages/${routePath}.json`,
            source: JSON.stringify({ sections: page.sections })
          })
        }
      }

      // Emit content as JSON file in production build
      // Always emit full content — prerender needs sections to render pages.
      // Prerender will rewrite this as a lightweight manifest when split mode is active.
      this.emitFile({
        type: 'asset',
        fileName: filename,
        source: JSON.stringify(finalContent, null, 2)
      })

      // sitemap.xml and robots.txt are the prerender's: it writes them from the pages it wrote,
      // record pages included (`./seo-files.js`).

      // The default language's projections — its search index, its agent index and its pages as
      // markdown, each record of a parametric page among them — by the rule every language's are
      // made by (`./projections.js`). Each other language's are written after the bundle, once its
      // records are translated (`i18n/index.js::buildLocalizedSite`).
      const records = await recordProjections(finalContent, { read: compiledData(resolvedPublicDir) })
      const projected = projectionFiles(finalContent, records)
      for (const { fileName, source } of projected) this.emitFile({ type: 'asset', fileName, source })
      for (const line of describeProjections(projected)) console.log(`[site-content] ${line}`)

      // A site-relative extension (`/effects/entry.js`) is served from the
      // site's OWN origin, so the site's build is what has to put it there.
      // Without this the build succeeds, prerender renders the extension's
      // sections from the workspace, and the browser then 404s and replaces
      // them with `Component not found` on hydration.
      const { emit, unresolved, unbuilt } = collectExtensionAssets(
        finalContent.config?.extensions,
        resolve(sitePath),
        { base: finalContent.config?.base }
      )
      for (const asset of emit) {
        this.emitFile({ type: 'asset', fileName: asset.fileName, source: asset.source })
      }
      for (const url of unresolved) {
        this.warn(
          `Extension '${url}' is site-relative, and no workspace extension has its name. ` +
            `A site finds one in <name>/ or extensions/<name>/, in the folder the site is in or a folder ` +
            `above it, up to the workspace root. The site will 404 on it at runtime — move the extension ` +
            `there, or reference it by URL.`
        )
      }
      for (const { url, dir } of unbuilt) {
        this.warn(
          `Extension '${url}' is not built (${relative(resolve(sitePath), dir) || dir}), so the site will ` +
            `404 on it at runtime. Run \`uniweb build\` from the workspace root, which builds extensions first.`
        )
      }
    },

    closeBundle() {
      // Clean up watcher
      if (watcher) {
        watcher.close()
        watcher = null
      }
    }
  }
}

export default siteContentPlugin
