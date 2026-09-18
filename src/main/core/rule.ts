/**
 * The active dsh's global instruction file (`$DSH_HOME/AGENTS.md`).
 *
 * dsh injects this file into the system prompt of EVERY session under the home,
 * alongside a per-project chain. Two facts shape this module:
 *
 *   - The user-global file is a FIXED single name. dsh does not consult the
 *     project candidate list (`AGENTS.md` / `CLAUDE.md` / `*.local.md`) here, so
 *     writing e.g. `$DSH_HOME/CLAUDE.md` would be silently ignored. Only
 *     `AGENTS.md` is read.
 *   - It is prepended to the project chain, and when the byte budget is exceeded
 *     dsh drops the BROADEST files first — so this file is the first to be
 *     omitted. The budget comes from the `agent-instructions` row's `maxBytes`
 *     (dsh-base and the cordis preset both use 65536) and the per-file source cap
 *     is 1 MiB; exceeding either silently loses instructions, which is why the UI
 *     reports usage instead of just offering an editor.
 *
 * Project-level files are deliberately out of scope: they are discovered from a
 * session's workspace cwd upward, and the Launcher has no workspace concept.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { activeDshEntry } from './appState.ts'
import { writePatchFileAtomic } from './app-util.ts'
import { E, throwE } from './errors.ts'
import type { RuleFile } from '../../shared/types.ts'

/** The one filename dsh loads from the home root. */
export const RULE_FILE_NAME = 'AGENTS.md'

/** Per-file cap dsh applies before rendering (`maxSourceBytes`). A larger file
 * is ignored ENTIRELY, not truncated, so it is worth surfacing. */
export const RULE_SOURCE_LIMIT = 1_048_576

/** dsh-base's `agent-instructions` budget, and the cordis preset's. */
export const RULE_DEFAULT_BUDGET = 65_536

/**
 * The active dsh's home, or undefined when none is selected.
 *
 * Deliberately does NOT fall back to `$DSH_HOME` / `~/.dsh` the way `dshHome()`
 * does. This module WRITES the user's instruction file, and on a machine that
 * exports `DSH_HOME` (this one does) a fallback resolves to the real home — so a
 * caller without an active dsh would silently read and overwrite a real user's
 * rules. Every entry point refuses instead.
 */
function activeHome(): string | undefined {
  return activeDshEntry()?.home
}

/** Absolute path of the active dsh's global instruction file.
 * Throws when no dsh is active — see {@link activeHome}. */
export function ruleFilePath(): string {
  const home = activeHome()
  if (home === undefined) throw new Error('no active dsh: the instruction file path cannot be resolved')
  return join(home, RULE_FILE_NAME)
}

/** Whether a candidate is the global instruction file dsh actually loads. */
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** Read the file's text, or undefined when it does not exist. */
export function readRuleFile(): string | undefined {
  try {
    return readFileSync(ruleFilePath(), 'utf8')
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

/** Size/state of the global instruction file for display. */
export function describeRuleFile(): RuleFile {
  const path = ruleFilePath()
  let bytes: number | undefined
  let modified: string | undefined
  try {
    const info = statSync(path)
    bytes = info.size
    modified = info.mtime.toISOString()
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  return {
    path,
    exists: bytes !== undefined,
    bytes,
    modified,
    sourceLimit: RULE_SOURCE_LIMIT,
    // The effective budget is a composition value (a profile or the home layer
    // may override the preset's `maxBytes`); reporting the default without
    // claiming it is authoritative keeps the usage hint honest.
    budget: RULE_DEFAULT_BUDGET,
  }
}

/**
 * Write the global instruction file.
 *
 * The content is written verbatim — it is the user's own prose, not a config the
 * app interprets — but the one failure mode worth blocking is exceeding dsh's
 * per-file cap, which would make the file silently ignored and look like the
 * Launcher ate it. `writePatchFileAtomic` gives the write the same
 * temp+rename+.bak safety the patch files get.
 */
export function writeRuleFile(content: string): RuleFile {
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > RULE_SOURCE_LIMIT) {
    // A coded error, so the toast is the translated message; a bare Error would
    // surface as `errors.internal` with raw English. `FailParams` is string-only,
    // so the message carries no numbers — the pane already shows the exact usage.
    throwE(E.ruleTooLarge)
  }
  const path = ruleFilePath()
  // Refuse an empty write: dsh simply loads nothing, and an accidental "select
  // all + delete + save" would otherwise destroy the file with no undo in the UI.
  // Deleting the file is a deliberate act that belongs in the file manager.
  if (content.trim() === '' && existsSync(path)) throwE(E.ruleEmpty)
  writePatchFileAtomic(path, content)
  return describeRuleFile()
}
