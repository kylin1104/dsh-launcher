/** IPC for MCP server management (`mcp:*`): scan the profile + home patch
 * layers, toggle one server row in the layer it came from, create the home
 * layer on demand, and reveal a patch file in the OS editor/explorer. */

import { shell } from 'electron'
import { existsSync } from 'node:fs'
import { handle } from './handle.ts'
import { ensureHomePatch, scanMcpServers, setMcpServerDisabled } from '../core/mcp.ts'
import { addMcpServer, importMcpServers, parseClaudeMcp } from '../core/mcp-add.ts'
import { fail, failFromError, E } from '../core/errors.ts'
import { rowIdInvalid } from './validate.ts'
import type { IpcResult, McpAddInput, McpImportPreview, McpScanResult, McpToggleTarget } from '../../shared/types.ts'

/** Narrow a renderer-supplied toggle target to the two layers we own. */
function invalidTarget(target: McpToggleTarget | undefined): boolean {
  if (target === null || target === undefined || typeof target !== 'object') return true
  if (target.layer !== 'home' && target.layer !== 'profile') return true
  if (rowIdInvalid(target.id)) return true
  if (target.layer === 'profile' && (typeof target.profile !== 'string' || target.profile === '')) return true
  return false
}

/** Validate an add/import input from the renderer. */
function invalidAdd(input: McpAddInput | undefined): boolean {
  if (input === null || input === undefined || typeof input !== 'object') return true
  if (input.layer !== 'home' && input.layer !== 'profile') return true
  if (input.layer === 'profile' && (typeof input.profile !== 'string' || input.profile === '')) return true
  if (typeof input.serverName !== 'string' || input.serverName.trim() === '') return true
  if (typeof input.transport !== 'string' || input.transport === '') return true
  if (input.id !== undefined && (typeof input.id !== 'string' || rowIdInvalid(input.id))) return true
  // Shapes, not just types: the serializer maps over `args` and reads `env` keys,
  // so a non-array / non-object here would surface as an internal error instead of
  // a clean rejection. `url` and `command` are optional strings when present.
  if (input.args !== undefined && (!Array.isArray(input.args) || input.args.some(a => typeof a !== 'string'))) return true
  if (input.env !== undefined) {
    if (typeof input.env !== 'object' || input.env === null || Array.isArray(input.env)) return true
    if (Object.values(input.env).some(v => typeof v !== 'string')) return true
  }
  if (input.command !== undefined && typeof input.command !== 'string') return true
  if (input.url !== undefined && typeof input.url !== 'string') return true
  if (input.disabled !== undefined && typeof input.disabled !== 'boolean') return true
  return false
}

export function registerMcpIpc(): void {
  /** Every MCP server row across the layers the Launcher manages. */
  handle('mcp:scan', (): IpcResult<McpScanResult> => {
    try {
      return { ok: true, value: scanMcpServers() }
    } catch (error) {
      return failFromError(error)
    }
  })

  /** Enable/disable one row in its own layer (verified by a read-back). */
  handle('mcp:setDisabled', (_event, target: McpToggleTarget, disabled: boolean): IpcResult<boolean> => {
    try {
      if (invalidTarget(target)) return fail(E.mcpLayerUnknown)
      if (typeof disabled !== 'boolean') return fail(E.nameInvalid)
      setMcpServerDisabled(target, disabled)
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })

  /** Create the home layer's patch file when it does not exist yet, so the home
   * layer can hold MCP rows. Idempotent — an existing file is left alone. */
  handle('mcp:ensureHomePatch', (): IpcResult<string> => {
    try {
      return { ok: true, value: ensureHomePatch() }
    } catch (error) {
      return failFromError(error)
    }
  })

  /** Reveal a patch file in the OS default editor. The path is NOT taken from
   * the renderer: it must be one of the files a fresh scan reports, so this can
   * never be turned into an arbitrary-path open. */
  handle('mcp:openPatchFile', async (_event, layer: 'home' | 'profile', profile?: string): Promise<IpcResult<boolean>> => {
    try {
      if (layer !== 'home' && layer !== 'profile') return fail(E.mcpLayerUnknown)
      if (layer === 'profile' && (typeof profile !== 'string' || profile === '')) return fail(E.nameInvalid)
      const scan = scanMcpServers()
      const hit = scan.files.find(f => f.layer === layer && (layer === 'home' || f.profile === profile))
      if (hit === undefined) return fail(E.mcpRowNotFound)
      if (!existsSync(hit.path)) return fail(E.mcpRowNotFound)
      const error = await shell.openPath(hit.path)
      return error === '' ? { ok: true, value: true } : fail(E.shellOpenPath, { detail: error })
    } catch (error) {
      return failFromError(error)
    }
  })

  /** Reveal the containing FOLDER of a patch file (for the "open folder" action). */
  handle('mcp:revealPatchFile', (_event, layer: 'home' | 'profile', profile?: string): IpcResult<boolean> => {
    try {
      if (layer !== 'home' && layer !== 'profile') return fail(E.mcpLayerUnknown)
      if (layer === 'profile' && (typeof profile !== 'string' || profile === '')) return fail(E.nameInvalid)
      const scan = scanMcpServers()
      const hit = scan.files.find(f => f.layer === layer && (layer === 'home' || f.profile === profile))
      if (hit === undefined || !existsSync(hit.path)) return fail(E.mcpRowNotFound)
      shell.showItemInFolder(hit.path)
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })

  /** Add one MCP server to a chosen layer (verified by a re-scan). */
  handle('mcp:add', (_event, input: McpAddInput): IpcResult<string> => {
    try {
      if (invalidAdd(input)) return fail(E.mcpLayerUnknown)
      return { ok: true, value: addMcpServer(input) }
    } catch (error) {
      return failFromError(error)
    }
  })

  /** Convert a Claude-format MCP config into dsh rows WITHOUT writing anything,
   * so the dialog can show the user what will be imported first. */
  handle('mcp:parseClaude', (_event, text: string, layer: 'home' | 'profile', profile?: string): IpcResult<McpImportPreview> => {
    try {
      if (typeof text !== 'string' || text.trim() === '') return fail(E.nameInvalid)
      if (layer !== 'home' && layer !== 'profile') return fail(E.mcpLayerUnknown)
      if (layer === 'profile' && (typeof profile !== 'string' || profile === '')) return fail(E.nameInvalid)
      return { ok: true, value: parseClaudeMcp(text, layer, profile) }
    } catch (error) {
      return failFromError(error)
    }
  })

  /** Write a batch of already-previewed servers. */
  handle('mcp:import', (_event, servers: McpAddInput[]): IpcResult<string[]> => {
    try {
      if (!Array.isArray(servers) || servers.some(s => invalidAdd(s))) return fail(E.nameInvalid)
      return { ok: true, value: importMcpServers(servers) }
    } catch (error) {
      return failFromError(error)
    }
  })
}
