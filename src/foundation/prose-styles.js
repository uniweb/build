/**
 * Prose without its stylesheet — the one foundation mistake that renders fine and looks wrong.
 *
 * kit's `<Prose>` (and `<Article>`, which is `<Prose>` in an `<article>`) draws content inside
 * Tailwind Typography's `prose` classes. Those classes style nothing unless the foundation's
 * stylesheet brings the plugin, which is one line:
 *
 *     @import "@uniweb/kit/prose-tokens.css";
 *
 * Without it, Tailwind's reset takes the markers off every list, and headings, spacing and quotes
 * get no typography — while the markup underneath is correct, so nothing fails and nothing says so.
 * Three official templates shipped that way until 2026-09-29.
 *
 * ⇒ The check reads the build's own output: kit's Prose module rendered into a chunk, and no
 * `.prose` rule in any CSS the build emitted.
 *
 * @module @uniweb/build/foundation/prose-styles
 */

/** kit's Prose module, wherever kit resolves from — the workspace or node_modules. */
const PROSE_MODULE = /[\\/]kit[\\/]src[\\/]styled[\\/]Prose[\\/]index\.jsx$/

/** A rule of the typography plugin's, which every one of its selectors starts with. */
const PROSE_RULE = /\.prose\b/

/**
 * Is this module id kit's Prose?
 *
 * @param {string} id - a module id from the bundle's graph
 * @returns {boolean}
 */
export function isProseModule(id) {
  return typeof id === 'string' && PROSE_MODULE.test(id)
}

/**
 * Does this bundle render kit's Prose, with no prose styles in its CSS?
 *
 * A module that tree-shaking left empty does not count — importing kit is not rendering Prose.
 *
 * @param {object} bundle - Rollup's bundle, as handed to `writeBundle`
 * @returns {boolean}
 */
export function proseWithoutStyles(bundle) {
  let rendersProse = false
  let hasProseRule = false
  for (const item of Object.values(bundle || {})) {
    if (item?.type === 'chunk' && item.modules) {
      for (const [id, mod] of Object.entries(item.modules)) {
        if (mod?.renderedLength > 0 && isProseModule(id)) rendersProse = true
      }
    } else if (item?.type === 'asset' && String(item.fileName || '').endsWith('.css')) {
      const source = typeof item.source === 'string' ? item.source : Buffer.from(item.source || []).toString('utf8')
      if (PROSE_RULE.test(source)) hasProseRule = true
    }
  }
  return rendersProse && !hasProseRule
}

/** What the foundation build prints when `proseWithoutStyles` is true. */
export const PROSE_WITHOUT_STYLES_WARNING =
  "[uniweb] This foundation renders kit's <Prose> or <Article>, and its CSS has no prose styles — " +
  'lists render without bullets or numbers, and text without typography. Add this line to the ' +
  "foundation's stylesheet, after its Tailwind import:\n" +
  '  @import "@uniweb/kit/prose-tokens.css";'
