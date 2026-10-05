/**
 * Runtime Schema Extractor
 *
 * Extracts lean runtime-relevant metadata from full meta.js files — what a published page
 * reads to render, and nothing else:
 *
 * - background: 'self' when component handles its own background
 * - data: { <key>: <schema ref> | null } — every `content.data` key the component
 *     declares, in order, with its schema ref (null for an inline shape)
 * - vars: { <name>: { default? } } — the CSS variables the component declares
 * - defaults: param default values
 * - context: static capabilities for cross-block coordination
 * - initialState: initial values for mutable block state
 *
 * ⭐ `data:` IS THE DELIVERY — ruled 2026-09-14 [Diego]: a section's `content.data` holds
 * the keys its component declares and nothing else, and which fetch fills each is worked
 * out at render from the keys and their schema refs (`@uniweb/core` `fillDeclaredKeys`).
 * A component with no `data:`, or `data: false`, receives none of its own. ⛔ Until then
 * delivery was default-on — every key that reached a section — and `data:` was a hint for
 * defaults and the editor; `data: false` was the opt-out, emitted as `inheritData: false`.
 *
 * ⛔ NO FIELD DEFAULTS — ruled 2026-10-05 [Diego]. Each declared key also carried `schemas`
 * until then — its schema's field defaults, with `enum` and the nesting that led to them — and
 * the runtime filled a missing field from its `default` and replaced a value its `enum`
 * rejected. A missing field is the record's own fact, and what it renders as is the
 * component's choice; a copy frozen into the bundle drifts from the schema it was taken from;
 * and checking a value is `uniweb validate`'s and the push's job, not the page's. A form in
 * `data:` is the editor's, for authoring the block: none of it reaches the runtime.
 * ⛔ Nor `inset` (an editor's flag — an inset is found by name) or a layout's `areas` (a page's
 * areas are its site's `layout/` folder): no runtime reader read either, until 2026-10-05.
 *
 * Full metadata (titles, descriptions, hints, etc.) stays in schema.json
 * for the visual editor.
 */

import { lowerData } from '@uniweb/schemas/content'

/**
 * A `data:` entry's schema ref — a ref string, or `{ schema }` — or null for an inline
 * shape, which names no schema and is filled only under its own key.
 *
 * @param {string|Object} value
 * @returns {string|null}
 */
function dataRef(value) {
  if (typeof value === 'string') return value || null
  return value && typeof value === 'object' && typeof value.schema === 'string' && value.schema ? value.schema : null
}

/**
 * Extract param defaults from params object
 *
 * @param {Object} params - The params object from meta.js
 * @returns {Object|null} - Object of { paramName: defaultValue } or null if empty
 */
function extractParamDefaults(params) {
  if (!params || typeof params !== 'object') {
    return null
  }

  const defaults = {}

  for (const [key, param] of Object.entries(params)) {
    if (param && typeof param === 'object' && param.default !== undefined) {
      defaults[key] = param.default
    }
  }

  return Object.keys(defaults).length > 0 ? defaults : null
}

/**
 * A section type's CSS variables as the runtime reads them: every declared name, with its
 * `default` when it has one. `Block.mergeComponentVars` (`@uniweb/core`) emits each default
 * on the section and takes a section's `vars:` value only for a name declared here, so a
 * var with no default still needs its name. A label, a type, options and a description are
 * the editor's. A shorthand value (`'card-gap': '1.5rem'`) is written as its `default`.
 *
 * ⛔ Not emitted until 2026-10-05, while core read it since 2026-03-02: a section type's
 * `vars:` reached no page, and neither did a section's `vars:` for them.
 *
 * @param {Object} vars - the `vars:` of a meta.js
 * @returns {Object|null} `{ <name>: { default? } }`, or null when none is declared
 */
function leanComponentVars(vars) {
  if (!vars || typeof vars !== 'object' || Array.isArray(vars)) return null
  const out = {}
  for (const [name, config] of Object.entries(vars)) {
    if (config !== null && typeof config === 'object' && !Array.isArray(config)) {
      out[name] = config.default !== undefined ? { default: config.default } : {}
    } else {
      out[name] = config === null || config === undefined ? {} : { default: config }
    }
  }
  return Object.keys(out).length > 0 ? out : null
}

/**
 * Extract lean runtime schema from a full meta.js object
 *
 * @param {Object} fullMeta - The full meta.js default export
 * @returns {Object|null} - Lean runtime schema or null if empty
 */
