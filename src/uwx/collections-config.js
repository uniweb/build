// Moved to `../site/collections-config.js` — a site's collection declarations are
// a site-build question first, and keeping the resolver here meant the build could
// not reach it and answered differently. Re-exported so no caller moved.
export {
  resolveCollectionsConfig,
  queriesYmlPath,
  defaultSchema,
  defaultPoolPath,
  deferredFromSchema,
  foundationDataSchemas,
  QUERIES_YML_RELPATH,
} from '../site/collections-config.js'
