/**
 * Derive the host services a foundation is built against, from its own bundle.
 *
 * ## The one idea
 *
 * A foundation declares `uniweb.supports` in `package.json` so a consumer can
 * tell "this foundation draws a search box" from "this foundation has never
 * heard of search". The declaration is authored, and an author who never learns
 * the key exists never writes one — which is the failure the field was added to
 * prevent, reappearing one level up.
 *
 * ⭐ **But the bundler already knows.** `@uniweb/kit` is not externalized
 * (`DEFAULT_EXTERNALS` is the react entries plus the bare `@uniweb/core`), so
 * kit's service code is compiled into the foundation and tree-shaken with it.
 * A module that survives that shake is a module something reachable uses.
 *
 * So this reads the answer off the module graph instead of asking for it, and
 * `package.json` becomes the *supplement* for what the graph cannot see rather
 * than the declaration itself.
 *
 * ## ⛔ POST-TREE-SHAKE ONLY — the pre-shake graph OVER-REPORTS
 *
 * Rollup parses modules it later discards, so `getModuleIds()` includes code
 * that was shaken out. Measured 2026-09-06 on `templates/services`, which uses
 * submit and not search:
 *
 * | scanned | literals found |
 * |---|---|
 * | the whole graph (`getModuleIds()`) | ⛔ `search, submit` |
 * | survivors only (`renderedLength > 0`) | ✅ `submit` |
 *
 * 475 modules parsed, 28 survived. ⇒ **Over-reporting is the dangerous
 * direction** — it tells a host to offer a service the foundation never draws,
 * which is exactly the invisible failure this whole mechanism exists to stop.
 * Never widen the scan set to "everything Rollup saw".
 *
 * ## ⭐ The service name travels with the code, so there is almost no map
 *
 * `kit/src/utils/submitTarget.js` contains `resolveService(website, 'submit')`
 * in its own source and survives beside the hook that pulled it in. So scanning
 * survivors for that call recovers the name without anyone maintaining a
 * module→service table — and it covers the **open registry** for free: a
 * foundation that invents `booking` is read the same way as one that uses
 * `submit`, because the framework has no list of permitted names
 * (`core/src/services.js`).
 *
 * ## ⛔ `tracking` IS NEVER EMITTED — AND THAT IS NOT A DETECTION GAP
 *
 * ⭐ **Tracking renders nothing.** This field exists because a service with no
 * surface to draw is invisible from outside — a search endpoint with no search
 * box. But the runtime emits `page_view` / `outbound_click` / `section_view` for
 * every foundation alike (`wireTracker`), so a foundation neither supplies nor
 * withholds tracking, and under the three-state rule (*these and only these*)
 * emitting it conditionally **asserts something false about every foundation that
 * does not call these** — not a missing niche capability.
 *
 * ⛔ **So do not "fix" the obvious misses.** `block.track()` (a method in
 * externalized core, invisible here) and `kit/src/hooks/useReadingDepth.js` both
 * emit custom events and derive nothing. **A matcher for either was considered
 * and rejected**, along with a separate `own-events` name. There is nothing here
 * to detect. `NEVER_EMITTED` below is what enforces it, because the generic
 * `isServiceEnabled` matcher would otherwise pick the name back up from any
 * `isTrackingEnabled()` call.
 *
 * One gate needs help, and only one:
 *
 *   - **`isSearchEnabled()`** is a `Website` method, and its literal is in
 *     `core/src/website.js` — external, so never a survivor. The call is the
 *     signal.
 *
 * ⚠️ **`records` is not derived here at all** — its resolver is in externalized
 * core too, so nothing naming it survives the shake. It comes from the component
 * schema instead (`declaredKeys`, applied in `build/src/schema.js`), which is a
 * second derivation over a different artifact.
 *
 * ⚠️ `@uniweb/api` deliberately needs no entry: it calls
 * `resolveService(website, SERVICE_NAME)` against a module-level `const`, which
 * `readModuleConsts` resolves. Without that resolution `api` would be both
 * missed *and* counted as blindness, marking every foundation that uses it
 * unknowable.
 *
 * ## Why the AST rather than a regex
 *
 * The probe that produced the table above also found its only "computed call
 * site" inside a **JSDoc comment** in `core/src/services.js` describing the
 * signature, and `export function resolveService(website, name)` is a
 * declaration a regex reads as a call with a variable argument. Both vanish on
 * an AST, and Rollup has already parsed every module — `info.ast` was present
 * for all 475 — so this costs a walk, not a parse.
 *
 * @module @uniweb/build/foundation/derive-supports
 */

