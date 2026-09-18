/** IPC for skill browsing (`skill:*`): scan every root dsh reads, and read one
 * skill's body.
 *
 * Read-only by design: dsh has no skill enable/disable switch (the frontmatter
 * `disable-model-invocation` only stops automatic model invocation), so the
 * Launcher exposes no toggle rather than one that would silently do nothing. */

import { existsSync, statSync } from 'node:fs'
import { shell } from 'electron'
import { handle } from './handle.ts'
import { readSkillBody, scanSkills } from '../core/skill.ts'
import { fail, failFromError, E } from '../core/errors.ts'
import type { IpcResult, SkillScanResult, SkillSource } from '../../shared/types.ts'

/** The sources a body read may target — the same set the scanner produces. */
const SOURCES: readonly SkillSource[] = [
  'project-dsh', 'project-agents', 'custom', 'user-dsh', 'user-agents', 'bundled',
]

function isSource(value: unknown): value is SkillSource {
  return typeof value === 'string' && (SOURCES as readonly string[]).includes(value)
}

export function registerSkillIpc(): void {
  /** Every skill across every root dsh would scan, with shadowing resolved. */
  handle('skill:scan', (): IpcResult<SkillScanResult> => {
    try {
      return { ok: true, value: scanSkills() }
    } catch (error) {
      return failFromError(error)
    }
  })

  /** Read one skill's body. The renderer names a skill (name + source + rank);
   * the path is resolved from a fresh scan rather than accepted from the caller,
   * so a compromised renderer cannot turn this into an arbitrary file read. */
  handle('skill:read', (_event, name: string, source: SkillSource, rank: number): IpcResult<{ content: string; file: string }> => {
    try {
      if (typeof name !== 'string' || name === '' || !isSource(source) || typeof rank !== 'number') {
        return fail(E.nameInvalid)
      }
      const hit = scanSkills().rows.find(
        row => row.name === name && row.source === source && row.rank === rank,
      )
      if (hit === undefined) return fail(E.skillNotFound, { name })
      return { ok: true, value: readSkillBody(hit.path) }
    } catch (error) {
      return failFromError(error)
    }
  })

  /** Open a skill's directory in the OS file explorer. As with `skill:read`, the
   * path is resolved from a fresh scan — never taken from the renderer. */
  handle('skill:openDir', (_event, name: string, source: SkillSource, rank: number): IpcResult<boolean> => {
    try {
      if (typeof name !== 'string' || name === '' || !isSource(source) || typeof rank !== 'number') {
        return fail(E.nameInvalid)
      }
      const hit = scanSkills().rows.find(
        row => row.name === name && row.source === source && row.rank === rank,
      )
      if (hit === undefined) return fail(E.skillNotFound, { name })
      // A bundle skill's `path` IS its directory; a flat skill's is its file.
      if (statSync(hit.path).isDirectory()) shell.openPath(hit.path)
      else shell.showItemInFolder(hit.path)
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })

  /** Open a skill ROOT directory (the scanned root, not a single skill). */
  handle('skill:openRoot', (_event, path: string): IpcResult<boolean> => {
    try {
      // Confine to a path a fresh scan actually reports, so this cannot be used
      // to open an arbitrary directory.
      if (typeof path !== 'string' || path === '') return fail(E.nameInvalid)
      const hit = scanSkills().roots.find(root => root.path === path)
      if (hit === undefined) return fail(E.skillNotFound, { name: path })
      if (!existsSync(hit.path)) return fail(E.skillNotFound, { name: path })
      void shell.openPath(hit.path)
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })
}
