/**
 * Splitting YAML frontmatter from a markdown body. **The one implementation.**
 *
 * ## Why this file exists
 *
 * There were three, and they disagreed about the only thing that matters — what
 * happens when the YAML does not parse. The success paths were character-for-
 * character identical:
 *
 *   `site/query-processor.js`  threw, named the file, said what was lost, and
 *                              gave the most common cause with its fix
 *   `uwx/entity-source.js`     `catch {}` — silent, and returned `body: raw`
 *   `i18n/freeform.js`         `catch {}` — silent
 *
 * ⛔ **The silent two were on the paths where it costs most.** `entity-source`
 * feeds the sync lane, so a typo'd colon pushed to a backend with the record's
 * frontmatter dropped *and* the broken block embedded in the body — because
 * `body: raw` returns the text including the `---` fence. And `project-writer`'s
 * `writeSectionFile` reads through it before writing back: with `frontmatter`
 * empty, the `key in frontmatter` guard that protects a developer's reserved
 * keys cannot fire, so a pull clobbers them and writes the broken block into the
 * content. A malformed file was being converted into a corrupted one.
 *
 * ## It always throws, and that is the whole design
 *
 * A caller that genuinely wants tolerance says so with a `try`, which is
 * explicit and local — `uwx/records-project.js`'s `readFileUuid` already does
 * exactly that, because "this file does not parse" and "this file is not the one
 * I am looking for" are the same answer to a best-effort probe. Every other
 * caller was tolerant by accident.
 *
 * ## ⚠️ js-yaml, deliberately — do not "upgrade" this to `yaml`
 *
 * `@uniweb/build` carries both. The `yaml` package's Document API preserves
 * comments through a round trip and is used in exactly one place —
 * `site/deploy-config-writer.js` — because that file WRITES BACK to a config a
 * human maintains and must not eat their comments. It is slower and its API is
 * larger, so everything that only READS uses `js-yaml`. This is a read path.
 */

import yaml from 'js-yaml'

/**
 * Split YAML frontmatter from a markdown body.
 *
 * A file with no frontmatter yields an empty mapping and the whole text as
 * body — that is not an error, it is a markdown file.
 *
 * @param {string} raw - the file's full text
 * @param {string} [filepath] - where it came from. Optional only because a
 *   caller may genuinely not have one; pass it whenever you do, since the file
 *   name is the difference between a fixable error and a hunt.
 * @returns {{ frontmatter: object, body: string }}
 * @throws {Error} when a `---` block is present and does not parse as YAML
 */
export function parseFrontmatter(raw, filepath) {
  const text = raw ?? ''
  if (!text.trimStart().startsWith('---')) {
    return { frontmatter: {}, body: text }
  }

  const parts = text.split('---\n')
  if (parts.length < 3) {
    return { frontmatter: {}, body: text }
  }

  try {
    const frontmatter = yaml.load(parts[1]) || {}
    const body = parts.slice(2).join('---\n')
    return { frontmatter, body }
  } catch (err) {
    const where = filepath ? `${filepath}: ` : ''
    throw new Error(
      `${where}frontmatter is not valid YAML — ${err.message}\n` +
        `  The file opens with \`---\`, so it is declaring frontmatter. Since the block does not\n` +
        `  parse, EVERY field in it is lost — title, slug, date, image, category — and the record\n` +
        `  would build as an untitled entry at a slug derived from its filename.\n` +
        `  A common cause is an unquoted value containing a colon followed by a space:\n` +
        `    description: Building on a framework: everything hard is a website problem\n` +
        `  Quote the value and it parses:\n` +
        `    description: "Building on a framework: everything hard is a website problem"`,
      { cause: err },
    )
  }
}
