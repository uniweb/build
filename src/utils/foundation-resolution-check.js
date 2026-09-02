/**
 * Do WE and VITE agree on where the foundation is?
 *
 * ## The bug this exists for
 *
 * A site build resolves its foundation **twice, by two different mechanisms**,
 * and until 2026-09-01 nothing checked that they agreed:
 *
 *   1. **We resolve a PATH.** `detectFoundationType('src', siteRoot)` returns
 *      `{ type: 'local', path: <siteRoot>/../src }`, and the
 *      `uniweb:ensure-foundation-entry` plugin generates `_entry.generated.js`
 *      into exactly that directory.
 *   2. **Vite resolves a NAME.** `site/config.js` sets
 *      `alias['#foundation'] = foundationInfo.name` — the bare specifier — so
 *      Vite runs its own node_modules lookup and reads that package's `main`.
 *
 * Those name the same directory only because a package manager linked
 * `node_modules/<name>` to the foundation. Nothing enforces it, and when it does
 * not hold we generate into one directory while Vite reads another.
 *
 * ## ⛔ The failure is worse when it does NOT fail
 *
 * If the directory Vite reaches has no `_entry.generated.js`, the build dies with
 * vite's `[commonjs--resolver] Failed to resolve entry for package "<name>"` —
 * opaque, but loud.
 *
 * **If it has a STALE one, nothing fails at all.** The site builds against a
 * different foundation than the one on disk, and reports success. A developer
 * editing `src/` sees their change generated into `src/_entry.generated.js` and
 * simply not take effect. *(Measured by the `flows` lane 2026-09-01: their
 * harness minted fixtures under a `node_modules` that was itself a symlink to a
 * seed tree, so a relative `../../src` link resolved into the seed. Every run
 * that mutated its foundation and then built a site had been silently building
 * the seed's copy — and presenting as green — for as long as the harness had
 * existed. The red they opened a channel about was the harmless half.)*
 *
 * ⇒ **This check is about the silent case.** An error message can only reach the
 * loud one; comparing the two answers reaches both.
 *
 * ## Why it compares REALPATHS and not link text
 *
 * `readlink node_modules/<name>` returning `../../src` looks healthy and proves
 * nothing: **a relative symlink resolves against the link's target, not its
 * location**, so with `node_modules` itself a link, `../../src` lands in a
 * different tree. Only the resolved physical path answers the question vite
 * actually asks. *(This module's first draft compared link text. It reported
 * healthy on the one tree that was broken.)*
 *
 * ## Why it does its own node_modules walk
 *
 * `createRequire(...).resolve(name)` cannot be used: in the failure case `main`
 * points at the missing entry, so it throws rather than telling us where it
 * looked. `require.resolve(name + '/package.json')` cannot either — a foundation
 * declares `exports: { ".": "./_entry.generated.js" }`, which gates every other
 * subpath, so that lookup fails on a *healthy* package.
 *
 * So we walk `node_modules` upward for the package directory, which is the part
 * of node resolution that locates a package before `exports` or `main` is
 * consulted. That is the step whose answer we need.
 */

import { existsSync, realpathSync } from 'node:fs'
import { dirname, join, parse } from 'node:path'

/**
 * The directory a bare specifier's package lives in, by node's own
 * node_modules walk — the step that runs before `exports`/`main` are read.
 *
 * @param {string} name - the bare specifier (a foundation's package name)
 * @param {string} fromDir - the directory resolution starts in (the site root)
 * @returns {string|null} the package directory, or null if no node_modules
 *   anywhere up the tree holds it
 */
export function findPackageDir(name, fromDir) {
  let dir = fromDir
  const { root } = parse(fromDir)
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    if (dir === root) return null
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Compare where we generated the foundation entry against where vite will look.
 *
 * ⭐ **Silence is deliberate when the package is not found at all.** Not every
 * supported layout puts the foundation in the site's `node_modules` — a
 * `foundations/<name>/` multi-site project may not — and a warning that fires on
 * a healthy project is worse than no warning, because the next person learns to
 * ignore it. A package we cannot locate is also a case vite will fail on by
 * itself, loudly. **We report only a disagreement we can actually prove**, which
 * makes a false positive impossible by construction.
 *
 * @param {Object} args
 * @param {string} args.name - the foundation's declared name (the bare specifier)
 * @param {string} args.generatedInto - the directory we wrote `_entry.generated.js` to
 * @param {string} args.siteRoot - where vite resolves the bare specifier from
 * @returns {{ ok: true } | { ok: false, ours: string, theirs: string, message: string }}
 */
export function checkFoundationResolution({ name, generatedInto, siteRoot }) {
  const theirsRaw = findPackageDir(name, siteRoot)
  if (!theirsRaw) return { ok: true }

  let ours, theirs
  try {
    ours = realpathSync(generatedInto)
    theirs = realpathSync(theirsRaw)
  } catch {
    // A path vanished between the walk and the realpath. Not a disagreement we
    // can prove, so it is not one we report.
    return { ok: true }
  }

  if (ours === theirs) return { ok: true }

  return {
    ok: false,
    ours,
    theirs,
    message: [
      `[site] ⛔ Foundation "${name}" resolves to two different directories.`,
      ``,
      `  we generated its entry into : ${ours}`,
      `  vite will import it from    : ${theirs}`,
      ``,
      `  Your site build will use the SECOND one, so edits to the first do not`,
      `  take effect — and if that directory carries a stale _entry.generated.js`,
      `  the build SUCCEEDS against the wrong foundation.`,
      ``,
      `  This means node_modules/${name} under ${siteRoot} is not the foundation`,
      `  directory. Re-run your package manager's install. If you copied or moved`,
      `  this project, check whether node_modules (or a parent of it) is a symlink`,
      `  into another tree — a relative link inside one resolves against the link's`,
      `  target, so it can point outside this project while looking correct.`,
    ].join('\n'),
  }
}
