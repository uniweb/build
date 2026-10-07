/**
 * The layout a page renders with when it names none — decided once, by the build, and written
 * into both artifacts: the entry's `capabilities.defaultLayout`, which the runtime reads
 * (`Website.getDefaultLayoutName`), and `_self.defaultLayout` in the schema, which an editor
 * reads to offer a page the areas it will draw. One rule, run once, so the two cannot disagree.
 *
 * ⭐ THE RULE [2026-10-07; Diego: "I think the default layout maybe called `default`"]:
 *
 *   1. `main.js`'s `defaultLayout`, written as that layout's own name — `DocsLayout` for
 *      `docs` — so a reader finds it in `_layouts` by key. ⛔ One that names none of the
 *      foundation's layouts stops the build: at render it fell to the built-in layout with
 *      nothing saying why.
 *   2. Else the layout whose name is `default`, by the one naming rule (`layoutNameKey`):
 *      `Default`, `DefaultLayout`, `default-layout`.
 *   3. Else none — the runtime's built-in layout, which draws `header`, the body and `footer`.
 *
 * ⛔ NOT "the only layout". Under that rule, adding a second layout would change the layout of
 * every page that names none — a non-local effect nobody asked for. A foundation that means its
 * one layout as the default says so, as every template does.
 *
 * ⛔ *Until 2026-10-07 the build copied the declared value and derived nothing, so a layout named
 * `Default` was the default only when `main.js` said so — and a reader of the schema finding none
 * had to guess what the runtime would draw.*
 *
 * @module @uniweb/build/foundation/default-layout
 */

import { findLayoutEntry } from '@uniweb/core/layout-name'

/**
 * @param {*} declared - `main.js`'s `defaultLayout`, as `loadFoundationConfig` reads it
 * @param {string[]} layoutNames - the foundation's layouts (`discoverLayoutsInPath`)
 * @returns {string|null} the layout's own name, or null for the built-in layout
 * @throws {Error} when `declared` names none of the layouts
 */
export function resolveDefaultLayout(declared, layoutNames = []) {
  const byName = Object.fromEntries((layoutNames || []).map((name) => [name, name]))

  if (declared !== undefined && declared !== null && declared !== '') {
    const name = typeof declared === 'string' ? findLayoutEntry(byName, declared) : undefined
    if (name) return name
    const known = Object.keys(byName)
    throw new Error(
      `main.js: \`defaultLayout\` names ${JSON.stringify(declared)}, which is not one of this foundation's layouts` +
        (known.length > 0 ? ` (${known.join(', ')})` : ' — it has none in src/layouts/') +
        '. Name one of them, or remove the key: a page that names no layout then renders the built-in ' +
        'layout, or one named `Default`.'
    )
  }

  return findLayoutEntry(byName, 'default') ?? null
}
