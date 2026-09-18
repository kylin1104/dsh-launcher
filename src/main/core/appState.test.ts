/**
 * Aggregated app state derived from settings: dsh selection, effective dirs,
 * plugin-store/version-repo defaults and onboarding preconditions.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSettings, openDatabase, saveSettings } from './settings.ts'
import {
  activeDshEntry, activeProfile, applyProfileOrder, configureAppState, dshScopes, dshVersionDir,
  effectiveProfileDir, pluginDir, profileOrder, readDshState, reorderDshes, setActiveProfile,
  setProfileOrder, writeDshState,
} from './appState.ts'
import type { DshEntry } from '../../shared/types.ts'

let root: string

const ENTRY_A: DshEntry = { id: 'a', name: 'dsh@a', execPath: '/a', version: 'a', home: '/home/a' }

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pm-appstate-'))
  await openDatabase(join(root, 'app.sqlite'))
  configureAppState(join(root, 'userData'))
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  saveSettings({
    ...loadSettings(),
    dshes: undefined, activeDshId: undefined, pluginDir: undefined, dshVersionDir: undefined,
  })
})

describe('dsh state', () => {
  it('starts with no dshes and no active id', () => {
    expect(readDshState()).toEqual({ dshes: [], activeDshId: undefined })
    expect(activeDshEntry()).toBeUndefined()
  })

  it('writeDshState persists entries + active id; activeDshEntry resolves it', () => {
    writeDshState([ENTRY_A, { ...ENTRY_A, id: 'b', name: 'dsh@b' }], 'a')
    expect(activeDshEntry()?.id).toBe('a')
    expect(readDshState().activeDshId).toBe('a')
  })

  it('activeDshEntry is undefined when the active id matches nothing', () => {
    writeDshState([ENTRY_A], 'missing')
    expect(activeDshEntry()).toBeUndefined()
  })

  it('dshScopes carries each entry into a scope', () => {
    writeDshState([
      { ...ENTRY_A },
      { ...ENTRY_A, id: 'b', name: 'dsh@b', home: '/home/b', profilesDir: '/pb' },
    ], undefined)
    expect(dshScopes()).toEqual([
      { id: 'a', name: 'dsh@a', version: 'a', home: '/home/a', profilesDir: undefined },
      { id: 'b', name: 'dsh@b', version: 'a', home: '/home/b', profilesDir: '/pb' },
    ])
  })
})

describe('active profile', () => {
  it('is unset with no dsh selected', () => {
    expect(activeProfile()).toBeUndefined()
    setActiveProfile('web')
    expect(activeProfile()).toBeUndefined()
  })

  it('round-trips a selection for the active dsh', () => {
    writeDshState([ENTRY_A], 'a')
    setActiveProfile('web')
    expect(activeProfile()).toBe('web')
    expect(loadSettings().activeProfiles).toEqual({ a: 'web' })
  })

  it('keeps a separate selection per dsh', () => {
    writeDshState([ENTRY_A, { ...ENTRY_A, id: 'b', name: 'dsh@b' }], 'a')
    setActiveProfile('web')
    writeDshState([ENTRY_A, { ...ENTRY_A, id: 'b', name: 'dsh@b' }], 'b')
    setActiveProfile('ptc')
    expect(activeProfile()).toBe('ptc')
    // switching back restores the first dsh's own choice
    writeDshState([ENTRY_A, { ...ENTRY_A, id: 'b', name: 'dsh@b' }], 'a')
    expect(activeProfile()).toBe('web')
  })

  it('clears a selection with undefined or blank', () => {
    writeDshState([ENTRY_A], 'a')
    setActiveProfile('web')
    setActiveProfile(undefined)
    expect(activeProfile()).toBeUndefined()
    setActiveProfile('web')
    setActiveProfile('   ')
    expect(activeProfile()).toBeUndefined()
  })
})

describe('reorderDshes', () => {
  const three = (): void => {
    writeDshState([
      { ...ENTRY_A, id: 'a' },
      { ...ENTRY_A, id: 'b', name: 'dsh@b' },
      { ...ENTRY_A, id: 'c', name: 'dsh@c' },
    ], 'b')
  }

  it('applies a full permutation and keeps the active id', () => {
    three()
    expect(reorderDshes(['c', 'a', 'b'])).toBe(true)
    expect(readDshState().dshes.map(d => d.id)).toEqual(['c', 'a', 'b'])
    expect(readDshState().activeDshId).toBe('b')
  })

  it('refuses a partial list (would drop entries)', () => {
    three()
    expect(reorderDshes(['a', 'b'])).toBe(false)
    expect(readDshState().dshes.map(d => d.id)).toEqual(['a', 'b', 'c'])
  })

  it('refuses an unknown id', () => {
    three()
    expect(reorderDshes(['a', 'b', 'zzz'])).toBe(false)
    expect(readDshState().dshes.map(d => d.id)).toEqual(['a', 'b', 'c'])
  })

  it('refuses a duplicate (would drop and duplicate at once)', () => {
    three()
    expect(reorderDshes(['a', 'a', 'b'])).toBe(false)
    expect(readDshState().dshes.map(d => d.id)).toEqual(['a', 'b', 'c'])
  })

  it('refuses an extra id on an otherwise complete list', () => {
    three()
    expect(reorderDshes(['a', 'b', 'c', 'd'])).toBe(false)
  })

  it('accepts the identity order', () => {
    three()
    expect(reorderDshes(['a', 'b', 'c'])).toBe(true)
  })
})

describe('profile order', () => {
  beforeEach(() => { writeDshState([ENTRY_A], 'a') })

  it('returns an empty order by default', () => {
    expect(profileOrder()).toEqual([])
  })

  it('round-trips a saved order for the active dsh', () => {
    setProfileOrder(['z', 'a', 'm'])
    expect(profileOrder()).toEqual(['z', 'a', 'm'])
  })

  it('sorts saved names first, then the rest alphabetically', () => {
    setProfileOrder(['z'])
    // `z` pinned first; everything else falls back to alphabetical order.
    expect(applyProfileOrder(['m', 'a', 'z', 'b'])).toEqual(['z', 'a', 'b', 'm'])
  })

  it('keeps a saved name that no longer exists harmlessly', () => {
    setProfileOrder(['gone', 'b'])
    expect(applyProfileOrder(['b', 'a'])).toEqual(['b', 'a'])
  })

  it('shows a newly created profile even though it is not in the saved order', () => {
    setProfileOrder(['b', 'a'])
    expect(applyProfileOrder(['b', 'a', 'new'])).toEqual(['b', 'a', 'new'])
  })

  it('keeps a separate order per dsh', () => {
    setProfileOrder(['z'])
    writeDshState([ENTRY_A, { ...ENTRY_A, id: 'b', name: 'dsh@b' }], 'b')
    setProfileOrder(['q'])
    expect(profileOrder()).toEqual(['q'])
    writeDshState([ENTRY_A, { ...ENTRY_A, id: 'b', name: 'dsh@b' }], 'a')
    expect(profileOrder()).toEqual(['z'])
  })
})

describe('effectiveProfileDir', () => {
  it('defaults to <home>/profiles without an override', () => {
    expect(effectiveProfileDir({ ...ENTRY_A })).toBe(join('/home/a', 'profiles'))
  })
  it('uses the configured override when present, ignoring blank', () => {
    expect(effectiveProfileDir({ ...ENTRY_A, profilesDir: '/custom' })).toBe('/custom')
    expect(effectiveProfileDir({ ...ENTRY_A, profilesDir: '   ' })).toBe(join('/home/a', 'profiles'))
  })
})

describe('directory defaults', () => {
  it('pluginDir falls back to <userData>/plugins', () => {
    expect(pluginDir()).toBe(join(root, 'userData', 'plugins'))
  })
  it('pluginDir honours the configured value', () => {
    saveSettings({ pluginDir: '/store' })
    expect(pluginDir()).toBe('/store')
  })
  it('dshVersionDir defaults to <userData>/dsh/versions', () => {
    expect(dshVersionDir()).toBe(join(root, 'userData', 'dsh', 'versions'))
  })
  it('dshVersionDir honours the configured value', () => {
    saveSettings({ dshVersionDir: '/versions' })
    expect(dshVersionDir()).toBe('/versions')
  })
})