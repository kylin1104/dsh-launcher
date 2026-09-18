/** IPC for the machine-level home patch layer (`home:*`). */

import { handle } from './handle.ts'
import { existsSync, readFileSync } from 'node:fs'
import { homePatchPath } from '../core/home.ts'
import { setRowDisabled, parseNamedRows } from '../core/patch.ts'
import { isValidPatchDocument, verifyDisabledState, writePatchFileAtomic } from '../core/app-util.ts'
import { fail, failFromError, E } from '../core/errors.ts'
import { rowIdInvalid } from './validate.ts'
import type { IpcResult } from '../../shared/types.ts'

export function registerHomeIpc(): void {
  // Machine-level, shared by every profile; composes after each profile patch.
  handle('home:setDisabled', (_event, id: string, disabled: boolean): IpcResult<boolean> => {
    try {
      if (rowIdInvalid(id)) return fail(E.nameInvalid)
      const path = homePatchPath()
      const current = existsSync(path) ? readFileSync(path, 'utf8') : '[]'
      // Refuse to toggle a row that is not here: setRowDisabled would APPEND one,
      // putting a junk row in the user's machine-wide layer (mcp.ts guards this
      // the same way, and for the same reason).
      if (!parseNamedRows(current).some(row => row.id === id)) return fail(E.patchRowNotFound, { id })
      const next = setRowDisabled(current, id, disabled)
      // Never leave a document dsh cannot boot from: it requires a top-level
      // array, and a raw write of an unparsable edit fails loud at startup.
      if (!isValidPatchDocument(next)) return fail(E.patchWriteVerify, { id })
      writePatchFileAtomic(path, next)
      const after = readFileSync(path, 'utf8')
      if (verifyDisabledState(after, id, disabled)) return { ok: true, value: true }
      return fail(E.patchWriteVerify, { id })
    } catch (error) {
      return failFromError(error)
    }
  })
}