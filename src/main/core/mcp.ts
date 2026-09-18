/**
 * MCP server management: read every `@deepseek-ai/dsh-mcp-client` row a dsh
 * would mount, and toggle one on/off in the layer it came from.
 *
 * dsh composes its patch layers in this order, a later layer overriding an
 * earlier one BY ROW ID (`dsh-app-boot`'s `composeEntries`):
 *
 *   bundle layers → profile `cordis.patch.yml` → home `cordis.patch.yml` → --patch
 *
 * so the home layer outranks each profile's own layer. This module reads the
 * two layers the Launcher owns (profile + home); bundle layers are shipped by
 * packages and are not the user's to edit.
 *
 * There is no standalone `mcp.yml`/`.mcp.json` in dsh — an MCP server IS a
 * `dsh-mcp-client` patch row, so the row is the unit of management.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { load as loadYaml, FAILSAFE_SCHEMA } from 'js-yaml'
import { activeDshEntry, activeProfile } from './appState.ts'
import { homePatchPath, listProfiles, profileDir } from './home.ts'
import { effectiveRow, extractKeyValue, parseNamedRows, setRowDisabled } from './patch.ts'
import { isValidPatchDocument, verifyDisabledState, writePatchFileAtomic } from './app-util.ts'
import { child } from './logger.ts'
import type { McpLayer, McpScanResult, McpServerRow, McpToggleTarget } from '../../shared/types.ts'

/** Domain-tagged logger for MCP scanning. */
const mlog = child('mcp')

/** The plugin package an MCP server row mounts. */
export const MCP_CLIENT_PLUGIN = '@deepseek-ai/dsh-mcp-client'

/** One layer's patch file. */
interface LayerFile {
  layer: McpLayer
  profile?: string
  path: string
  exists: boolean
}

/** The patch files this module reads, in composition order (home last = highest). */
function layerFiles(): LayerFile[] {
  const files: LayerFile[] = []
  for (const profile of listProfiles()) {
    const path = join(profileDir(profile), 'cordis.patch.yml')
    files.push({ layer: 'profile', profile, path, exists: existsSync(path) })
  }
  const homePath = homePatchPath()
  files.push({ layer: 'home', path: homePath, exists: existsSync(homePath) })
  return files
}

/** Parse a `config:` block into an object, tolerating unreadable YAML.
 *
 * FAILSAFE_SCHEMA keeps a cordis `!!js` expression from failing the whole parse
 * (a config value may legitimately carry one); only plain scalars/lists are read
 * here, so the looser schema loses nothing. */
