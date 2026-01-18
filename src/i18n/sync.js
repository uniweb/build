/**
 * Sync detection for i18n manifests
 *
 * Compares current extracted content with previous manifest
 * to detect moved, changed, new, and removed content.
 */

/**
 * Compare two manifests and generate a sync report
 * @param {Object} previous - Previous manifest (or null if first run)
 * @param {Object} current - Newly extracted manifest
 * @returns {Object} Sync report with changes
 */
export function syncManifests(previous, current) {
  const report = {
    unchanged: [],
    moved: [],
    changed: [],
    added: [],
    removed: []
  }

  const previousUnits = previous?.units || {}
  const currentUnits = current.units || {}

  const previousHashes = new Set(Object.keys(previousUnits))
  const currentHashes = new Set(Object.keys(currentUnits))

  // Check each current unit
  for (const hash of currentHashes) {
    const currentUnit = currentUnits[hash]

    if (previousHashes.has(hash)) {
      // Hash exists in both - check if contexts changed
      const prevUnit = previousUnits[hash]
      const contextsChanged = !contextsEqual(prevUnit.contexts, currentUnit.contexts)

      if (contextsChanged) {
        report.moved.push({
          hash,
          source: currentUnit.source,
          previousContexts: prevUnit.contexts,
          currentContexts: currentUnit.contexts
        })
      } else {
        report.unchanged.push({ hash, source: currentUnit.source })
      }
    } else {
      // New hash - could be new content or changed content
      // Check if any previous context now has this new hash
      const matchingContext = findMatchingContext(currentUnit.contexts, previousUnits)

      if (matchingContext) {
        // Same context, different hash = content changed
        report.changed.push({
          hash,
          previousHash: matchingContext.hash,
          source: currentUnit.source,
          previousSource: matchingContext.source,
          contexts: currentUnit.contexts
        })
      } else {
        // Completely new content
        report.added.push({
          hash,
          source: currentUnit.source,
          field: currentUnit.field,
          contexts: currentUnit.contexts
        })
      }
    }
  }

  // Check for removed content
  for (const hash of previousHashes) {
    if (!currentHashes.has(hash)) {
      const prevUnit = previousUnits[hash]
      // Only mark as removed if not detected as changed above
      const wasChanged = report.changed.some(c => c.previousHash === hash)
      if (!wasChanged) {
        report.removed.push({
          hash,
          source: prevUnit.source,
          contexts: prevUnit.contexts
        })
      }
    }
  }

  return report
}

/**
 * Check if two context arrays are equal
 */
function contextsEqual(contexts1, contexts2) {
  if (contexts1.length !== contexts2.length) return false

  const set1 = new Set(contexts1.map(c => `${c.page}:${c.section}`))
  const set2 = new Set(contexts2.map(c => `${c.page}:${c.section}`))

  if (set1.size !== set2.size) return false
  for (const key of set1) {
    if (!set2.has(key)) return false
  }
  return true
}

/**
 * Find if any context in the current unit matches a context in previous units
 * Returns the previous unit info if found
 */
function findMatchingContext(currentContexts, previousUnits) {
  for (const context of currentContexts) {
    const contextKey = `${context.page}:${context.section}`

    for (const [hash, unit] of Object.entries(previousUnits)) {
      const hasContext = unit.contexts.some(
        c => `${c.page}:${c.section}` === contextKey
      )
      if (hasContext) {
        return { hash, source: unit.source, contexts: unit.contexts }
      }
    }
  }
  return null
}

/**
 * Format sync report for console output
 * @param {Object} report - Sync report from syncManifests
 * @returns {string} Formatted report
 */
export function formatSyncReport(report) {
  const lines = ['i18n sync results:']

  if (report.unchanged.length > 0) {
    lines.push(`  ✓ ${report.unchanged.length} strings unchanged`)
  }

  if (report.moved.length > 0) {
    lines.push(`  ↻ ${report.moved.length} strings moved (contexts updated)`)
  }

  if (report.changed.length > 0) {
    lines.push(`  ⚠ ${report.changed.length} strings changed (need re-translation)`)
    for (const item of report.changed.slice(0, 5)) {
      const prevPreview = truncate(item.previousSource, 30)
      const currPreview = truncate(item.source, 30)
      lines.push(`    - ${item.previousHash}: "${prevPreview}" → "${currPreview}"`)
    }
    if (report.changed.length > 5) {
      lines.push(`    ... and ${report.changed.length - 5} more`)
    }
  }

  if (report.added.length > 0) {
    lines.push(`  + ${report.added.length} new strings`)
  }

  if (report.removed.length > 0) {
    lines.push(`  - ${report.removed.length} strings removed`)
  }

  return lines.join('\n')
}

/**
 * Truncate string for display
 */
function truncate(str, maxLength) {
  if (str.length <= maxLength) return str
  return str.slice(0, maxLength - 3) + '...'
}
