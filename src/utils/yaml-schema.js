/**
 * How the build reads YAML — ONE set of types, passed to every `yaml.load`.
 *
 * ⛔ AN UNQUOTED DATE IS THE STRING THE AUTHOR WROTE. js-yaml's default schema resolves
 * `date: 2025-06-01` (and `2025-06-01T10:20:30Z`) to a JS `Date`, so the same value
 * reached the build as a string when quoted and as a Date when not. A Date is neither a
 * string nor a number to `@uniweb/core`'s query evaluator, so, measured before this
 * schema existed:
 *
 *   - a query's fixed `where: { date: { gte: '2025-01-01' } }` compiled to no records,
 *     with no warning;
 *   - `sort: date desc` left the compiled file in filename order;
 *   - the compiled JSON said `2025-06-01T00:00:00.000Z` where the author wrote
 *     `2025-06-01`.
 *
 * ⭐ So this is js-yaml's default schema minus its IMPLICIT timestamp type: numbers,
 * booleans, null and `<<` merge keys resolve exactly as before, and a date or timestamp
 * stays the text it was written as. An explicit `!!timestamp` tag is accepted and yields
 * that text too, so no reader of site content ever receives a Date.
 *
 * ⚠️ READING ONLY. The writers that dump YAML (`uwx/project-writer.js`, `uwx/backfill.js`)
 * keep js-yaml's default, which QUOTES a string that looks like a date or a number — so
 * a written file reads back as the same string in any YAML reader, not only this one.
 *
 * @module @uniweb/build/utils/yaml-schema
 */

import yaml from 'js-yaml'

/** `!!timestamp`, explicit only, constructed as the text it was written as. */
const timestampAsWritten = new yaml.Type('tag:yaml.org,2002:timestamp', {
  kind: 'scalar',
  resolve: (data) => yaml.types.timestamp.resolve(data),
  construct: (data) => data,
})

/** The build's YAML types: the default schema's, with no implicit timestamp. */
export const YAML_SCHEMA = yaml.CORE_SCHEMA.extend({
  implicit: [yaml.types.merge],
  explicit: [timestampAsWritten, yaml.types.binary, yaml.types.omap, yaml.types.pairs, yaml.types.set],
})

/** `yaml.load(text, YAML_OPTIONS)` — the options every reader passes. */
export const YAML_OPTIONS = Object.freeze({ schema: YAML_SCHEMA })
