/**
 * IPC for the global instruction file (`rule:*`).
 *
 * The path is never taken from the renderer: it is always resolved from the
 * active dsh's home, so these handlers cannot be aimed at another file.
 */

import { shell } from 'electron'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { handle } from './handle.ts'
import { describeRuleFile, readRuleFile, ruleFilePath, writeRuleFile } from '../core/rule.ts'
import { fail, failFromError, E } from '../core/errors.ts'
import type { IpcResult, RuleFile } from '../../shared/types.ts'

export function registerRuleIpc(): void {
  /** State + content of the active dsh's global instruction file. */
  handle('rule:read', (): IpcResult<{ file: RuleFile; content: string }> => {
    try {
      return { ok: true, value: { file: describeRuleFile(), content: readRuleFile() ?? '' } }
    } catch (error) {
      return failFromError(error)
    }
  })

  /** Save the file. The per-file cap and the no-empty-write rule live in core. */
  handle('rule:write', (_event, content: string): IpcResult<RuleFile> => {
    try {
      if (typeof content !== 'string') return fail(E.nameInvalid)
      return { ok: true, value: writeRuleFile(content) }
    } catch (error) {
      return failFromError(error)
    }
  })

  /** Reveal the file in the OS file manager (selects it when it exists). */
  handle('rule:reveal', (): IpcResult<boolean> => {
    try {
      const path = ruleFilePath()
      if (existsSync(path)) shell.showItemInFolder(path)
      // Nothing to select yet: fall back to the home directory so the click is
      // never a silent no-op.
      else void shell.openPath(dirname(path))
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })

  /** Open the file itself in the OS default editor.
   *
   * Distinct from `rule:reveal`, which selects it inside the file manager. This
   * one is what the path line and its button offer, because editing the rules in
   * a real editor is a normal thing to want. It reports failure instead of
   * resolving silently, so the UI can say the file could not be opened (there is
   * no editor association, the file is gone, …) rather than appearing to work. */
  handle('rule:openFile', async (): Promise<IpcResult<boolean>> => {
    try {
      const path = ruleFilePath()
      // The file may not exist yet; opening a missing path would fail with an
      // opaque OS message. Report it precisely so the UI can disable/warn first.
      if (!existsSync(path)) return fail(E.ruleFileMissing, { path })
      const message = await shell.openPath(path)
      return message === '' ? { ok: true, value: true } : fail(E.shellOpenPath, { detail: message })
    } catch (error) {
      return failFromError(error)
    }
  })
}
