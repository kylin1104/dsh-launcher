/**
 * Creating MCP server rows, and converting a Claude-format `mcpServers` block
 * into dsh rows.
 *
 * dsh has no standalone MCP file: a server is a `dsh-mcp-client` patch row, so
 * "adding a server" means appending one block to a layer's `cordis.patch.yml`.
 * The layer choice matters — the shared (home) layer applies to every profile,
 * a profile layer applies to that one — which is why the caller passes it in.
 *
 * Claude's config is a flat `{ mcpServers: { name: { command, args, env } } }`
 * map (with `url`/`type` for remote servers). dsh's transport/model differ, so
 * this is a deliberate, lossy mapping: anything it cannot express is reported
 * rather than silently dropped.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { load as loadYaml } from 'js-yaml'
import { activeDshEntry } from './appState.ts'
import { homePatchPath, listProfiles, profileDir } from './home.ts'
import { appendRowBlock, removeRow } from './patch.ts'
import { child } from './logger.ts'
import { E, throwE } from './errors.ts'
import { MCP_CLIENT_PLUGIN, scanMcpServers } from './mcp.ts'
import type { McpAddInput, McpImportPreview, McpLayer } from '../../shared/types.ts'

/** Domain-tagged logger for MCP writes. */
const alog = child('mcp')

/** Resolve the patch file for a layer, confined to layers the Launcher owns. */
function patchFileFor(layer: McpLayer, profile: string | undefined): string {
  if (layer === 'home') {
    // A coded error, not a bare Error: the latter degrades to `errors.internal`,
    // which surfaced the raw English sentence inside an otherwise-Chinese toast.
    if (activeDshEntry() === undefined) throwE(E.mcpNoActiveDsh)
    return homePatchPath()
  }
  const name = profile ?? ''
  if (name === '' || !listProfiles().includes(name)) throwE(E.mcpLayerUnknown, { detail: name })
  return join(profileDir(name), 'cordis.patch.yml')
}

/** Turn a server name into a stable, patch-safe row id. */
export function slugToRowId(serverName: string): string {
  const slug = serverName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug === '' ? 'mcp-server' : `mcp-${slug}`
}

/**
 * Serialize one YAML scalar as a single-line double-quoted string.
 *
 * EVERY scalar in a generated row goes through this — values AND mapping keys.
 * Hand-building YAML from renderer-supplied text is an injection surface: an
 * unquoted `env` key such as `"x\n- id: evil\n  ..."` closed the current mapping
 * and opened a SECOND, fully valid `@deepseek-ai/dsh-mcp-client` row, whose
 * `command` dsh then executed on the next run. Quoting alone is not enough
 * either — a raw newline inside quotes is a folded multi-line scalar — so the
 * escapes below keep the output on one line and byte-exact.
 */
export function yamlScalar(v: string): string {
  const escaped = v
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
  return `"${escaped}"`
}

/** Render the `config:` block body (zero-indent; the caller nests it). */
function renderMcpConfigBody(input: McpAddInput): string[] {
  const lines: string[] = [
    `serverName: ${yamlScalar(input.serverName)}`,
    `transport: ${yamlScalar(input.transport)}`,
  ]
  if (input.transport === 'stdio') {
    lines.push(`command: ${yamlScalar(input.command ?? '')}`)
    const args = input.args ?? []
    // A flow list keeps short arg lists on one line, matching how dsh's own
    // shipped rows are written.
    lines.push(args.length === 0 ? 'args: []' : `args: [ ${args.map(yamlScalar).join(', ')} ]`)
    const env = input.env ?? {}
    const keys = Object.keys(env)
    if (keys.length === 0) lines.push('env: {}')
    else {
      lines.push('env:')
      // The KEY is quoted too: an unquoted key was the injection vector.
      for (const k of keys) lines.push(`  ${yamlScalar(k)}: ${yamlScalar(String(env[k]))}`)
    }
  } else {
    lines.push(`url: ${yamlScalar(input.url ?? '')}`)
  }
  return lines
}

/**
 * Build the full patch row block for a server.
 *
 * Written by hand rather than through `upsertRow`: that helper's
 * `RowCreateInput` carries no `name`, and an MCP row is useless without
 * `name: '@deepseek-ai/dsh-mcp-client'` — the scanner identifies servers by
 * exactly that field.
 */
export function buildMcpRowBlock(input: McpAddInput, id: string): string {
  const lines = [`- id: ${yamlScalar(id)}`, `  name: ${yamlScalar(MCP_CLIENT_PLUGIN)}`]
  if (input.disabled === true) lines.push('  disabled: true')
  lines.push('  config:')
  for (const line of renderMcpConfigBody(input)) lines.push(`    ${line}`)
  return lines.join('\n') + '\n'
}

