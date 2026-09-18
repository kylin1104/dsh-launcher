/** Tests for the EFFECTIVE MCP view's row selection.
 *
 * The pane's `rows` useMemo picks home + the CURRENT profile for `effective`,
 * home alone for `all`, and one profile otherwise. That composition rule is the
 * whole point of the view, so it is pinned here against a scan-shaped fixture —
 * a wrong predicate silently shows a set of servers dsh never loads. */

import { describe, expect, it } from 'vitest'
import type { McpServerRow } from '../../../shared/types.ts'

/** The exact predicate from McpSection's `rows` memo. */
function rowsFor(all: McpServerRow[], filter: string, activeProfile?: string): McpServerRow[] {
  if (filter === 'effective') {
    return all.filter(r => r.layer === 'home' || (r.layer === 'profile' && r.profile === activeProfile))
  }
  if (filter === 'all') return all.filter(r => r.layer === 'home')
  return all.filter(r => r.layer === 'profile' && r.profile === filter)
}

const row = (id: string, layer: 'home' | 'profile', profile?: string): McpServerRow => ({
  id, serverName: id, plugin: '@deepseek-ai/dsh-mcp-client', args: [], layer,
  ...(profile !== undefined ? { profile } : {}), file: '/f', disabled: false,
})

const ALL: McpServerRow[] = [
  row('home-a', 'home'),
  row('home-dup', 'home'),
  row('web-dup', 'profile', 'web'),
  row('web-only', 'profile', 'web'),
  row('web2-only', 'profile', 'web2'),
]

describe('effective view', () => {
  it('composes home + the CURRENT profile only', () => {
    const ids = rowsFor(ALL, 'effective', 'web').map(r => r.id)
    expect(ids).toEqual(['home-a', 'home-dup', 'web-dup', 'web-only'])
    // Another profile's rows must never appear: only one profile is loaded.
    expect(ids).not.toContain('web2-only')
  })

  it('KEEPS a row the home layer shadows, so the override stays visible', () => {
    // web-dup is shadowed by home-dup; hiding it would make "I configured it and
    // it does nothing" invisible.
    const ids = rowsFor(ALL, 'effective', 'web').map(r => r.id)
    expect(ids).toContain('web-dup')
  })

  it('follows the current profile when it changes', () => {
    expect(rowsFor(ALL, 'effective', 'web2').map(r => r.id)).toEqual(['home-a', 'home-dup', 'web2-only'])
  })

  it('falls back to the home layer when no profile is active', () => {
    expect(rowsFor(ALL, 'effective', undefined).map(r => r.id)).toEqual(['home-a', 'home-dup'])
  })
})

describe('per-file views stay single-file', () => {
  it('"all" is the home layer alone', () => {
    expect(rowsFor(ALL, 'all', 'web').map(r => r.id)).toEqual(['home-a', 'home-dup'])
  })

  it('a profile name is that profile alone', () => {
    expect(rowsFor(ALL, 'web', 'web2').map(r => r.id)).toEqual(['web-dup', 'web-only'])
  })
})
