// ⭐ A PULL WRITES THE CHANGE, NOT A NEW RENDERING OF THE FILE.
// A changed body keeps the author's text for every top-level block the backend's document still holds,
// and takes the writer's form only for the blocks it changed, added or moved; a removed one goes.
//
// ⛔ Until 2026-11-04 a changed body was re-serialized whole. Measured that day over the 133 pages of
// three mounted docs folders: a one-word edit rewrote a median of 12 lines — every hard-wrapped
// paragraph joined, every table rule rewritten — in 115 of them.
//
// The blocks are the reader's (`markdownBlocks`, `@uniweb/content-reader`), so a block is what the
// author's text reads as, and a body the reader cannot split so, or whose splice does not read back to
// the document, is written whole as before.

import { markdownBlocks } from '@uniweb/content-reader'
import { proseMirrorToMarkdown } from '@uniweb/content-writer'
import { canonicalJson, sameMarkdownDocument, withoutDefaults } from './same-content.js'

const keyOf = (node) => canonicalJson(withoutDefaults(node))

// The longest run of keys the two lists share, in order: each pair `[i, j]`, `a[i]` equal to `b[j]`.
function commonPairs(a, b) {
  const n = a.length
  const m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  }
  const pairs = []
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (a[i] === b[j]) pairs.push([i++, j++])
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++
    else j++
  }
  return pairs
}

/**
 * The author's body with the backend's document written into it, block by block — or null when it
 * cannot be said so, and the caller writes the document whole.
 *
 * @param {string} authored - the body as the file holds it, frontmatter apart
 * @param {object} doc - the backend's ProseMirror document for it
 * @returns {string|null} the new body, with no trailing whitespace
 */
export function spliceBody(authored, doc) {
  const split = markdownBlocks(authored)
  if (!split || !Array.isArray(doc?.content)) return null
  // Each block that reads to one node is an item; one that reads to none (a link reference) rides
  // with the item before it, kept where it was. A block of several nodes leaves nothing to align.
  const items = []
  let head = split.head
  for (const block of split.blocks) {
    if (block.nodes.length > 1) return null
    if (block.nodes.length === 0) {
      if (items.length) items[items.length - 1].after += block.text + block.after
      else head += block.text + block.after
      continue
    }
    items.push({ text: block.text, after: block.after, key: keyOf(block.nodes[0]) })
  }
  const nodes = doc.content
  const kept = new Map(commonPairs(items.map((i) => i.key), nodes.map(keyOf)).map(([i, j]) => [j, i]))
  // The new body's pieces in the document's order: an item the change left as the author wrote it, or a
  // run of nodes the writer writes.
  const pieces = []
  for (let j = 0; j < nodes.length; j++) {
    if (kept.has(j)) pieces.push({ item: kept.get(j) })
    else if (pieces.length && pieces[pieces.length - 1].nodes) pieces[pieces.length - 1].nodes.push(nodes[j])
    else pieces.push({ nodes: [nodes[j]] })
  }
  let out = pieces[0]?.item === 0 ? head : ''
  pieces.forEach((piece, k) => {
    out += piece.nodes ? proseMirrorToMarkdown({ type: 'doc', content: piece.nodes }).replace(/\s+$/, '') : items[piece.item].text
    const next = pieces[k + 1]
    // Two of the author's blocks still side by side keep what stood between them.
    if (next) out += piece.item !== undefined && next.item === piece.item + 1 ? items[piece.item].after : '\n\n'
  })
  const body = out.replace(/^\n+/, '').replace(/\s+$/, '')
  return sameMarkdownDocument(body, doc) ? body : null
}
