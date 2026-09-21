// A record's `draft: true` — it is a record (it sits in the site's folder) but is
// not delivered while the site is published (ruled 2026-09-21 [Diego]).
//
// ⭐ ONE RULE, READ BY BOTH LANES. The build leaves a draft out of what it delivers —
// the compiled query files a static host serves — and keeps it in `pnpm dev`, where
// the author previews it, as a hidden page stays previewable. A backend holds the
// same state as an entity's `disabled`, which withdraws it from every delivery read.
//
// ⚖️ NOT THE SAME AS A LEADING `_`. A file named `_x.md` is not a record at all: it
// is not read, not pushed, not in the folder. A draft IS a record — the folder has
// it — and only its delivery is withheld.
//
// ⛔ `published: false` WAS THE FILE LANE'S SPELLING until 2026-09-21, and it is
// refused by name rather than read. It was odd per record (a record is not
// published — the site is), and nothing on a backend honoured it. Ignoring it now
// would deliver every record written with it, silently.

/**
 * Is this record a draft?
 *
 * @param {object} data - the record's fields (a markdown record's frontmatter)
 * @param {string} where - the record, for messages (`records/article/x.md`)
 * @returns {boolean}
 * @throws on the retired `published: false`, and on a `draft:` that is not a boolean
 */
export function isDraftRecord(data, where) {
  if (!data || typeof data !== 'object') return false
  if (data.published === false) {
    throw new Error(
      `[uniweb] ${where}: \`published: false\` is retired — a record kept out of what the site ` +
        `delivers is \`draft: true\`. It stays a record, in the folder.`
    )
  }
  const draft = data.draft
  if (draft === undefined || draft === null) return false
  if (typeof draft !== 'boolean') {
    throw new Error(`[uniweb] ${where}: \`draft:\` is true or false, not ${JSON.stringify(draft)}.`)
  }
  return draft
}
