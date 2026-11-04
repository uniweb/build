/**
 * The `pages/<segment>` keys in a site.yml `paths:` group, unvalidated.
 *
 * Split out from resolveMounts so the dev server can learn which directories a
 * site mounts without re-running resolveMounts' validation — that would repeat
 * its warnings on every startup, and the watcher only needs paths. Every reader —
 * the collector, the watcher, a pull (`uwx/page-files.js`), the roots a push sends
 * and a pull merges (`uwx/site-dirs.js`) and `uniweb status` among them — shares this
 * one definition of what a mount key looks like, so the prefix can never mean one
 * thing to one of them and another to the next.
 *
 * A mount is its folder, `pages/docs: ../docs`, and nothing else. ⭐ Whether a pull writes
 * the app's edits into it is no setting: it does wherever it can merge them, a folder of
 * the site's repository or of a submodule, and holds them where it cannot (the CLI's
 * `utils/site-roots.js`) [Diego, 2026-11-04]. ⛔ An object, `{ path, writable }`, was a
 * mount's form for part of that day; `resolveMounts` refuses it, saying so. Each value is
 * handed over as written, so a reader never takes such an object for no mount at all.
 *
 * A leaf, with no imports, so a module that must stay light can ask it.
 *
 * @param {Object} pathsConfig - The paths: object from site.yml
 * @returns {Array<[string, *]>} [routeSegment, folder] pairs — a folder is a string
 */
export function mountEntriesOf(pathsConfig) {
  if (!pathsConfig || typeof pathsConfig !== 'object') return []
  return Object.entries(pathsConfig)
    .filter(([key]) => key.startsWith('pages/'))
    .map(([key, value]) => [key.slice('pages/'.length), value])
}