/**
 * Create (or overwrite) one MCP server row in the target layer.
 *
 * The write is verified by a re-scan: a row that does not appear in the layer
 * afterwards is an error, never a silent success.
 */
export function addMcpServer(input: McpAddInput): string {
  const serverName = input.serverName.trim()
  if (serverName === '') throw new Error('serverName is required')
  const id = (input.id ?? '').trim() !== '' ? (input.id as string).trim() : slugToRowId(serverName)
  const path = patchFileFor(input.layer, input.profile)

  // An id collision with an existing DIFFERENT server would silently rewrite it.
  const existing = scanMcpServers().rows.find(
    r => r.id === id && r.layer === input.layer && (input.layer === 'home' || r.profile === input.profile),
  )
  if (existing !== undefined && existing.serverName !== serverName) {
    throw new Error(`row id "${id}" is already used by server "${existing.serverName}"`)
  }

  const current = existsSync(path) ? readFileSync(path, 'utf8') : '[]\n'
  // Replace wholesale when the row exists so a re-add cannot leave stale keys
  // (e.g. switching a server from stdio to http).
  const base = existing === undefined ? current : removeRow(current, id)
  writeFileSync(path, appendRowBlock(base, buildMcpRowBlock({ ...input, serverName }, id)))

  const after = scanMcpServers().rows.find(
    r => r.id === id && r.layer === input.layer && (input.layer === 'home' || r.profile === input.profile),
  )
  if (after === undefined || after.serverName !== serverName) {
    throw new Error(`write verify failed for mcp server "${serverName}"`)
  }
  alog.info(`mcp added: ${serverName} (${input.layer}${input.profile !== undefined ? `/${input.profile}` : ''})`)
  return id
}

/**
 * Convert a Claude-format MCP config into dsh rows.
 *
 * Accepts the common shapes: a bare `{ "mcpServers": { … } }` object, the same
 * key nested under `mcpServers`, or the raw map of servers. `type`/`url` map to
 * a streamable-http or sse transport; anything else is reported as skipped.
 */
export function parseClaudeMcp(text: string, layer: McpLayer, profile?: string): McpImportPreview {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    try {
      parsed = loadYaml(text)
    } catch (error) {
      return { servers: [], skipped: [], error: `not valid JSON or YAML: ${error instanceof Error ? error.message : String(error)}` }
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { servers: [], skipped: [], error: 'expected an object with an "mcpServers" map' }
  }
  const root = parsed as Record<string, unknown>
  const map = root.mcpServers !== undefined ? root.mcpServers : root
  if (map === null || typeof map !== 'object' || Array.isArray(map)) {
    return { servers: [], skipped: [], error: '"mcpServers" must be an object keyed by server name' }
  }

  const servers: McpAddInput[] = []
  const skipped: { name: string; reason: string }[] = []
  for (const [name, raw] of Object.entries(map as Record<string, unknown>)) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      skipped.push({ name, reason: 'entry is not an object' })
      continue
    }
    const entry = raw as Record<string, unknown>
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
    const url = str(entry.url)
    const declared = str(entry.type)
    const command = str(entry.command)

    // Resolve the transport: an explicit type wins, else infer from the fields.
    let transport: string
    if (declared === 'sse') transport = 'sse'
    else if (declared === 'http' || declared === 'streamable-http' || declared === 'streamableHttp') transport = 'streamable-http'
    else if (declared === 'stdio') transport = 'stdio'
    else if (url !== undefined && command === undefined) transport = 'streamable-http'
    else if (command !== undefined) transport = 'stdio'
    else {
      skipped.push({ name, reason: 'no command and no url' })
      continue
    }

    if (transport === 'stdio') {
      if (command === undefined) {
        skipped.push({ name, reason: 'stdio server has no command' })
        continue
      }
      const args = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === 'string') : []
      const env: Record<string, string> = {}
      if (entry.env !== null && typeof entry.env === 'object' && !Array.isArray(entry.env)) {
        for (const [k, v] of Object.entries(entry.env as Record<string, unknown>)) {
          if (typeof v === 'string') env[k] = v
          else if (typeof v === 'number' || typeof v === 'boolean') env[k] = String(v)
        }
      }
      servers.push({ layer, ...(profile !== undefined ? { profile } : {}), serverName: name, transport, command, args, env })
    } else {
      if (url === undefined) {
        skipped.push({ name, reason: `${transport} server has no url` })
        continue
      }
      servers.push({ layer, ...(profile !== undefined ? { profile } : {}), serverName: name, transport, url })
    }
  }
  return { servers, skipped }
}

/** Import a batch of converted servers, returning the ids that were written. */
export function importMcpServers(servers: McpAddInput[]): string[] {
  const ids: string[] = []
  for (const server of servers) ids.push(addMcpServer(server))
  return ids
}

/** The plugin package an MCP row mounts (re-exported for the UI to show). */
export { MCP_CLIENT_PLUGIN }
