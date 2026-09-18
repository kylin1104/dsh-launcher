/** Tests for creating MCP rows and converting Claude-format configs.
 *
 * The conversion is a deliberate, lossy mapping, so the interesting cases are
 * what it does with input it CANNOT express: those must be reported, never
 * silently dropped or mis-typed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { openDatabase, saveSettings } from './settings.ts'
import { addMcpServer, buildMcpRowBlock, parseClaudeMcp, slugToRowId } from './mcp-add.ts'
import { scanMcpServers } from './mcp.ts'
import type { DshEntry, McpAddInput } from '../../shared/types.ts'

let root: string
let home: string
let profiles: string

const ENTRY: DshEntry = {
  id: 'dsh-a', name: 'dsh@a', execPath: join('C:', 'x', 'dsh.cmd'), version: '1.0.0',
  home: '', managed: true,
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pm-mcpadd-'))
  home = join(root, 'home')
  profiles = join(home, 'profiles')
  mkdirSync(profiles, { recursive: true })
  await openDatabase(join(root, 'app.sqlite'))
})

afterAll(() => { rmSync(root, { recursive: true, force: true }) })

beforeEach(() => {
  rmSync(profiles, { recursive: true, force: true })
  mkdirSync(profiles, { recursive: true })
  rmSync(join(home, 'cordis.patch.yml'), { force: true })
  const dir = join(profiles, 'web')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', private: true }))
  saveSettings({ dshes: [{ ...ENTRY, home }], activeDshId: 'dsh-a', activeProfiles: {}, profileOrder: {} })
})

describe('slugToRowId', () => {
  it('derives a patch-safe id from the server name', () => {
    expect(slugToRowId('My Server')).toBe('mcp-my-server')
    expect(slugToRowId('@scope/thing')).toBe('mcp-scope-thing')
  })
  it('falls back when the name has no usable characters', () => {
    expect(slugToRowId('///')).toBe('mcp-server')
  })
})

describe('buildMcpRowBlock', () => {
  it('writes the plugin name the scanner keys on', () => {
    const block = buildMcpRowBlock({ layer: 'home', serverName: 'x', transport: 'stdio', command: 'node' }, 'mcp-x')
    expect(block).toContain('name: "@deepseek-ai/dsh-mcp-client"')
  })

  it('renders a stdio config with args and env', () => {
    const block = buildMcpRowBlock({
      layer: 'home', serverName: 's', transport: 'stdio', command: 'npx',
      args: ['-y', 'pkg'], env: { A: '1' },
    }, 'mcp-s')
    // Every scalar is double-quoted, keys included (see the quoting suite below).
    expect(block).toContain('command: "npx"')
    expect(block).toContain('args: [ "-y", "pkg" ]')
    expect(block).toContain('"A": "1"')
  })

  it('renders empty collections inline rather than as blank blocks', () => {
    const block = buildMcpRowBlock({ layer: 'home', serverName: 's', transport: 'stdio', command: 'x' }, 'mcp-s')
    expect(block).toContain('args: []')
    expect(block).toContain('env: {}')
  })

  it('renders a url config for a remote transport', () => {
    const block = buildMcpRowBlock({ layer: 'home', serverName: 's', transport: 'streamable-http', url: 'http://x/mcp' }, 'mcp-s')
    expect(block).toContain('transport: "streamable-http"')
    expect(block).toContain('url: "http://x/mcp"')
    expect(block).not.toContain('command')
  })

  it('marks a disabled row', () => {
    const block = buildMcpRowBlock({ layer: 'home', serverName: 's', transport: 'stdio', command: 'x', disabled: true }, 'mcp-s')
    expect(block).toContain('disabled: true')
  })
})

describe('addMcpServer', () => {
  it('creates the shared-layer file and a readable row', () => {
    const id = addMcpServer({ layer: 'home', serverName: 'alpha', transport: 'stdio', command: 'node', args: ['a'] })
    expect(id).toBe('mcp-alpha')
    const rows = scanMcpServers().rows
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'mcp-alpha', serverName: 'alpha', transport: 'stdio', command: 'node', layer: 'home' })
  })

  it('adds into a profile layer', () => {
    addMcpServer({ layer: 'profile', profile: 'web', serverName: 'beta', transport: 'stdio', command: 'node' })
    expect(scanMcpServers().rows[0]).toMatchObject({ serverName: 'beta', layer: 'profile', profile: 'web' })
  })

  it('replaces an existing row of the same name (no stale keys)', () => {
    addMcpServer({ layer: 'home', serverName: 'gamma', transport: 'stdio', command: 'node', args: ['old'] })
    addMcpServer({ layer: 'home', serverName: 'gamma', transport: 'streamable-http', url: 'http://x/mcp' })
    const rows = scanMcpServers().rows
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ transport: 'streamable-http', url: 'http://x/mcp' })
    // the old stdio fields must be gone
    expect(rows[0].command).toBeUndefined()
  })

  it('refuses an id already used by a DIFFERENT server', () => {
    addMcpServer({ layer: 'home', serverName: 'one', transport: 'stdio', command: 'node', id: 'shared' })
    expect(() => addMcpServer({ layer: 'home', serverName: 'two', transport: 'stdio', command: 'node', id: 'shared' }))
      .toThrow(/already used/)
  })

  it('refuses a profile that is not registered', () => {
    // A coded error, so the toast reads the translated message rather than a
    // raw English sentence inside an otherwise-Chinese UI.
    expect(() => addMcpServer({ layer: 'profile', profile: 'nope', serverName: 'x', transport: 'stdio', command: 'n' }))
      .toThrow(expect.objectContaining({ code: 'mcp.layerUnknown' }))
  })

  it('refuses with no active dsh (shared-layer path is a guess)', () => {
    saveSettings({ dshes: [], activeDshId: undefined })
    expect(() => addMcpServer({ layer: 'home', serverName: 'x', transport: 'stdio', command: 'n' }))
      .toThrow(expect.objectContaining({ code: 'mcp.noActiveDsh' }))
  })

  it('requires a server name', () => {
    expect(() => addMcpServer({ layer: 'home', serverName: '  ', transport: 'stdio', command: 'n' })).toThrow(/required/)
  })

  it('appends without disturbing existing rows', () => {
    const path = join(home, 'cordis.patch.yml')
    writeFileSync(path, ['- id: keep', '  name: "@linxin666/dsh-web-all/doctor"', ''].join('\n'))
    addMcpServer({ layer: 'home', serverName: 'added', transport: 'stdio', command: 'node' })
    const text = readFileSync(path, 'utf8')
    expect(text).toContain('id: keep')
    expect(text).toContain('serverName: "added"')
  })
})

describe('parseClaudeMcp', () => {
  it('converts a standard mcpServers stdio entry', () => {
    const r = parseClaudeMcp(JSON.stringify({
      mcpServers: { 'my-server': { command: 'npx', args: ['-y', 'pkg'], env: { K: 'v' } } },
    }), 'home')
    expect(r.error).toBeUndefined()
    expect(r.skipped).toEqual([])
    expect(r.servers[0]).toMatchObject({
      serverName: 'my-server', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { K: 'v' }, layer: 'home',
    })
  })

  it('maps a url-only entry to streamable-http', () => {
    const r = parseClaudeMcp(JSON.stringify({ mcpServers: { remote: { url: 'http://x/mcp' } } }), 'home')
    expect(r.servers[0]).toMatchObject({ serverName: 'remote', transport: 'streamable-http', url: 'http://x/mcp' })
  })

  it('honours an explicit type over inference', () => {
    const r = parseClaudeMcp(JSON.stringify({ mcpServers: { s: { type: 'sse', url: 'http://x/sse' } } }), 'home')
    expect(r.servers[0].transport).toBe('sse')
  })

  it('accepts the bare map without the mcpServers wrapper', () => {
    const r = parseClaudeMcp(JSON.stringify({ plain: { command: 'node' } }), 'home')
    expect(r.servers[0].serverName).toBe('plain')
  })

  it('accepts YAML', () => {
    const r = parseClaudeMcp('mcpServers:\n  y:\n    command: node\n', 'home')
    expect(r.servers[0]).toMatchObject({ serverName: 'y', command: 'node' })
  })

  it('passes the target layer/profile through to every row', () => {
    const r = parseClaudeMcp(JSON.stringify({ mcpServers: { a: { command: 'x' }, b: { command: 'y' } } }), 'profile', 'web')
    expect(r.servers).toHaveLength(2)
    expect(r.servers.every(s => s.layer === 'profile' && s.profile === 'web')).toBe(true)
  })

  it('skips an entry with neither command nor url, reporting why', () => {
    const r = parseClaudeMcp(JSON.stringify({ mcpServers: { broken: { foo: 1 } } }), 'home')
    expect(r.servers).toEqual([])
    expect(r.skipped).toEqual([{ name: 'broken', reason: 'no command and no url' }])
  })

  it('skips a non-object entry', () => {
    const r = parseClaudeMcp(JSON.stringify({ mcpServers: { weird: 'nope' } }), 'home')
    expect(r.skipped[0].reason).toBe('entry is not an object')
  })

  it('skips a declared stdio entry with no command', () => {
    const r = parseClaudeMcp(JSON.stringify({ mcpServers: { s: { type: 'stdio' } } }), 'home')
    expect(r.skipped[0].reason).toBe('stdio server has no command')
  })

  it('skips a remote entry with no url', () => {
    const r = parseClaudeMcp(JSON.stringify({ mcpServers: { s: { type: 'sse' } } }), 'home')
    expect(r.skipped[0].reason).toBe('sse server has no url')
  })

  it('reports unparsable input instead of throwing', () => {
    const r = parseClaudeMcp('{{{ not json or yaml', 'home')
    // YAML is permissive, so this may parse as a string — either way it must not throw.
    expect(Array.isArray(r.servers)).toBe(true)
  })

  it('reports a non-object document', () => {
    const r = parseClaudeMcp('[1,2,3]', 'home')
    expect(r.error).toBeDefined()
  })

  it('coerces numeric/boolean env values to strings', () => {
    const r = parseClaudeMcp(JSON.stringify({ mcpServers: { s: { command: 'x', env: { N: 1, B: true } } } }), 'home')
    expect(r.servers[0].env).toEqual({ N: '1', B: 'true' })
  })

  it('drops non-string args rather than emitting bad YAML', () => {
    const r = parseClaudeMcp(JSON.stringify({ mcpServers: { s: { command: 'x', args: ['ok', 5, null] } } }), 'home')
    expect(r.servers[0].args).toEqual(['ok'])
  })
})

/**
 * Quoting discipline. A generated row is YAML built from renderer-supplied text,
 * so every scalar — values AND mapping keys — must be serialized as one escaped
 * line. Hand-building was an injection surface: an unquoted `env` key could close
 * the mapping and open a SECOND valid MCP row, whose `command` dsh then executed.
 */
