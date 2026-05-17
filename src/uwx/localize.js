// Single source for the localized-field wire encoding, shared by the
// foundation and site mappers.
//
// Several content-model fields are localized, but the framework's file
// surface carries single strings for them. The exchange wire shape for a
// localized value is `{ "<lang>": value }`. Whether an importer requires
// that map or accepts a bare scalar for a localized field is an importer
// detail — so we wrap under a source locale (default "en", overridable),
// isolated here as one assumption and verified against a reference vector.

export const LOCALIZED_FIELD_ASSUMPTION = Object.freeze({
  wrap: true,
  defaultSourceLocale: 'en',
})

export function localize(value, sourceLocale) {
  if (value == null) return undefined
  // Already a { lang: value } map (author did localize) — pass through.
  if (typeof value === 'object') return value
  return { [sourceLocale]: value }
}
