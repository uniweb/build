/**
 * A package a foundation imports DYNAMICALLY stays a dynamic import in `dist/entry-ssr.js`.
 *
 * The SSR twin is one file (`inlineDynamicImports`), so every dynamic import is folded into it,
 * and a module folded in runs when the file loads: the browser bundle's laziness is gone. For a
 * client-only library imported where it is used — a map inside an effect, a highlighter on demand
 * — its code then runs in the host's isolate at load, and one that touches `window` there stops
 * the foundation loading at all. Leaflet does (`window.requestAnimationFrame`, `window.L`), and
 * every page of a site using it was served as the bare shell, with no prerendered body or head.
 *
 * Kept as the import it is, such a package stays dormant, as kit's Shiki always has
 * (`isSSRExternal`): server rendering never awaits it, and a host has nothing to supply for it.
 *
 * Only a package. The foundation's own modules (`./chart.js`, `#components/x`) are folded in as
 * before, since a host that loads one file could not reach them otherwise.
 */
export function ssrDormantDynamicImports() {
  return {
    name: 'uniweb:ssr-dormant-dynamic-imports',
    resolveDynamicImport(specifier) {
      return typeof specifier === 'string' && isPackageSpecifier(specifier) ? { id: specifier, external: true } : null
    },
  }
}

/**
 * A bare package specifier — `leaflet`, `@scope/pkg/sub` — rather than a relative or absolute
 * path, a package-internal `#` import, a virtual module, or anything with a scheme.
 *
 * @param {string} specifier
 * @returns {boolean}
 */
export function isPackageSpecifier(specifier) {
  if (!specifier || /^[.#/\\\0]/.test(specifier)) return false
  if (/^[a-z][a-z0-9+.-]*:/i.test(specifier)) return false
  return true
}
