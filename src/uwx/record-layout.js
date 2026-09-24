// How one record of a data schema is written in its file — the layout the push reads
// and the pull writes, read off the schema's declaration (`toDataSchemaDeclaration`).
//
// ⭐ FLAT ONLY WHEN THE SCHEMA HAS ONE TOP-LEVEL SECTION HOLDING ONE RECORD — the
// `fields:` shorthand, or a `sections:` schema whose only section is a single one. The
// file's keys are then that section's fields, and nothing is lost either way.
//
// ⭐ EVERY OTHER SCHEMA IS WRITTEN BY SECTION: each top-level section under its own
// name — an object for a single section, a list of records for a `many` one, an object
// of child sections for a binder. That is the stored entity's own shape
// (docs/reference/entity-content.md), so a push sends it and a pull writes it back
// without a mapping in between. A schema whose only section is `many` (`@std/nav`) is
// written this way too — `items: [...]` — since a file whose top level is a list holds
// several records, not one.
//
// ⛔ THE FLAT FORM FOR A MULTI-SECTION SCHEMA IS RETIRED (2026-09-22 [Diego]: "we can
// discontinue the shorthands for multi-section Models"). It matched a file's keys to
// fields across sections by name, and sections are namespaces: a field name two
// sections share got one value in both, a `many` section had no place at all, and a
// pull — writing back only what it could place — returned a record with nothing but its
// brief. Measured before the change: a pulled `@std/article` markdown record came back
// with an empty body.

import { isContentBodyField } from './data-schema.js'

/**
 * @param {object} declaration - `{ name, sections }`
 * @returns {{ flat: boolean, sections: Array<[string, object]>, brief: string|null }}
 *   `sections` — the top-level sections in declared order; `brief` — the section the
 *   declaration marks `brief: true`, or null when it marks none.
 */
export function recordFileLayout(declaration) {
  const sections = Object.entries(declaration?.sections || {}).filter(([, s]) => s && typeof s === 'object')
  const flat = sections.length === 1 && sections[0][1].multiple !== true
  const brief = sections.find(([, s]) => s.brief === true)?.[0] ?? null
  return { flat, sections, brief }
}

/**
 * The schema's CONTENT body field — the one a `.md` record's markdown body fills: a
 * markup `text` field (`format: markdown|html`) or a `format: prosemirror` json field,
 * declared directly on a top-level single section — the brief or another, like
 * `@std/article`'s `article_body.content`. The first in declared order.
 *
 * ⛔ Not the brief's alone. Until 2026-09-24 the pull and the per-locale body override
 * looked only in the brief, while the push looked in every single section, so a body
 * declared outside the brief was pushed and then neither translated nor pulled back.
 *
 * @param {object} declaration
 * @returns {{ target: { section: string, key: string, field: object }|null, count: number }}
 */
export function contentBodyTarget(declaration) {
  const matches = []
  for (const [section, def] of recordFileLayout(declaration).sections) {
    if (def.multiple === true) continue
    for (const [key, field] of Object.entries(def.fields || {})) {
      if (isContentBodyField(field)) matches.push({ section, key, field })
    }
  }
  return { target: matches[0] || null, count: matches.length }
}
