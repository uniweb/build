import { syncManifests, formatSyncReport } from '../../src/i18n/sync.js'

describe('syncManifests', () => {
  it('detects unchanged content', () => {
    const previous = {
      units: {
        'abc12345': {
          source: 'Hello',
          field: 'title',
          contexts: [{ page: '/', section: 'hero' }]
        }
      }
    }
    const current = {
      units: {
        'abc12345': {
          source: 'Hello',
          field: 'title',
          contexts: [{ page: '/', section: 'hero' }]
        }
      }
    }

    const report = syncManifests(previous, current)

    expect(report.unchanged).toHaveLength(1)
    expect(report.unchanged[0].hash).toBe('abc12345')
    expect(report.moved).toHaveLength(0)
    expect(report.changed).toHaveLength(0)
    expect(report.added).toHaveLength(0)
    expect(report.removed).toHaveLength(0)
  })

  it('detects new content', () => {
    const previous = {
      units: {}
    }
    const current = {
      units: {
        'abc12345': {
          source: 'Hello',
          field: 'title',
          contexts: [{ page: '/', section: 'hero' }]
        }
      }
    }

    const report = syncManifests(previous, current)

    expect(report.added).toHaveLength(1)
    expect(report.added[0].hash).toBe('abc12345')
    expect(report.added[0].source).toBe('Hello')
  })

  it('detects removed content', () => {
    const previous = {
      units: {
        'abc12345': {
          source: 'Hello',
          field: 'title',
          contexts: [{ page: '/', section: 'hero' }]
        }
      }
    }
    const current = {
      units: {}
    }

    const report = syncManifests(previous, current)

    expect(report.removed).toHaveLength(1)
    expect(report.removed[0].hash).toBe('abc12345')
    expect(report.removed[0].source).toBe('Hello')
  })

  it('detects moved content (same hash, different context)', () => {
    const previous = {
      units: {
        'abc12345': {
          source: 'Hello',
          field: 'title',
          contexts: [{ page: '/', section: 'hero' }]
        }
      }
    }
    const current = {
      units: {
        'abc12345': {
          source: 'Hello',
          field: 'title',
          contexts: [{ page: '/about', section: 'intro' }]
        }
      }
    }

    const report = syncManifests(previous, current)

    expect(report.moved).toHaveLength(1)
    expect(report.moved[0].hash).toBe('abc12345')
    expect(report.moved[0].previousContexts).toEqual([{ page: '/', section: 'hero' }])
    expect(report.moved[0].currentContexts).toEqual([{ page: '/about', section: 'intro' }])
    expect(report.unchanged).toHaveLength(0)
  })

  it('detects changed content (same context, different hash)', () => {
    const previous = {
      units: {
        'old12345': {
          source: 'Hello',
          field: 'title',
          contexts: [{ page: '/', section: 'hero' }]
        }
      }
    }
    const current = {
      units: {
        'new67890': {
          source: 'Welcome',
          field: 'title',
          contexts: [{ page: '/', section: 'hero' }]
        }
      }
    }

    const report = syncManifests(previous, current)

    expect(report.changed).toHaveLength(1)
    expect(report.changed[0].hash).toBe('new67890')
    expect(report.changed[0].previousHash).toBe('old12345')
    expect(report.changed[0].source).toBe('Welcome')
    expect(report.changed[0].previousSource).toBe('Hello')
    expect(report.removed).toHaveLength(0) // Should not be marked as removed
  })

  it('handles null previous manifest', () => {
    const current = {
      units: {
        'abc12345': {
          source: 'Hello',
          field: 'title',
          contexts: [{ page: '/', section: 'hero' }]
        }
      }
    }

    const report = syncManifests(null, current)

    expect(report.added).toHaveLength(1)
    expect(report.unchanged).toHaveLength(0)
  })

  it('handles content appearing in multiple contexts', () => {
    const previous = {
      units: {
        'abc12345': {
          source: 'Learn more',
          field: 'link.label',
          contexts: [{ page: '/', section: 'hero' }]
        }
      }
    }
    const current = {
      units: {
        'abc12345': {
          source: 'Learn more',
          field: 'link.label',
          contexts: [
            { page: '/', section: 'hero' },
            { page: '/', section: 'cta' }
          ]
        }
      }
    }

    const report = syncManifests(previous, current)

    // Content spread to new location
    expect(report.moved).toHaveLength(1)
    expect(report.moved[0].currentContexts).toHaveLength(2)
  })

  it('handles complex scenario with multiple changes', () => {
    const previous = {
      units: {
        'unchanged1': {
          source: 'Stable text',
          field: 'title',
          contexts: [{ page: '/', section: 'hero' }]
        },
        'willchange': {
          source: 'Old content',
          field: 'paragraph',
          contexts: [{ page: '/', section: 'intro' }]
        },
        'willremove': {
          source: 'Removed content',
          field: 'subtitle',
          contexts: [{ page: '/old', section: 'section' }]
        }
      }
    }
    const current = {
      units: {
        'unchanged1': {
          source: 'Stable text',
          field: 'title',
          contexts: [{ page: '/', section: 'hero' }]
        },
        'newcontent': {
          source: 'New content',
          field: 'paragraph',
          contexts: [{ page: '/', section: 'intro' }]
        },
        'brandnew': {
          source: 'Brand new',
          field: 'title',
          contexts: [{ page: '/new', section: 'hero' }]
        }
      }
    }

    const report = syncManifests(previous, current)

    expect(report.unchanged).toHaveLength(1)
    expect(report.changed).toHaveLength(1) // willchange -> newcontent
    expect(report.removed).toHaveLength(1) // willremove
    expect(report.added).toHaveLength(1) // brandnew
  })

  // ⛔ Until 2026-10-24 a new unit was paired with the first previous unit in its section,
  // still there or not: removing a hero's second button said its unchanged title had become
  // the remaining button, and called the button paragraph it replaced removed.
  it('pairs a new unit with the one it replaced, not with a neighbour still there', () => {
    const hero = [{ page: '/', section: 'hero' }]
    const previous = {
      units: {
        title: { source: 'For Content Authors', field: 'pretitle', contexts: hero },
        buttons: { source: 'Start from a Template Desktop App', field: 'paragraph', contexts: hero },
      },
    }
    const current = {
      units: {
        title: { source: 'For Content Authors', field: 'pretitle', contexts: hero },
        button: { source: 'Start from a Template', field: 'paragraph', contexts: hero },
      },
    }

    const report = syncManifests(previous, current)

    expect(report.unchanged.map((u) => u.hash)).toEqual(['title'])
    expect(report.changed).toEqual([
      expect.objectContaining({ hash: 'button', previousHash: 'buttons', previousSource: 'Start from a Template Desktop App' }),
    ])
    expect(report.removed).toEqual([])
  })

  it('says one replaced unit became one new unit, and the next is added', () => {
    const intro = [{ page: '/', section: 'intro' }]
    const previous = { units: { old: { source: 'Old', field: 'paragraph', contexts: intro } } }
    const current = {
      units: {
        first: { source: 'First', field: 'paragraph', contexts: intro },
        second: { source: 'Second', field: 'paragraph', contexts: intro },
      },
    }

    const report = syncManifests(previous, current)

    expect(report.changed.map((c) => [c.hash, c.previousHash])).toEqual([['first', 'old']])
    expect(report.added.map((a) => a.hash)).toEqual(['second'])
    expect(report.removed).toEqual([])
  })
})