describe('buildMcpRowBlock quoting', () => {
  const base: Omit<McpAddInput, 'serverName'> = { layer: 'home', transport: 'stdio', command: 'node', args: [] }

  /** Parse a generated block as the patch array dsh would load. */
  const rows = (block: string): Record<string, any>[] => load(block) as Record<string, any>[]

  it('an env KEY cannot inject a second row', () => {
    const evilKey = '#\n- id: mcp-evil\n  name: "@deepseek-ai/dsh-mcp-client"\n  config:\n    serverName: evil\n    transport: stdio\n    command: "calc.exe"\n    args: [ ]\n    env: {}\n#'
    const text = buildMcpRowBlock({ ...base, serverName: 'harmless', env: { [evilKey]: 'v' } }, 'mcp-harmless')
    const parsed = rows(text)
    // The payload stays INSIDE the env key; it must not become a row of its own.
    expect(parsed).toHaveLength(1)
    expect(parsed[0].id).toBe('mcp-harmless')
    expect(parsed[0].config.env).toEqual({ [evilKey]: 'v' })
    // No second config block was created by the injected text.
    expect(parsed[0].config.serverName).toBe('harmless')
  })

  it('a colon in serverName does not corrupt the document', () => {
    const text = buildMcpRowBlock({ ...base, serverName: 'a: b', env: {} }, 'mcp-x')
    expect(() => load(text)).not.toThrow()
    expect(rows(text)[0].config.serverName).toBe('a: b')
  })

  it('a "#" in serverName is kept, not read as a comment', () => {
    const text = buildMcpRowBlock({ ...base, serverName: 'ok # comment', env: {} }, 'mcp-x')
    expect(rows(text)[0].config.serverName).toBe('ok # comment')
  })

  it('a newline in url stays one scalar instead of injecting a row key', () => {
    const text = buildMcpRowBlock(
      { layer: 'home', transport: 'streamable-http', serverName: 's', url: 'http://x\n  disabled: true\n#' },
      'mcp-y',
    )
    const row = rows(text)[0]
    expect(row.disabled).toBeUndefined()
    expect(row.config.url).toBe('http://x\n  disabled: true\n#')
  })

  it('round-trips awkward values through the serializer', () => {
    const text = buildMcpRowBlock(
      { ...base, serverName: 's', command: 'a "b" c\\d', args: ['x y', 'p:q', '#h'], env: { 'K-EY': 'v"1' } },
      'mcp-z',
    )
    const config = rows(text)[0].config
    expect(config.command).toBe('a "b" c\\d')
    expect(config.args).toEqual(['x y', 'p:q', '#h'])
    expect(config.env).toEqual({ 'K-EY': 'v"1' })
  })
})