import { declaredKeys } from '@uniweb/core/data-keys'

/**
 * Service names this never emits, however a foundation reaches for them.
 *
 * ⛔ **Excluding a name is not the same as failing to detect one**, which is why
 * this is a list and not an omission. `tracking` arrives through the generic
 * `isServiceEnabled` matcher from any `isTrackingEnabled()` call, so deleting
 * the old module rule was not enough on its own — a foundation that guards a
 * consent banner would have put the name back.
 *
 * See the header: a service with no rendered surface cannot be claimed or
 * withheld by a foundation, and naming it conditionally asserts a falsehood
 * about every foundation that does not call these.
 */
const NEVER_EMITTED = new Set(['tracking'])

/** The names in `names` that this field may carry. */
function nameable(names) {
  return names.filter((s) => !NEVER_EMITTED.has(s))
}

/**
 * The names in `names` that it may not — for the caller's warning.
 *
 * Exported because an AUTHORED name is dropped too (`composeSupports`), and a
 * developer who typed one deserves to be told rather than to find it missing
 * from the registry.
 */
export function unnameableIn(names) {
  return (names || []).filter((s) => NEVER_EMITTED.has(s))
}

/**
 * Walk an ESTree tree, visiting every node.
 *
 * Hand-rolled rather than pulled from a dependency: `@uniweb/build` is on the
 * install path of every foundation, and this is a dozen lines.
 */
function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (typeof node.type === 'string') visit(node)
  for (const key in node) {
    if (key === 'type' || key === 'loc' || key === 'range' || key === 'start' || key === 'end') {
      continue
    }
    const value = node[key]
    if (value && typeof value === 'object') walk(value, visit)
  }
}

/**
 * Module-scope `const NAME = 'string'` bindings.
 *
 * ⛔ Top level only, deliberately. A nested binding of the same name would
 * shadow, and resolving one could name a service the code never asks for —
 * over-reporting, the direction that must not happen. An unresolved identifier
 * is treated as blindness instead, which is the safe answer.
 */
function readModuleConsts(ast) {
  const consts = new Map()
  const record = (decl) => {
    if (!decl || decl.type !== 'VariableDeclaration') return
    for (const d of decl.declarations || []) {
      if (d.id?.type === 'Identifier' && typeof d.init?.value === 'string') {
        consts.set(d.id.name, d.init.value)
      }
    }
  }
  for (const node of ast.body || []) {
    record(node)
    if (node.type === 'ExportNamedDeclaration') record(node.declaration)
  }
  return consts
}

/** `resolveService(...)`, called bare or through a namespace. */
function isResolveServiceCall(node) {
  if (node.type !== 'CallExpression') return false
  const callee = node.callee
  if (callee?.type === 'Identifier') return callee.name === 'resolveService'
  if (callee?.type === 'MemberExpression' && !callee.computed) {
    return callee.property?.name === 'resolveService'
  }
  return false
}

/**
 * A `.isServiceEnabled(name)` call on anything.
 *
 * ⛔ **Its name argument is at index 0, not 1.** `resolveService(website, name)`
 * passes the website first; the method form has already bound it as the
 * receiver. Reading index 1 here would find `undefined`, fall to the blind
 * branch, and under-report `uniweb.supports` with a warning nobody is watching
 * for — which is why `derive-supports.test.js` asserts a foundation calling
 * `isSubmitEnabled()` derives `submit`.
 *
 * ⭐ This is how every `@uniweb/kit` service predicate is seen: they compile to
 * `website.isServiceEnabled('<name>')`, and kit is bundled into the foundation,
 * so the literal survives the shake. One matcher covers all of them — the name
 * is an argument, so the family does not grow a rule per service.
 */
