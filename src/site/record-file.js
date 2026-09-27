/**
 * ⛔ A RECORD'S NAME IS ITS FILE'S NAME — and a file holds one record.
 *
 * [Diego, 2026-09-27] — *"`slug` is a concept that is WRONG. We do not build slugs from this."* A
 * record's name is its name as an entry in its folder (`$name`): the file's name, whole, with no
 * key inside the file to override it. And a file holds ONE record, so that name is always its own.
 * ⛔ Until then a record file's top-level `slug:` renamed the record, and a YAML or JSON file
 * holding a list was one record per entry, each named by its own `slug`.
 *
 * Refused where a record file is read — by the build (`query-processor.js`) and by a push
 * (`uwx/entity-source.js`) alike — naming the file and what to do. A BibTeX file still holds its
 * entries, each named by its cite key: that is the format's own name for an entry, not a key a
 * record carries. A `slug` INSIDE a section is that section's field, the author's data like any
 * other; only the record's own level is refused.
 */

/**
 * @param {*} data - a record file's content: a markdown file's frontmatter, a YAML or JSON file's
 * @param {string} where - the file, for the message
 * @param {string} name - the file's name without its extension — the record's name
 */
export function refuseNotOneRecord(data, where, name) {
  if (Array.isArray(data)) {
    throw new Error(
      `[uniweb] ${where} holds a list of records. A file holds one record, named by the file — ` +
        `write each entry to a file of its own (\`<name>.yml\`, \`<name>.json\`), named as the record is.`
    )
  }
  if (data && typeof data === 'object' && Object.prototype.hasOwnProperty.call(data, 'slug')) {
    throw new Error(
      `[uniweb] ${where}: \`slug:\` names nothing — a record's name is its file's name ("${name}"). ` +
        `Remove the key; to give the record another name, rename the file.`
    )
  }
}
