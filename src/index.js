/**
 * @uniweb/build - Foundation Build Tooling
 *
 * Build utilities for Uniweb Foundations.
 */

// Schema discovery and loading
export {
  loadComponentMeta,
  loadFoundationMeta,
  discoverComponents,
  extractRuntimeConfig,
  buildSchema,
  buildRuntimeConfig,
  getExposedComponents,
} from './schema.js'

// Entry point generation
export {
  generateEntryPoint,
  shouldRegenerateEntry,
} from './generate-entry.js'

// Image processing
export {
  processComponentPreviews,
  processAllPreviews,
  processImage,
} from './images.js'

// Vite plugins
export {
  foundationPlugin,
  foundationBuildPlugin,
  foundationDevPlugin,
} from './vite-foundation-plugin.js'

// SSG Prerendering
export {
  prerenderSite,
} from './prerender.js'

// Documentation generation
export {
  generateDocs,
  generateDocsFromSchema,
} from './docs.js'

// Default export is the combined Vite plugin
export { default } from './vite-foundation-plugin.js'
