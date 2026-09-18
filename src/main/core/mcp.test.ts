/** Tests for MCP scanning + toggling: layer discovery, config parsing, the
 * home-outranks-profile composition order, and the read-back verified write.
 *
 * The modules under test read the settings singleton for the active dsh home,
 * so the baseline is re-saved before EVERY case. Modules are imported once (no
 * `resetModules`): resetting would drop the settings singleton and let the scan
 * fall through to the real machine's home — which must never be touched. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, saveSettings } from './settings.ts'
import { setActiveProfile } from './appState.ts'
import { ensureHomePatch, scanMcpServers, setMcpServerDisabled } from './mcp.ts'
import type { DshEntry } from '../../shared/types.ts'

let root: string
let home: string
let profiles: string
let appData: string

const ENTRY: DshEntry = {
  id: 'dsh-a', name: 'dsh@a', execPath: join('C:', 'x', 'dsh.cmd'), version: '1.0.0',
  home: '', managed: true,
}

/** Write one profile's patch file. */
function writeProfilePatch(profile: string, text: string): void {
  const dir = join(profiles, profile)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `dsh-profile-${profile}`, private: true }))
  writeFileSync(join(dir, 'cordis.patch.yml'), text)
}

/** One MCP row block, indented under an `insert:` list. */
function mcpRow(id: string, serverName: string, extra = ''): string {
  return [
    `    - id: ${id}`,
    '      name: "@deepseek-ai/dsh-mcp-client"',
    '      config:',
    `        serverName: ${serverName}`,
    '        transport: stdio',
    '        command: node',
    extra,
  ].join('\n')
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pm-mcp-'))
  appData = join(root, 'userData')
  home = join(root, 'home')
  profiles = join(home, 'profiles')
  mkdirSync(appData, { recursive: true })
  mkdirSync(profiles, { recursive: true })
  await openDatabase(join(root, 'app.sqlite'))
})

afterAll(() => { rmSync(root, { recursive: true, force: true }) })

beforeEach(() => {
  rmSync(profiles, { recursive: true, force: true })
  mkdirSync(profiles, { recursive: true })
  rmSync(join(home, 'cordis.patch.yml'), { force: true })
  // Reset the active-profile map too: it is keyed by dsh id, so a leftover
  // selection would leak into the next case.
  saveSettings({ dshes: [{ ...ENTRY, home }], activeDshId: 'dsh-a', pluginDir: join(root, 'store'), activeProfiles: {} })
})