describe('formatSyncReport', () => {
  it('formats empty report', () => {
    const report = {
      unchanged: [],
      moved: [],
      changed: [],
      added: [],
      removed: []
    }

    const formatted = formatSyncReport(report)
    expect(formatted).toContain('i18n sync results:')
  })

  it('formats report with all types of changes', () => {
    const report = {
      unchanged: [{ hash: 'a', source: 'text' }],
      moved: [{ hash: 'b', source: 'moved text' }],
      changed: [{ hash: 'c', previousHash: 'd', source: 'new text', previousSource: 'old text' }],
      added: [{ hash: 'e', source: 'new' }],
      removed: [{ hash: 'f', source: 'removed' }]
    }

    const formatted = formatSyncReport(report)

    expect(formatted).toContain('1 strings unchanged')
    expect(formatted).toContain('1 strings moved')
    expect(formatted).toContain('1 strings changed')
    expect(formatted).toContain('1 new strings')
    expect(formatted).toContain('1 strings removed')
  })

  it('truncates long strings in report', () => {
    const longText = 'a'.repeat(50)
    const report = {
      unchanged: [],
      moved: [],
      changed: [{ hash: 'a', previousHash: 'b', source: longText, previousSource: longText }],
      added: [],
      removed: []
    }

    const formatted = formatSyncReport(report)
    expect(formatted).toContain('...')
  })
})