function parseConfig(text: string, id: string): Record<string, unknown> {
  const raw = extractKeyValue(text, id, 'config')
  if (raw === undefined || raw.trim() === '') return {}
  try {
    const parsed = loadYaml(raw, { schema: FAILSAFE_SCHEMA })
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch (error) {
    // js-yaml's message embeds an excerpt of the offending SOURCE, which for an
    // MCP config block is `env:` / `headers:` — i.e. tokens. The file sink captures
    // debug by default, so logging the message would write secrets to disk. Report
    // the position only.
    const mark = error instanceof Error ? (error as Error & { mark?: { line?: number; column?: number } }).mark : undefined
    const where = mark?.line !== undefined ? ` at line ${mark.line}` : ''
    mlog.warn(`mcp row ${id}: unreadable config (parse failed${where})`)
    return {}
  }
}

/** Narrow a parsed config value to a display string. */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Narrow a parsed config value to a string list. */
function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/**
 * Scan every MCP server row across the profile + home layers.
 *
 * Rows come back in composition order (profile layers first, home last). A
 * PROFILE row whose `serverName` is also mounted by the home layer is marked
 * `shadowedBy`: dsh composes home after the profile, so home wins and that row
 * never takes effect. Two different profiles are mutually exclusive — only one
 * is loaded at a time — so a name they share is NOT a conflict.
 *
 * A bundle layer could in principle mount one too, but those are shipped by
 * packages and not managed here.
 */
export function scanMcpServers(): McpScanResult {
  const files = layerFiles()
  const rows: McpServerRow[] = []
  for (const file of files) {
    if (!file.exists) continue
    let text: string
    try {
      text = readFileSync(file.path, 'utf8')
    } catch (error) {
      mlog.warn(`mcp scan: cannot read ${file.path} (${error instanceof Error ? error.message : String(error)})`)
      continue
    }
    const named = parseNamedRows(text)
    // One id can appear in several blocks: some writers disable a server by
    // APPENDING a fresh `- id:` row rather than editing the original. dsh resolves
    // the LAST block (inheriting a field it omits), so emit ONE row per id
    // carrying that effective state — listing every block would show the same
    // server twice, once with a stale state.
    const seen = new Set<string>()
    for (const row of named) {
      if (row.name !== MCP_CLIENT_PLUGIN) continue
      if (seen.has(row.id)) continue
      seen.add(row.id)
      const config = parseConfig(text, row.id)
      const effective = effectiveRow(text, row.id)
      const blocks = named.filter(candidate => candidate.id === row.id).length
      rows.push({
        id: row.id,
        serverName: asString(config.serverName) ?? row.id,
        plugin: row.name,
        transport: asString(config.transport),
        command: asString(config.command),
        args: asStringList(config.args),
        url: asString(config.url),
        layer: file.layer,
        ...(file.profile !== undefined ? { profile: file.profile } : {}),
        file: file.path,
        // The EFFECTIVE state, not this block's own: a later block decides.
        disabled: effective?.disabled ?? row.disabled,
        // Another block for this id exists later in the file, so something else
        // (a plugin) also manages it and a toggle here rewrites that block.
        ...(blocks > 1 ? { overriddenByLater: true } : {}),
      })
    }
  }

  // Shadowing is computed PER PROFILE, never across profiles. A profile and the
  // home layer compose one running configuration (home outranks profile), so a
  // duplicate between them is a real override. Two DIFFERENT profiles are
  // mutually exclusive — only one is ever loaded — so a name they happen to
  // share is not a conflict, and treating it as one marked every row of the
  // earlier profile "未生效".
  const marked = rows.map(row => {
    const home = rows.find(r => r.layer === 'home' && r.serverName === row.serverName)
    // A home row is the winner in every composition; a profile row loses only
    // to a home row of the same name.
    const best = row.layer === 'profile' ? home : undefined
    if (best === undefined) return row
    return {
      ...row,
      shadowedBy: { layer: best.layer, id: best.id },
    }
  })

  const entry = activeDshEntry()
  const selected = activeProfile()
  const profiles = files.filter(f => f.layer === 'profile' && f.exists).map(f => f.profile ?? '')
  return {
    rows: marked,
    files: files.map(f => ({
      layer: f.layer,
      ...(f.profile !== undefined ? { profile: f.profile } : {}),
      path: f.path,
      exists: f.exists,
    })),
    homeMissing: !existsSync(homePatchPath()),
    homePath: homePatchPath(),
    profiles,
    dsh: entry === undefined ? null : { id: entry.id, name: entry.name },
    // Only report a current profile that still exists, so the UI never labels a
    // deleted profile as current.
    ...(selected !== undefined && profiles.includes(selected) ? { activeProfile: selected } : {}),
    homePathProvisional: entry === undefined,
  }
}

/**
 * Create the home layer's `cordis.patch.yml` if absent, so the home layer can
 * hold MCP rows. Returns the path; an existing file is left untouched.
 *
 * Refuses to create the file when there is NO active dsh: the home path would
 * then be a guess (`$DSH_HOME` / `~/.dsh`), so the file would land somewhere
 * unrelated to any registered install — and picking a dsh afterwards moves the
 * real home, making the created file look like it vanished on restart. That
 * report ("created it, then it was missing again") was exactly this case.
 */
export function ensureHomePatch(): string {
  if (activeDshEntry() === undefined) {
    throw new Error('no active dsh: the home layer path cannot be resolved')
  }
  const path = homePatchPath()
  if (!existsSync(path)) {
    writeFileSync(path, '[]\n')
    mlog.info(`created home patch: ${path}`)
  }
  return path
}

/** Resolve the patch file a toggle target names. Profile targets are confined
 * to the active dsh's profile list, so a stray profile name cannot point the
 * write at an arbitrary path. */
function targetFile(target: McpToggleTarget): { path: string; exists: boolean } {
  if (target.layer === 'home') {
    const path = homePatchPath()
    return { path, exists: existsSync(path) }
  }
  const name = target.profile ?? ''
  if (name === '' || !listProfiles().includes(name)) {
    throw new Error(`unknown profile "${name}"`)
  }
  const path = join(profileDir(name), 'cordis.patch.yml')
  return { path, exists: existsSync(path) }
}

/**
 * Enable/disable one MCP row in the layer it lives in, then read the file back
 * and assert the row actually holds the requested state — a silent write
 * failure must never be reported as success.
 *
 * The row MUST already exist: `setRowDisabled` appends a fresh block for an
 * unknown id, which would silently inject a junk `- id: …` row into the user's
 * config, and the read-back would then confirm it. So existence is checked
 * first and a missing row is an error.
 */
export function setMcpServerDisabled(target: McpToggleTarget, disabled: boolean): void {
  const { path, exists } = targetFile(target)
  if (!exists) throw new Error(`patch file not found: ${path}`)
  const current = readFileSync(path, 'utf8')
  // The EFFECTIVE row must be this MCP row: a later block for the same id can
  // belong to another plugin, and setRowDisabled edits the last block — so the
  // toggle would land in that other plugin's row.
  const effective = effectiveRow(current, target.id)
  if (effective === undefined || effective.name !== MCP_CLIENT_PLUGIN) {
    throw new Error(`mcp row not found: ${target.id}`)
  }
  const next = setRowDisabled(current, target.id, disabled)
  // Never leave a document dsh cannot boot from (it requires a top-level array);
  // a raw write of an unparsable edit fails loud at dsh's startup.
  if (!isValidPatchDocument(next)) throw new Error(`write would corrupt the patch document: ${path}`)
  writePatchFileAtomic(path, next)
  const after = readFileSync(path, 'utf8')
  if (!verifyDisabledState(after, target.id, disabled)) {
    throw new Error(`write verify failed for row "${target.id}"`)
  }
  mlog.info(`mcp ${target.id}: disabled=${String(disabled)} (${target.layer}${target.profile !== undefined ? `/${target.profile}` : ''})`)
}