describe('scanMcpServers', () => {
  it('finds MCP rows in a profile layer and reads their config', () => {
    writeProfilePatch('web', [
      '- insert:',
      mcpRow('mcp-a', 'alpha'),
      mcpRow('mcp-b', 'beta', '        url: http://127.0.0.1:1234/mcp'),
      '',
    ].join('\n'))
    const result = scanMcpServers()
    expect(result.rows).toHaveLength(2)
    const a = result.rows.find(r => r.id === 'mcp-a')
    expect(a).toMatchObject({ serverName: 'alpha', layer: 'profile', profile: 'web', transport: 'stdio', command: 'node', disabled: false })
    expect(result.rows.find(r => r.id === 'mcp-b')?.url).toBe('http://127.0.0.1:1234/mcp')
  })

  it('ignores non-MCP rows', () => {
    writeProfilePatch('web', [
      '- id: other',
      '  name: "@linxin666/dsh-web-all/doctor"',
      '- id: mcp-a',
      '  name: "@deepseek-ai/dsh-mcp-client"',
      '  config:',
      '    serverName: alpha',
      '',
    ].join('\n'))
    expect(scanMcpServers().rows.map(r => r.id)).toEqual(['mcp-a'])
  })

  it('reports the home layer as missing when it does not exist', () => {
    writeProfilePatch('web', ['- id: mcp-a', '  name: "@deepseek-ai/dsh-mcp-client"', '  config:', '    serverName: alpha', ''].join('\n'))
    const result = scanMcpServers()
    expect(result.homeMissing).toBe(true)
    expect(result.files.find(f => f.layer === 'home')?.exists).toBe(false)
  })

  it('reads MCP rows from BOTH layers, home last (it outranks profile)', () => {
    writeProfilePatch('web', ['- id: mcp-a', '  name: "@deepseek-ai/dsh-mcp-client"', '  config:', '    serverName: profile-alpha', ''].join('\n'))
    writeFileSync(join(home, 'cordis.patch.yml'), ['- id: mcp-home', '  name: "@deepseek-ai/dsh-mcp-client"', '  config:', '    serverName: home-beta', ''].join('\n'))
    const rows = scanMcpServers().rows
    expect(rows.map(r => `${r.layer}:${r.id}`)).toEqual(['profile:mcp-a', 'home:mcp-home'])
  })

  it('surfaces a disabled row as disabled', () => {
    writeProfilePatch('web', ['- id: mcp-a', '  name: "@deepseek-ai/dsh-mcp-client"', '  disabled: true', '  config:', '    serverName: alpha', ''].join('\n'))
    expect(scanMcpServers().rows[0].disabled).toBe(true)
  })

  it('falls back to the row id when the config carries no serverName', () => {
    writeProfilePatch('web', ['- id: mcp-noname', '  name: "@deepseek-ai/dsh-mcp-client"', ''].join('\n'))
    expect(scanMcpServers().rows[0].serverName).toBe('mcp-noname')
  })

  it('marks a profile row shadowed when the home layer mounts the same server', () => {
    // dsh composes profile → home, later wins, so the home row is effective and
    // the profile row never takes effect.
    writeProfilePatch('web', ['- id: mcp-a', '  name: "@deepseek-ai/dsh-mcp-client"', '  config:', '    serverName: shared', ''].join('\n'))
    writeFileSync(join(home, 'cordis.patch.yml'), ['- id: mcp-home', '  name: "@deepseek-ai/dsh-mcp-client"', '  config:', '    serverName: shared', ''].join('\n'))
    const rows = scanMcpServers().rows
    const profileRow = rows.find(r => r.layer === 'profile')!
    const homeRow = rows.find(r => r.layer === 'home')!
    expect(profileRow.shadowedBy).toEqual({ layer: 'home', id: 'mcp-home' })
    expect(homeRow.shadowedBy).toBeUndefined()
  })

  it('does not shadow a row whose serverName is unique', () => {
    writeProfilePatch('web', ['- id: mcp-a', '  name: "@deepseek-ai/dsh-mcp-client"', '  config:', '    serverName: alpha', ''].join('\n'))
    writeFileSync(join(home, 'cordis.patch.yml'), ['- id: mcp-home', '  name: "@deepseek-ai/dsh-mcp-client"', '  config:', '    serverName: beta', ''].join('\n'))
    expect(scanMcpServers().rows.every(r => r.shadowedBy === undefined)).toBe(true)
  })

  it('does NOT shadow between two profiles that share a serverName', () => {
    // Two profiles are mutually exclusive — only one is loaded at a time — so a
    // name they both define is not a conflict. Treating it as one marked every
    // row of the earlier profile "未生效" while the active profile showed fine.
    const patch = ['- id: mcp-a', '  name: "@deepseek-ai/dsh-mcp-client"', '  config:', '    serverName: same', ''].join('\n')
    writeProfilePatch('web', patch)
    writeProfilePatch('web2', patch)
    const rows = scanMcpServers().rows
    expect(rows).toHaveLength(2)
    expect(rows.every(r => r.shadowedBy === undefined)).toBe(true)
  })

  it('shadows each profile against home independently', () => {
    // `web` collides with home; `web2` does not. Only web's row is inactive.
    writeProfilePatch('web', ['- id: mcp-a', '  name: "@deepseek-ai/dsh-mcp-client"', '  config:', '    serverName: shared', ''].join('\n'))
    writeProfilePatch('web2', ['- id: mcp-b', '  name: "@deepseek-ai/dsh-mcp-client"', '  config:', '    serverName: own', ''].join('\n'))
    writeFileSync(join(home, 'cordis.patch.yml'), ['- id: mcp-home', '  name: "@deepseek-ai/dsh-mcp-client"', '  config:', '    serverName: shared', ''].join('\n'))
    const rows = scanMcpServers().rows
    expect(rows.find(r => r.profile === 'web')?.shadowedBy).toEqual({ layer: 'home', id: 'mcp-home' })
    expect(rows.find(r => r.profile === 'web2')?.shadowedBy).toBeUndefined()
  })

  it('exposes the home patch path, the profiles with a file, and the active dsh', () => {
    writeProfilePatch('web', ['- id: mcp-a', '  name: "@deepseek-ai/dsh-mcp-client"', ''].join('\n'))
    const result = scanMcpServers()
    expect(result.homePath).toBe(join(home, 'cordis.patch.yml'))
    expect(result.profiles).toEqual(['web'])
    expect(result.dsh).toEqual({ id: 'dsh-a', name: 'dsh@a' })
    // A registered dsh means the home path is real, not a fallback guess.
    expect(result.homePathProvisional).toBe(false)
  })

  it('flags the home path as provisional when no dsh is active', () => {
    // Without an active dsh the home path falls back to $DSH_HOME / ~/.dsh, so
    // creating a file there is unstable — the UI must not offer it.
    saveSettings({ dshes: [], activeDshId: undefined })
    const result = scanMcpServers()
    expect(result.dsh).toBeNull()
    expect(result.homePathProvisional).toBe(true)
  })

  it('reports the current profile only when it still exists', () => {
    writeProfilePatch('web', ['- id: mcp-a', '  name: "@deepseek-ai/dsh-mcp-client"', ''].join('\n'))
    setActiveProfile('web')
    expect(scanMcpServers().activeProfile).toBe('web')
    // A selection whose profile is gone is not reported.
    setActiveProfile('ghost')
    expect(scanMcpServers().activeProfile).toBeUndefined()
  })

  it('lists a profile in `profiles` only when its patch file exists', () => {
    mkdirSync(join(profiles, 'empty'), { recursive: true })
    writeFileSync(join(profiles, 'empty', 'package.json'), JSON.stringify({ name: 'x', private: true }))
    writeProfilePatch('web', ['- id: mcp-a', '  name: "@deepseek-ai/dsh-mcp-client"', ''].join('\n'))
    expect(scanMcpServers().profiles).toEqual(['web'])
  })
})

