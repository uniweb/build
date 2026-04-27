/**
 * Cross-reference registry — populated at content-collection time.
 *
 * Walks the parsed document tree to find every block-level element
 * carrying a {#id} attribute, infers the element's kind from its node
 * type, and records the entry with a per-kind counter. The result
 * attaches to siteContent.xref and is consumed by the framework's
 * <Ref> component to render `[#id]` cross-references.
 *
 * Built-in kinds:
 *   - heading      → 'section'   (hierarchical counter: 1, 1.1, 1.1.1, 2, …)
 *   - image        → 'figure'    (flat arabic counter)
 *   - math_display → 'equation'  (flat arabic counter)
 *   - table        → 'table'     (flat arabic counter)
 *
 * Foundation extensions: foundations may declare additional kinds via
 * `foundation.xref.kinds`. The id-collection pass uses the foundation's
 * declared `prefix` (e.g. `thm` → `theorem`) to classify ids that don't
 * land on a built-in element type.
 *
 * The registry is per-document, not per-page: counters span the whole
 * document so authors get consistent numbering even when their document
 * spans multiple pages. (For page-local counter resets, foundations can
 * declare `resetOn: 'chapter'` on a kind — applied during render, not
 * here.)
 *
 * Output shape:
 *   {
 *     entries: {
 *       <id>: {
 *         id,            // the id itself
 *         kind,          // 'figure' | 'equation' | 'section' | 'table' | <foundation-declared>
 *         counter,       // number for flat kinds, dotted string for hierarchical
 *         counterText,   // displayable counter ('3', '3.2')
 *         sourcePath,    // page route the id was declared on (for back-refs)
 *         caption,       // (figures, tables) caption attr, when set
 *         text,          // (sections) heading's plain text content
 *         latex,         // (equations) latex source for the equation
 *       },
 *     },
 *   }
 *
 * `caption`, `text`, and `latex` are populated only for the elements
 * that carry them — they're undefined on other kinds. List sections
 * (ListOfFigures / ListOfTables / TableOfContents) read these to render
 * "Figure 3 — A diagram of mitosis ........ 47" entries without
 * re-walking the document tree. Other consumers (the framework's <Ref>
 * component, Typst / LaTeX cross-reference emitters) ignore them.
 */

const KIND_BY_TYPE = {
  heading: 'section',
  image: 'figure',
  math_display: 'equation',
  table: 'table',
}

export function buildXrefRegistry(siteContent, options = {}) {
  const { foundationKinds = {}, onWarn = (msg) => console.warn(msg) } = options

  const entries = {}
  const flatCounters = {}     // kind -> next integer counter (figure, equation, table, foundation-declared kinds)
  const sectionStack = []     // hierarchical counters per heading level

  // Index foundation prefixes for id-prefix inference.
  const prefixToKind = {}
  for (const [kind, meta] of Object.entries(foundationKinds)) {
    if (meta?.prefix) prefixToKind[meta.prefix] = kind
  }

  function nextFlat(kind) {
    flatCounters[kind] = (flatCounters[kind] || 0) + 1
    return flatCounters[kind]
  }

  // Track the shallowest heading depth seen — chapter content commonly
  // starts at h2 (chapter title is rendered separately as h1 by the
  // foundation), so the first encountered level becomes the document's
  // top counter level. Re-anchoring: if a later heading appears at a
  // shallower level than `topLevel`, drop topLevel down to match.
  let topLevel = null

  function nextHierarchical(level) {
    if (topLevel == null || level < topLevel) topLevel = level
    const depth = level - topLevel + 1  // 1-based depth from the document's top level

    // Trim deeper levels when surfacing back to a shallower heading.
    while (sectionStack.length >= depth) sectionStack.pop()
    while (sectionStack.length < depth - 1) sectionStack.push(1) // implicit parents start at 1
    sectionStack.push((sectionStack[depth - 1] || 0) + 1)
    sectionStack.length = depth
    return sectionStack.slice().join('.')
  }

  // Collect the plain text content of a node tree — used to capture a
  // heading's displayable text for ListOfSections-style entries. Walks
  // the standard ProseMirror text shape (text nodes carry `.text`;
  // structural nodes recurse via `.content`).
  function collectTextContent(node) {
    if (!node || typeof node !== 'object') return ''
    if (node.type === 'text' && typeof node.text === 'string') return node.text
    if (Array.isArray(node.content)) {
      return node.content.map(collectTextContent).join('')
    }
    return ''
  }

  function inferKind(node) {
    // 1. Node-type-based: built-ins.
    const builtin = KIND_BY_TYPE[node.type]
    if (builtin) return builtin
    // 2. Explicit kind attribute on the node ({.kind} or kind=…).
    if (node.attrs?.kind && (KIND_BY_TYPE[node.attrs.kind] || foundationKinds[node.attrs.kind])) {
      return node.attrs.kind
    }
    // 3. Foundation-declared prefix on the id.
    const id = node.attrs?.id
    if (id && id.includes('-')) {
      const prefix = id.slice(0, id.indexOf('-'))
      if (prefixToKind[prefix]) return prefixToKind[prefix]
    }
    return null
  }

  function visit(node, sourcePath) {
    if (!node || typeof node !== 'object') return

    // Headings get a hierarchical counter regardless of whether they
    // carry an id — the {#id} just labels them; the counter itself is
    // assigned by tree position.
    let counter = null
    let counterText = null
    if (node.type === 'heading') {
      const level = Math.max(1, Math.min(6, node.attrs?.level || 1))
      counterText = nextHierarchical(level)
      counter = counterText
    }

    const id = node.attrs?.id
    if (id) {
      const kind = inferKind(node)
      if (!kind) {
        onWarn(`[xref] {#${id}} on unrecognized element type "${node.type}" — ignored`)
      } else if (entries[id]) {
        onWarn(`[xref] duplicate id "${id}" — keeping first registration`)
      } else {
        if (counter == null) {
          counter = nextFlat(kind)
          counterText = String(counter)
        }
        const entry = { id, kind, counter, counterText, sourcePath: sourcePath || '' }
        // Per-kind metadata. List sections (ListOfFigures, ListOfTables,
        // TableOfContents) read these directly so they don't have to
        // re-walk the parsed tree to find captions and headings.
        const captionAttr = node.attrs?.caption
        if (kind === 'figure' || kind === 'table') {
          if (captionAttr) entry.caption = String(captionAttr)
        }
        if (node.type === 'heading') {
          const text = collectTextContent(node)
          if (text) entry.text = text
        }
        if (node.type === 'math_display') {
          const latex = node.attrs?.latex
          if (latex) entry.latex = String(latex)
        }
        entries[id] = entry
      }
    } else if (node.type === 'heading') {
      // Heading without an id still advances the counter — but we don't
      // register it (no way to reference it). The advance is needed so
      // that the *next* labeled heading gets the right hierarchical
      // counter.
      // counter already computed above; just no entry.
    }

    if (Array.isArray(node.content)) {
      for (const child of node.content) visit(child, sourcePath)
    }
  }

  for (const page of siteContent.pages || []) {
    for (const section of page.sections || []) {
      const content = section.content
      if (content?.type === 'doc' && Array.isArray(content.content)) {
        for (const child of content.content) visit(child, page.route)
      }
    }
  }

  return { entries }
}
