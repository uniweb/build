/**
 * Cloudflare Pages host adapter
 *
 * Emits a `_redirects` file describing redirect/rewrite directives the
 * host evaluates at request time. This is the format Cloudflare Pages
 * uses and is also accepted unchanged by Netlify (the format originated
 * there and the two hosts are compatible at this layer).
 *
 * Format: `source destination status`
 *   302 = redirect (browser URL changes)
 *   200 = rewrite/proxy (browser URL stays, host proxies transparently)
 *
 * Translates `redirect:` and `rewrite:` declarations from page.yml.
 * Preserves any `_redirects` the developer authored manually by appending.
 *
 * This is the framework's historical default postBuild output and remains
 * the default when no `--host` flag is passed to `uniweb build`.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Build the `_redirects` body from per-locale page metadata.
 *
 * @param {Array<{contentPath: string, routePrefix: string}>} localeConfigs
 * @returns {Promise<string[]>} Routing entries (one per line).
 */
async function collectRoutingEntries(localeConfigs) {
  const entries = []
  for (const localeConfig of localeConfigs) {
    const siteContent = JSON.parse(await readFile(localeConfig.contentPath, 'utf8'))
    const prefix = localeConfig.routePrefix || ''
    for (const page of siteContent.pages || []) {
      if (page.redirect) {
        entries.push(`${prefix}${page.route} ${page.redirect} 302`)
      }
      if (page.rewrite) {
        entries.push(`${prefix}${page.route}/* ${page.rewrite}/:splat 200`)
      }
    }
  }
  return entries
}

/**
 * Emit `dist/_redirects` if any redirect/rewrite directives exist.
 *
 * Standalone export retained so internal callers (and tests) can drive
 * the file emission without instantiating the full adapter shape.
 *
 * @param {string} distDir
 * @param {Array} localeConfigs - Output of discoverLocaleContents().
 * @param {function} [onProgress] - Optional progress logger.
 * @returns {Promise<{written: boolean, count: number}>}
 */
export async function emitRedirectsFile(distDir, localeConfigs, onProgress = () => {}) {
  const entries = await collectRoutingEntries(localeConfigs)
  if (entries.length === 0) return { written: false, count: 0 }

  const redirectsPath = join(distDir, '_redirects')
  // Append to existing _redirects if the developer maintains one.
  const existing = existsSync(redirectsPath) ? await readFile(redirectsPath, 'utf8') : ''
  const generated = `# Auto-generated from page.yml redirect: and rewrite: declarations\n${entries.join('\n')}\n`
  await writeFile(redirectsPath, existing ? `${existing.trimEnd()}\n\n${generated}` : generated)
  onProgress(`Generated _redirects (${entries.length} entries)`)
  return { written: true, count: entries.length }
}

const adapter = {
  name: 'cloudflare-pages',
  async postBuild({ distDir, localeConfigs, onProgress }) {
    await emitRedirectsFile(distDir, localeConfigs, onProgress)
  },
}

export default adapter
