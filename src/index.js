/**
 * @uniweb/build - Foundation Build Tooling
 *
 * Build utilities for Uniweb Foundations.
 */

// Schema discovery and loading
export {
  loadComponentMeta,
  loadFoundationConfig,
  discoverComponents,
  buildSchema,
  getExposedComponents,
  readFoundationName,
} from './schema.js'

// A foundation's name — the one rule the build, `register` and `push` share
export {
  foundationNameOf,
  checkFoundationName,
  checkRegistrationScope,
  splitFoundationName,
  FORBIDDEN_FOUNDATION_NAMES,
  RESERVED_SCOPES,
} from './foundation-name.js'

// Data-conformance checking (your content vs the schemas your foundation declares)
export {
  validateItem,
  validateDataInputs,
  validateTaggedDataBlocks,
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
// Extension declaration helpers — an extension is a foundation and is declared
// like one, so "is this a URL or a name/ref?" must be decided in ONE place that
// both the wire projection and the CLI's bring-along/validation agree on.
export {
  extensionDeclaration,
  isExtensionUrl,
  isSiteRelativeExtensionUrl
} from './uwx/site.js'
// Where a site finds a workspace extension — one rule, which the build, prerender
// and the dev server follow, for the CLI to ask rather than restate.
export {
  extensionCandidates,
  extensionNameOf,
  findSiteExtension
} from './site/workspace-extension.js'

// Foundation source root resolution (reads package.json::main)
export { resolveFoundationSrcDir, resolveFoundationSrcPath } from './utils/foundation-source-root.js'
export { staleSources, staleSourceNote, unreadFolders } from './foundation/stale-sources.js'

// A library is any local package a foundation depends on: the one rule for what else a foundation's
// build reads, which the CLI's freshness check asks
export { librariesOf } from './foundation/libraries.js'

// Package classification (foundation vs site vs standalone schemas package)
export { classifyPackage, isExtensionPackage, isSchemasPackage } from './utils/classify-package.js'

// Standalone schemas-package discovery (the foundation-less register input)
export { collectStandaloneSchemas } from './resolve-data-schema.js'

// One name in a scope is one type: the names a workspace's packages define twice
export { typesDefinedTwice, packageTypeScope } from './foundation/shared-types.js'

// Default export is the combined Vite plugin
export { default } from './vite-foundation-plugin.js'