export function extractRuntimeSchema(fullMeta) {
  if (!fullMeta || typeof fullMeta !== 'object') {
    return null
  }

  const runtime = {}

  // Background opt-out: 'self' means the component renders its own background
  // layer (solid colors, insets, effects), so the runtime skips its Background.
  if (fullMeta.background) {
    runtime.background = fullMeta.background
  }

  // Data. `data:` is the single declaration surface for a section's structured
  // data: it maps each `content.data` key to its schema. A value is a named ref
  // (`'@/member'`), an inline field map, or an inline rich-form (`{ fields: [...] }`,
  // an editor form). Source-agnostic — the data may arrive by fetch, tagged code
  // block, or editor form, and it reaches the component as it arrived.
  //
  // ⭐ Every key reaches the runtime — `data` lists them with their refs, because the keys
  // ARE what the section receives, and a key's ref is what a fetch of another name fills
  // it by. Its shape stays in schema.json, for the editor. `data: false` declares nothing,
  // as no `data:` does.
  //
  // ⭐ A concept block's key is written as its fence is — `'md:faq': 'Questions and
  // answers'` — and lowered to the key a component reads, `faq`, with no schema: the value
  // is the author's label, never a ref (`lowerData`; ruled 2026-09-29). A built entry is
  // already lowered; this holds for a `meta.js` handed in as written.
  const data = lowerData(fullMeta.data)
  if (data === false) {
    // declares no key
  } else if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const [key, value] of Object.entries(data)) {
      // ⛔ A value that is no schema at all declares a key by accident — it would reach the
      // component as `null`, silently. `data: { inherit: [...] }` — the opt-in to cascaded
      // data from 2026-01-31 until declared keys replaced it — is the shape this refuses: it
      // declared a key named `inherit`.
      if (typeof value !== 'string' && value !== null && (typeof value !== 'object' || Array.isArray(value))) {
        throw new Error(
          `[uniweb] Invalid 'data.${key}' in meta.js: expected a named ref ('@/x'), an inline field map, ` +
            `a rich-form { fields: [...] }, or {} for a key with no schema — got ${JSON.stringify(value)}.` +
            (key === 'inherit'
              ? " `data: { inherit: [...] }` is retired: declare each key the component reads, e.g. `data: { members: {} }`."
              : '')
        )
      }
      runtime.data = runtime.data || {}
      runtime.data[key] = dataRef(value)
    }
  } else if (data !== undefined) {
    throw new Error(
      `[uniweb] Invalid 'data' in meta.js: expected false or { <key>: <schema> }, got ${JSON.stringify(data)}. ` +
        "A <schema> is a named ref ('@/x'), an inline field map, or a rich-form { fields: [...] }."
    )
  }

  const vars = leanComponentVars(fullMeta.vars)
  if (vars) {
    runtime.vars = vars
  }

  const paramsObj = fullMeta.params
  const defaults = extractParamDefaults(paramsObj)
  if (defaults) {
    runtime.defaults = defaults
  }

  // Context - static capabilities for cross-block coordination
  // e.g., { allowTranslucentTop: true } for Hero components
  if (fullMeta.context && typeof fullMeta.context === 'object') {
    runtime.context = fullMeta.context
  }

  // Initial state - default values for mutable block state
  // e.g., { expanded: false } for accordion-like components
  if (fullMeta.initialState && typeof fullMeta.initialState === 'object') {
    runtime.initialState = fullMeta.initialState
  }

  return Object.keys(runtime).length > 0 ? runtime : null
}

/**
 * Extract runtime schemas for all components
 *
 * @param {Object} componentsMeta - Map of componentName -> meta.js content
 * @returns {Object} - Map of componentName -> runtime schema (excludes null entries)
 */
export function extractAllRuntimeSchemas(componentsMeta) {
  const schemas = {}

  for (const [name, meta] of Object.entries(componentsMeta)) {
    const schema = extractRuntimeSchema(meta)
    if (schema) {
      schemas[name] = schema
    }
  }

  return schemas
}

/**
 * Extract lean runtime schema for a layout from its full meta.js
 *
 * Layout runtime metadata:
 * - transitions: View transition name overrides (the runtime auto-names areas;
 *   this overrides per region, or `false` opts the layout out)
 * - defaults: Param default values
 * - scroll: Scroll management mode ('self' or CSS selector)
 * - layers: Stacking order of the area wrappers (object, or false to opt out)
 *
 * @param {Object} fullMeta - The full meta.js default export for a layout
 * @returns {Object|null} - Lean layout runtime schema or null if empty
 */
export function extractLayoutRuntimeSchema(fullMeta) {
  if (!fullMeta || typeof fullMeta !== 'object') {
    return null
  }

  const runtime = {}

  // ⛔ No `areas`: the areas a page renders are its site's `layout/` folder
  // (`Website.getLayoutAreas`), and a layout's list of them is for the editor.

  // `false` is a value, not an absence: it is the documented way a layout opts
  // out of per-area view transitions. The previous guard was
  // `fullMeta.transitions && typeof … === 'object'`, which is false for `false`
  // — so the opt-out was dropped here and never reached the runtime, even
  // though `resolveLayoutTransitions` has always handled it. Same for `layers`.
  if (fullMeta.transitions === false || (fullMeta.transitions && typeof fullMeta.transitions === 'object')) {
    runtime.transitions = fullMeta.transitions
  }

  // Stacking order of the area wrappers. Carried whether or not the layout
  // declares transitions, because an explicit layer is itself a reason to wrap.
  if (fullMeta.layers === false || (fullMeta.layers && typeof fullMeta.layers === 'object')) {
    runtime.layers = fullMeta.layers
  }

  if (fullMeta.scroll !== undefined) {
    runtime.scroll = fullMeta.scroll
  }

  const defaults = extractParamDefaults(fullMeta.params)
  if (defaults) {
    runtime.defaults = defaults
  }

  return Object.keys(runtime).length > 0 ? runtime : null
}

