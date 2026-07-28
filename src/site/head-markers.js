/**
 * Stable markers for head content the build injects.
 *
 * Several stages can write the same block: this package's vite plugin
 * (`transformIndexHtml`, which produces `dist/index.html`), this package's
 * prerenderer (which post-processes that HTML per page), and — since the
 * 2026-07-28 seam fix — `@uniweb/runtime`'s `injectPageContent()`, the prerender
 * seam every lane shares. The marker lets a later stage tell "already injected"
 * from "never injected" instead of guessing, so a page passing through several
 * gets exactly one copy.
 *
 * The theme CSS uses `id="uniweb-theme"` on its <style> for the same purpose;
 * <link> tags have no natural id to hang that on, hence the comment marker.
 *
 * **The marker itself now lives in `@uniweb/theming`**, beside the code that
 * generates the block it delimits. This package and `@uniweb/runtime` cannot
 * import one another, but both depend on `@uniweb/theming` — so that is the one
 * home neither has to reach across a dependency boundary to read, and the
 * literal is never duplicated (two halves of a dedupe check that drift apart
 * stop deduping, silently). Re-exported here so every existing import in this
 * package keeps working unchanged.
 *
 * @module @uniweb/build/site
 */

export { FONT_LINKS_MARKER } from '@uniweb/theming'