describe('ensureHomePatch', () => {
  it('creates the home patch file with a valid empty document', () => {
    const path = join(home, 'cordis.patch.yml')
    expect(existsSync(path)).toBe(false)
    expect(ensureHomePatch()).toBe(path)
    expect(readFileSync(path, 'utf8')).toBe('[]\n')
    expect(scanMcpServers().homeMissing).toBe(false)
  })

  it('is idempotent — an existing file is left untouched', () => {
    const path = join(home, 'cordis.patch.yml')
    writeFileSync(path, ['- id: existing', '  name: "@deepseek-ai/dsh-mcp-client"', '  config:', '    serverName: kept', ''].join('\n'))
    const before = readFileSync(path, 'utf8')
    ensureHomePatch()
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('refuses to create the file when no dsh is active', () => {
    // The home path would be a fallback guess, so the created file would sit
    // nowhere near a real install and appear to vanish once a dsh is picked.
    saveSettings({ dshes: [], activeDshId: undefined })
    expect(() => ensureHomePatch()).toThrow(/no active dsh/)
  })
})

describe('setMcpServerDisabled', () => {
  it('writes disabled into the profile layer and keeps other rows intact', () => {
    const path = join(profiles, 'web', 'cordis.patch.yml')
    writeProfilePatch('web', ['- id: mcp-a', '  name: "@deepseek-ai/dsh-mcp-client"', '  config:', '    serverName: alpha', ''].join('\n'))
    setMcpServerDisabled({ layer: 'profile', profile: 'web', id: 'mcp-a' }, true)
    const after = readFileSync(path, 'utf8')
    expect(after).toContain('disabled: true')
    expect(after).toContain('serverName: alpha')
    // and back off again
    setMcpServerDisabled({ layer: 'profile', profile: 'web', id: 'mcp-a' }, false)
    expect(readFileSync(path, 'utf8')).not.toContain('disabled: true')
  })

  it('writes into the home layer for a home target', () => {
    const homePath = join(home, 'cordis.patch.yml')
    writeFileSync(homePath, ['- id: mcp-home', '  name: "@deepseek-ai/dsh-mcp-client"', '  config:', '    serverName: beta', ''].join('\n'))
    setMcpServerDisabled({ layer: 'home', id: 'mcp-home' }, true)
    expect(readFileSync(homePath, 'utf8')).toContain('disabled: true')
  })

  it('refuses a profile that is not registered', () => {
    writeProfilePatch('web', ['- id: mcp-a', '  name: "@deepseek-ai/dsh-mcp-client"', ''].join('\n'))
    expect(() => setMcpServerDisabled({ layer: 'profile', profile: 'nope', id: 'mcp-a' }, true)).toThrow(/unknown profile/)
  })

  it('refuses a missing patch file', () => {
    expect(() => setMcpServerDisabled({ layer: 'home', id: 'mcp-x' }, true)).toThrow(/patch file not found/)
  })

  it('refuses an unknown row WITHOUT appending a junk block', () => {
    // setRowDisabled appends a fresh `- id:` block for an unknown id, so an
    // unguarded toggle would inject a junk row and the read-back would confirm
    // it. The row must be verified to exist first.
    const path = join(profiles, 'web', 'cordis.patch.yml')
    writeProfilePatch('web', ['- id: mcp-a', '  name: "@deepseek-ai/dsh-mcp-client"', ''].join('\n'))
    const before = readFileSync(path, 'utf8')
    expect(() => setMcpServerDisabled({ layer: 'profile', profile: 'web', id: 'nope' }, true))
      .toThrow(/mcp row not found/)
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('refuses a row that exists but is NOT an mcp-client row', () => {
    const path = join(profiles, 'web', 'cordis.patch.yml')
    writeProfilePatch('web', ['- id: other', '  name: "@linxin666/dsh-web-all/doctor"', ''].join('\n'))
    const before = readFileSync(path, 'utf8')
    expect(() => setMcpServerDisabled({ layer: 'profile', profile: 'web', id: 'other' }, true))
      .toThrow(/mcp row not found/)
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('does not corrupt an insert-nested MCP row when toggling', () => {
    // MCP rows normally live under `insert:`; the toggle must keep them there
    // and must not disturb sibling rows.
    const path = join(profiles, 'web', 'cordis.patch.yml')
    writeProfilePatch('web', [
      '- insert:',
      mcpRow('mcp-a', 'alpha'),
      mcpRow('mcp-b', 'beta'),
      '',
    ].join('\n'))
    setMcpServerDisabled({ layer: 'profile', profile: 'web', id: 'mcp-a' }, true)
    const after = readFileSync(path, 'utf8')
    expect(after).toContain('serverName: alpha')
    expect(after).toContain('serverName: beta')
    // Both rows still parse as MCP rows, and only mcp-a flipped.
    const rows = scanMcpServers().rows
    expect(rows.map(r => `${r.id}:${r.disabled}`)).toEqual(['mcp-a:true', 'mcp-b:false'])
  })
})

describe('baseline', () => {
  it('points the active dsh at the temp home', () => {
    expect(scanMcpServers().files.find(f => f.layer === 'home')?.path).toBe(join(home, 'cordis.patch.yml'))
  })
})
