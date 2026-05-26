/**
 * @uniweb/build - Foundation Build Tooling
 *
 * Build utilities for Uniweb Foundations.
 */

// Schema discovery and loading
export {
  loadComponentMeta,
  loadFoundationConfig,
  loadFoundationMeta, // @deprecated - use loadFoundationConfig
  discoverComponents,
  buildSchema,
  getExposedComponents,
} from './schema.js'

// Data-conformance checking (your content vs the schemas your foundation declares)
export {
  validateItem,
  validateDataInputs,
  isStaticallyCheckable,
} from './validate-data.js'

// Entry point generation
export {
  generateEntryPoint,
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

// Foundation config
export { defineFoundationConfig } from './foundation/config.js'

// Site config
export { defineSiteConfig, detectFoundationType } from './site/config.js'

// Foundation source root resolution (reads package.json::main)
export { resolveFoundationSrcDir, resolveFoundationSrcPath } from './utils/foundation-source-root.js'

// Package classification (foundation vs site vs standalone schemas package)
export { classifyPackage, isExtensionPackage, isSchemasPackage } from './utils/classify-package.js'

// Standalone schemas-package discovery (the foundation-less register input)
export { collectStandaloneSchemas } from './resolve-data-schema.js'

// Default export is the combined Vite plugin
export { default } from './vite-foundation-plugin.js'