function isServiceEnabledCall(node) {
  return (
    node.type === 'CallExpression' &&
    node.callee?.type === 'MemberExpression' &&
    !node.callee.computed &&
    node.callee.property?.name === 'isServiceEnabled'
  )
}

/** A `.isSearchEnabled()` call on anything. */
function isSearchEnabledCall(node) {
  return (
    node.type === 'CallExpression' &&
    node.callee?.type === 'MemberExpression' &&
    !node.callee.computed &&
    node.callee.property?.name === 'isSearchEnabled'
  )
}

/**
 * The set of modules that contributed code to the written bundle.
 *
 * `renderedLength > 0` is the discriminator: a module whose every binding was
 * shaken out contributes nothing, and counting it would reintroduce exactly the
 * over-reporting this module exists to avoid.
 */
function collectSurvivors(bundle) {
  const survivors = new Set()
  for (const chunk of Object.values(bundle || {})) {
    if (chunk?.type !== 'chunk' || !chunk.modules) continue
    for (const [id, mod] of Object.entries(chunk.modules)) {
      if (mod?.renderedLength > 0) survivors.add(id)
    }
  }
  return survivors
}

/**
 * Derive the services this foundation reaches for.
 *
 * Three call shapes are read, and two of them carry the name as an argument so
 * they cover the open registry without a rule per service:
 * `resolveService(website, name)`, `website.isServiceEnabled(name)` (what every
 * `@uniweb/kit` predicate compiles to), and the one hand-written gate,
 * `isSearchEnabled()`. Names in `NEVER_EMITTED` are dropped from the result.
 *
 * @param {object} bundle - Rollup's bundle, as handed to `writeBundle`
 * @param {object} ctx - the Rollup plugin context (`this` in the hook)
 * @returns {{services: string[], blind: boolean, blindAt: string[]}}
 *   `services` is sorted and de-duplicated, and is a **lower bound**.
 *   `blind` is true when a `resolveService` call names its service with
 *   something this cannot read — the one case where the lower bound is known to
 *   be incomplete, and the caller must not report an empty result as a proven
 *   "none". `blindAt` names the modules, for the warning.
 */
export function deriveSupports(bundle, ctx) {
  const services = new Set()
  const blindAt = new Set()

  for (const id of collectSurvivors(bundle)) {
    const info = ctx?.getModuleInfo?.(id)
    const ast = info?.ast
    if (!ast) continue

    const consts = readModuleConsts(ast)

    walk(ast, (node) => {
      if (isSearchEnabledCall(node)) {
        services.add('search')
        return
      }
      const isMethod = isServiceEnabledCall(node)
      if (!isMethod && !isResolveServiceCall(node)) return

      // The name is argument 0 on the method (the website is the receiver) and
      // argument 1 on the free function. Getting this wrong under-reports.
      const arg = node.arguments?.[isMethod ? 0 : 1]
      if (typeof arg?.value === 'string') {
        services.add(arg.value)
      } else if (arg?.type === 'Identifier' && consts.has(arg.name)) {
        services.add(consts.get(arg.name))
      } else {
        // A name this cannot read. Not an error — a foundation may legitimately
        // compute one — but it means the derived set is short by an unknown
        // amount, and the caller has to say so rather than claim completeness.
        blindAt.add(id)
      }
    })
  }

  return {
    services: nameable([...services]).sort(),
    blind: blindAt.size > 0,
    blindAt: [...blindAt].sort(),
  }
}