/**
 * Extract runtime schemas for all layouts
 *
 * @param {Object} layoutsMeta - Map of layoutName -> meta.js content
 * @returns {Object} - Map of layoutName -> layout runtime schema (excludes null entries)
 */
export function extractAllLayoutRuntimeSchemas(layoutsMeta) {
  const schemas = {}

  for (const [name, meta] of Object.entries(layoutsMeta)) {
    const schema = extractLayoutRuntimeSchema(meta)
    if (schema) {
      schemas[name] = schema
    }
  }

  return schemas
}

/**
 * ⭐ WHAT THE RUNTIME READS OF A FOUNDATION'S `main.js` — and nothing else of it. Ruled
 * 2026-10-01 [Diego]: *"Only what runtime really reads for rendering should reach it."*
 *
 * Read off every runtime reader of the entry's `capabilities` (2026-10-01): core's `Uniweb` and
 * `Website`, the runtime's wiring, navigation and scroll, `@uniweb/theming`, kit's xref, the
 * fetch dispatcher, and press. Two kinds:
 *
 *   code  `handlers`, `defaultInsets`, `xref`, `transports`, `outputs` — functions and
 *         components, so the entry REFERENCES each from the module and the bundler drops the rest
 *         of `main.js`'s default export.
 *   data  `defaultLayout`, `defaultSection`, `viewTransitions`, `scroll`; `vars`, each var's
 *         `default`, `type` and `applyTo` — all `@uniweb/theming` reads; `data`, each key's schema
 *         ref — all `declaredKeys` reads. Written as a literal, like a section type's lean schema.
 *
 * ⛔ Never: `name`, `description`, `extension`, a var's label or description, a data key's shape,
 * or any key the framework does not read. ⛔ Until 2026-10-01 the entry spread the whole default
 * export into `capabilities`, and a foundation's name and its vars' descriptions shipped in every
 * published bundle.
 *
 * A data key whose value is not plain data (a function, say) is referenced like code, so nothing
 * is lost to serialization.
 *
 * @param {Object} config - the foundation's `main.js`, as `loadFoundationConfig` reads it
 * @returns {{ code: string[], data: Object }} the code keys to reference, and the data to inline
 */
export function extractFoundationRuntime(config = {}) {
  const code = RUNTIME_CODE_CAPABILITIES.filter((key) => config?.[key] !== undefined)
  const data = {}
  for (const key of RUNTIME_DATA_CAPABILITIES) {
    const value = config?.[key]
    if (value === undefined) continue
    if (isPlainData(value)) data[key] = value
    else code.push(key)
  }
  const vars = leanVars(config?.vars)
  if (vars) data.vars = vars
  const keys = leanDataKeys(config?.data)
  if (keys) data.data = keys
  return { code, data }
}

/** The `main.js` capabilities the runtime calls or renders — referenced, never copied. */
export const RUNTIME_CODE_CAPABILITIES = ['handlers', 'defaultInsets', 'xref', 'transports', 'outputs']

/** The `main.js` values the runtime reads as data — written into the entry. */
const RUNTIME_DATA_CAPABILITIES = ['defaultLayout', 'defaultSection', 'viewTransitions', 'scroll']

/** What `@uniweb/theming` reads of a foundation var: its value, its kind, and a font role's selectors. */
const RUNTIME_VAR_FIELDS = ['default', 'type', 'applyTo']

function leanVars(vars) {
  if (!vars || typeof vars !== 'object' || Array.isArray(vars)) return null
  const out = {}
  for (const [name, config] of Object.entries(vars)) {
    if (config !== null && typeof config === 'object' && !Array.isArray(config)) {
      const lean = {}
      for (const field of RUNTIME_VAR_FIELDS) if (config[field] !== undefined) lean[field] = config[field]
      out[name] = lean
    } else {
      out[name] = config
    }
  }
  return Object.keys(out).length > 0 ? out : null
}

/** A foundation's `data:` as a section type's lean `data` is: each key → its schema ref, or null. */
function leanDataKeys(data) {
  const lowered = lowerData(data)
  if (!lowered || typeof lowered !== 'object' || Array.isArray(lowered)) return null
  const out = {}
  for (const [key, value] of Object.entries(lowered)) out[key] = dataRef(value)
  return Object.keys(out).length > 0 ? out : null
}

function isPlainData(value) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true
  if (Array.isArray(value)) return value.every(isPlainData)
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.values(value).every(isPlainData)
  }
  return false
}
