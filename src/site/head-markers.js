/**
 * Stable markers for head content the build injects.
 *
 * Two stages can write the same block: the vite plugin's `transformIndexHtml`
 * (which produces `dist/index.html`) and the prerenderer (which post-processes
 * that HTML per page). The marker lets the second stage tell "already injected"
 * from "never injected" instead of guessing, so a page rendered through both
 * paths gets exactly one copy.
 *
 * The theme CSS uses `id="uniweb-theme"` on its <style> for the same purpose;
 * <link> tags have no natural id to hang that on, hence the comment marker.
 *
 * @module @uniweb/build/site
 */

export const FONT_LINKS_MARKER = '<!--uniweb-fonts-->'