/**
 * Does this foundation support `records`?
 *
 * ⭐ **The second derivation, over a different artifact.** `records` has no
 * module-graph signature — `resolveRecordsService` is in externalized core, so
 * nothing naming it survives a foundation's tree-shake. The evidence is the
 * component schema instead.
 *
 * Since the 2026-09-14 ruling a section receives only the `data:` keys it
 * declares (`assembleData`, `runtime/src/prepare-props.js`), so a foundation
 * declaring none at either tier can never deliver a record to anything.
 *
 * ⛔ **Key presence, not ref presence.** A `data:` entry may name a schema, but
 * that is a shape hint; the Model ref deciding whether records are live or
 * static is on the site's QUERY, defaulted to the query's own name, and is
 * chosen after this foundation is registered. Counting only ref-bearing entries
 * measured backwards across the templates: it named the forms template and
 * missed the one built to demonstrate query-driven pages.
 *
 * What it claims: *given query results, this foundation will render them* — not
 * that any site supplies them. A declared key may equally be filled by a data
 * block authored inline in the markdown (`block.heldData`).
 *
 * @param {Object} components - componentName → meta, each with its `data:`
 * @param {Object|false|null|undefined} foundationData - `main.js` `data:`
 * @returns {boolean}
 */
export function deriveRecordsSupport(components, foundationData) {
  // The foundation tier reaches every section, so one key there is enough — and
  // it is checked separately because a foundation declaring one still supports
  // records when it has no components of its own.
  if (declaredKeys(undefined, foundationData).length > 0) return true
  return Object.values(components || {}).some((meta) => declaredKeys(meta?.data).length > 0)
}

/**
 * Compose what the foundation publishes from the authored and derived halves.
 *
 * ## ⛔ THE THREE STATES SURVIVE, AND TWO OF THEM ARE NOT THE SAME
 *
 * `info.supports` carries three values and a consumer distinguishes all of them:
 * **absent** is UNKNOWN — nobody said — **`[]`** is an explicit none, and a list
 * is *these and only these*. Returning `{}` versus `{ supports: [] }` is how
 * that distinction reaches the wire, so neither branch below may be collapsed
 * into the other. It is the same three-state rule `info.runtime` states in the
 * same brief: an omission is UNKNOWN rather than unconstrained, because a floor
 * nobody stated cannot be shown to be satisfied.
 *
 * | authored | derived | emitted |
 * |---|---|---|
 * | absent | some | the derived set |
 * | absent | none, nothing blind | ⭐ `[]` — a **proven** none, not an assumed one |
 * | absent | none, something blind | ⛔ nothing — UNKNOWN, honestly |
 * | a list | any | the union |
 * | `[]` | some | the union, with a warning: the evidence contradicts the claim |
 *
 * ⭐ **The union only ever grows the set**, so the failure the authored-only
 * design guarded against — publishing a set shorter than the truth — stays
 * unreachable: whatever a developer wrote is still there.
 *
 * @param {string[]|undefined} authored - normalized `uniweb.supports`; `undefined` when absent
 * @param {{services: string[], blind: boolean}|null} derived - null when not derived (a dev rebuild)
 * @returns {{supports?: string[]}} spread into `_self`; `{}` keeps the key absent
 */
export function composeSupports(authored, derived) {
  // An authored name this field may not carry is dropped HERE rather than at
  // its source: `package.json` is the developer's file, and rewriting it is
  // `doctor --fix`'s job. `reportSupports` says what was dropped and why.
  // ⛔ Absence must survive the filter — `undefined` is UNKNOWN, `[]` is a
  // declaration, and mapping one to the other loses a state.
  const declared = authored === undefined ? undefined : nameable(authored)

  // No derivation ran (dev rebuild): the authored value is the whole answer,
  // and an absent one stays absent.
  if (!derived) return declared === undefined ? {} : { supports: declared }

  const { services, blind } = derived

  if (declared === undefined && services.length === 0) {
    return blind ? {} : { supports: [] }
  }

  const union = [...new Set([...(declared || []), ...services])].sort()
  return { supports: union }
}
