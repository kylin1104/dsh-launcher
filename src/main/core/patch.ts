/**
 * Line-level read/write of a `cordis.patch.yml` profile layer.
 *
 * Unlike a whole-file YAML dump, this edits only the target `disabled` line and
 * preserves every other line byte-for-byte — including comments and hand-written
 * rows (the lesson from earlier enable/disable work that re-dumped and lost them).
 */

import type { ClassifiedRow, PluginRow, RowCreateInput } from '../../shared/types.ts'

/** Matches a `- id: xxx` row start. Accepts a single- or double-quoted id, and a
 * trailing `# comment`, because dsh's YAML does: a quoted id must not keep its
 * quotes (or the row is invisible and a toggle appends a duplicate block), and a
 * trailing comment must not hide the row. */
const ID_RE = /^(\s*)- id:\s*(?:'([^']*)'|"([^"]*)"|([^'"\s#]+))/

/** Whether a line is a top-level (column-0) `[]` empty-array marker. A nested
 * `[]` value (e.g. `  config: []`) is indented and is NOT treated as one. */
function isTopLevelEmptyArray(line: string): boolean {
  return line.trim() === '[]' && line === line.trimStart()
}

/** A profile patch may carry a `[]` marker (the create template writes one, or a
 * row hand-added). Once real rows exist that marker is both meaningless and
 * invalid YAML — it forms a second top-level document. Strip such top-level
 * `[]` lines so appending rows replaces the empty overlay instead of sitting
 * beside it. Read-only parsing still sees the text as-is. */
function stripEmptyArrayMarker(text: string): string {
  return text.split('\n').filter(line => !isTopLevelEmptyArray(line)).join('\n')
}

/** The id a `- id:` line declares, or undefined when the line is not one. */
function matchId(line: string): string | undefined {
  const m = ID_RE.exec(line)
  if (m === null) return undefined
  // Group 2/3 are the quoted forms; group 4 is bare. Exactly one is set.
  return m[2] ?? m[3] ?? m[4]
}

/**
 * Line index of the LAST block carrying `id` — the one dsh actually resolves.
 *
 * dsh composes patch layers by row id, so a later block overrides an earlier one.
 * Every reader and writer targets this block: editing the FIRST instead made a
 * toggle silently do nothing once another writer had appended an override row, and
 * made a reader report a value dsh had already superseded (see {@link effectiveRow}).
 */
function findEffectiveIdLine(lines: string[], id: string): number | undefined {
  let found: number | undefined
  for (let i = 0; i < lines.length; i++) {
    if (matchId(lines[i]) === id) found = i
  }
  return found
}

/** Leading whitespace width of a line. */
function indentOf(line: string): number {
  return /^(\s*)/.exec(line)?.[1].length ?? 0
}

/**
 * The block's OWN key lines: those deeper than the row's `- id:` line and at the
 * shallowest such indent.
 *
 * Two things must be excluded, and both are indentation:
 *   - a nested mapping's keys (`config:` → `opts:` → `disabled:`), and
 *   - a PARENT block's keys when this row is nested inside its `insert:` list —
 *     the parent's `disabled:` sits at a SHALLOWER indent than this row's id.
 * Deeper-than-the-id is the correct bound: a row's own keys are its immediate
 * children, always indented past its `- id:`; everything else belongs elsewhere.
 */
function ownKeyLines(lines: string[], start: number, end: number): string[] {
  const idIndent = indentOf(lines[start] ?? '')
  const content = lines.slice(start + 1, end)
    .filter(line => line.trim() !== '' && !line.trim().startsWith('#'))
    .filter(line => indentOf(line) > idIndent)
  const own: string[] = []
  let min: number | undefined
  for (const line of content) {
    const indent = indentOf(line)
    if (min === undefined || indent < min) { min = indent; own.length = 0 }
    if (indent === min) own.push(line)
  }
  return own
}

/** Read `key: <value>` from a set of candidate lines (last write wins). */
function readKey(lines: string[], key: string): string | undefined {
  let found: string | undefined
  const re = new RegExp(`^\\s*${key}:\\s*(.*)$`)
  for (const line of lines) {
    const m = re.exec(line)
    if (m !== null) found = m[1]
  }
  return found
}

/**
 * Whether an EARLIER block for `id` leaves `disabled: true` in force.
 *
 * Used when enabling a row by deleting its `disabled:` line: an omitted field is
 * inherited from earlier blocks, so a `true` stated before this block would come
 * back and the row would stay disabled. Scans the blocks before `beforeIndex`
 * with the same inherit rule {@link effectiveRow} uses.
 */
function earlierBlockDisables(lines: string[], beforeIndex: number, id: string): boolean {
  let disabled = false
  for (let i = 0; i < beforeIndex; i++) {
    if (matchId(lines[i]) !== id) continue
    // Read the LAST `disabled:` in the block, like parseNamedRows: a nested
    // lookalike inside `config:` must not shadow the row's own key.
    const end = Math.min(blockEnd(lines, i), beforeIndex)
    for (let j = i + 1; j < end; j++) {
      const d = /^\s*disabled:\s*(true|false)/.exec(lines[j])
      if (d !== null) disabled = d[1] === 'true'
    }
  }
  return disabled
}

/**
 * End (exclusive) of the block starting at `start` — the next row, or EOF.
 *
 * A `- ` line ends the block ONLY when it is indented no deeper than this block's
 * own `- id:` line. Treating every `- ` as a new row truncated the block at a
 * block-style sequence nested in `config:` (`args:\n  - x`), which hid the row's
 * own `disabled:` — so a disabled server read as enabled, `verifyDisabledState`
 * confirmed that false state, and writing `disabled: true` produced a duplicate
 * key (invalid YAML that fails dsh's boot).
 */
function blockEnd(lines: string[], start: number): number {
  const base = indentOf(lines[start] ?? '')
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    if (/^\s*- /.test(line) && indentOf(line) <= base) return i
  }
  return lines.length
}

/** Parse every `- id:` row and whether it is disabled. */
export function parsePatchRows(text: string): PluginRow[] {
  const lines = text.split('\n')
  const rows: PluginRow[] = []
  for (let i = 0; i < lines.length; i++) {
    const id = matchId(lines[i])
    if (id === undefined) continue
    // The row's OWN key lines only: a nested `disabled:` inside `config:` is not
    // the row's state. All three parsers share this helper so they cannot disagree.
    const own = ownKeyLines(lines, i, blockEnd(lines, i))
    rows.push({ id, disabled: readBool(own, 'disabled') === true })
  }
  return rows
}

/** A row with its package name (when the block carries one) and disabled state. */
export interface NamedRow {
  id: string
  name?: string
  disabled: boolean
  /** Whether THIS block actually wrote a `disabled:` line (see {@link effectiveRow}). */
  disabledExplicit?: boolean
}

/**
 * The row that actually decides an id's state: the LAST block carrying it, with
 * any field it omits INHERITED from the blocks before it.
 *
 * dsh composes patch layers by row id, and a later row for the same id overrides
 * an earlier one. A field the later row omits is inherited rather than reset, so
 * the last EXPLICIT setting wins — measured against `dsh --dump-config`:
 *
 *   block 1: disabled: true
 *   block 2: (no disabled)        -> effective true
 *   block 3: disabled: false      -> effective false
 *
 * A block that declares a `name:` different from the row's resolved name is
 * SKIPPED ENTIRELY — dsh's `applyEntryPatches` treats the name as an assertion
 * (`if (name && name !== target.name) continue`) and applies none of its fields,
 * so it must not contribute to inheritance either:
 *
 *   block 1: name: '@pkg/A', disabled: true
 *   block 2: name: '@pkg/B'          -> dsh resolves name '@pkg/B', ENABLED
 *   (an earlier name-only match is not visible here; see the tests)
 *
 * Another writer may express "disable" by APPENDING a fresh `- id:` row instead
 * of editing the original, leaving the file with two blocks for one id. Reading
 * only the first block then reports the opposite of what dsh does, and writing to
 * it changes nothing.
 */
export function effectiveRow(text: string, id: string): NamedRow | undefined {
  let found: NamedRow | undefined
  for (const row of parseNamedRows(text)) {
    if (row.id !== id) continue
    // dsh asserts the name: a block naming a DIFFERENT package is skipped whole.
    if (row.name !== undefined && found?.name !== undefined && row.name !== found.name) continue
    found = {
      id: row.id,
      ...(row.name !== undefined ? { name: row.name } : (found?.name !== undefined ? { name: found.name } : {})),
      // Inherit: a block that states nothing leaves the previous value in place.
      disabled: row.disabledExplicit ? row.disabled : (found?.disabled ?? false),
    }
  }
  return found
}

/** Read a boolean `key: true|false` from candidate lines (last write wins). */
function readBool(lines: string[], key: string): boolean | undefined {
  const raw = readKey(lines, key)
  if (raw === undefined) return undefined
  const v = raw.trim()
  return v === 'true' ? true : v === 'false' ? false : undefined
}

/** Parse rows including each block's `name:` (for bundle-built plugin rows). */
export function parseNamedRows(text: string): NamedRow[] {
  const lines = text.split('\n')
  const rows: NamedRow[] = []
  for (let i = 0; i < lines.length; i++) {
    const id = matchId(lines[i])
    if (id === undefined) continue
    const own = ownKeyLines(lines, i, blockEnd(lines, i))
    const name = unquoteYamlScalar(readKey(own, 'name'))
    const explicit = own.some(line => /^\s*disabled\s*:/.test(line))
    rows.push({ id, name, disabled: readBool(own, 'disabled') === true, disabledExplicit: explicit })
  }
  return rows
}

/** Strip one layer of YAML quotes from a scalar, if present. */
function unquoteYamlScalar(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const v = raw.trim()
  const m = /^'([^']*)'$/.exec(v) ?? /^"([^"]*)"$/.exec(v)
  return m !== null ? m[1] : v
}

/**
 * Return a new `cordis.patch.yml` text with the named row's disabled state set.
 * Preserves all untouched lines. Idempotent: setting the same value is a no-op.
 *
 * Targets the LAST block carrying the id (the one dsh resolves): when another
 * writer appended an override row, editing the first block would leave the
 * effective state unchanged — a toggle that silently does nothing.
 */
export function setRowDisabled(text: string, id: string, disabled: boolean): string {
  text = stripEmptyArrayMarker(text)
  const lines = text.split('\n')
  const idIndex = findEffectiveIdLine(lines, id)

  // ── no row yet: append a fresh block ────────────────────────────────
  if (idIndex === undefined) {
    const trimmed = text.trim()
    if (trimmed === '' || trimmed === '[]') {
      return disabled ? `- id: ${id}\n  disabled: true\n` : `- id: ${id}\n`
    }
    const addition = `- id: ${id}\n  disabled: ${disabled}`
    return text.endsWith('\n') ? text + addition + '\n' : `${text}\n${addition}\n`
  }

  const end = blockEnd(lines, idIndex)
  const indent = /^(\s*)/.exec(lines[idIndex])?.[1] ?? ''

  // Locate the block's OWN `disabled:` line. A nested lookalike (config.opts.
  // disabled) must not be mistaken for it, or the edit lands inside `config:`.
  const own = new Set(ownKeyLines(lines, idIndex, end))
  let disabledLine = -1
  for (let j = idIndex + 1; j < end; j++) {
    if (own.has(lines[j]) && /^\s*disabled:/.test(lines[j])) {
      disabledLine = j
      break
    }
  }

  if (disabled) {
    if (disabledLine >= 0) {
      const dIndent = /^(\s*)/.exec(lines[disabledLine])?.[1] ?? ''
      lines[disabledLine] = `${dIndent}disabled: true`
    } else {
      lines.splice(idIndex + 1, 0, `${indent}  disabled: true`)
    }
  } else {
    // Enabling. Only work is needed when the effective state is actually disabled:
    //   - `disabled: true`  → flip it
    //   - absent            → enabled UNLESS an earlier block states `true`, which
    //     this block inherits; then an explicit `false` must be written, or the
    //     toggle would silently do nothing.
    //   - `disabled: false` → already enabled and explicitly stated, leave it
    // Unconditionally splicing the line (the previous behaviour) rewrote rows
    // that were already enabled, and dropped a trailing `disabled: false` that
    // the user had written deliberately.
    if (disabledLine >= 0 && /^\s*disabled:\s*true\s*$/.test(lines[disabledLine])) {
      // Removing the line normally restores the default-enabled shape. But when
      // an EARLIER block for this id also states `disabled: true`, the omission
      // would inherit that `true` and the row would stay disabled — so write an
      // explicit `false` in that case instead of deleting.
      const inherited = earlierBlockDisables(lines, idIndex, id)
      if (inherited) {
        const dIndent = /^(\s*)/.exec(lines[disabledLine])?.[1] ?? ''
        lines[disabledLine] = `${dIndent}disabled: false`
      } else {
        lines.splice(disabledLine, 1)
        // If the block now holds nothing but comments/blank lines, drop the id row too.
        const newEnd = blockEnd(lines, idIndex)
        const bodyOnlyComments = lines.slice(idIndex + 1, newEnd).every(
          line => line.trim() === '' || line.trim().startsWith('#'),
        )
        if (bodyOnlyComments) lines.splice(idIndex, 1)
      }
    } else if (disabledLine < 0 && earlierBlockDisables(lines, idIndex, id)) {
      // This block states nothing, so it INHERITS `true` from an earlier one and
      // the row is effectively disabled. Deleting is not an option (there is no
      // line here), so state the enabled value explicitly — otherwise enabling
      // would be a silent no-op.
      lines.splice(idIndex + 1, 0, `${indent}  disabled: false`)
    }
  }

  // A patch file must remain a top-level YAML array: dsh's `parsePatchList` throws
  // on `yaml.load('')` ("must be a top-level YAML array"), bricking the layer at
  // boot. Dropping the last row's id line can empty the document, so fall back to
  // the empty-array marker the create template uses.
  if (lines.every(line => line.trim() === '')) return EMPTY_PATCH

  return lines.join('\n')
}

/** The canonical empty patch layer: a top-level empty array. */
const EMPTY_PATCH = '[]\n'

/** Parse every patch row, classifying each block's shape (name/disabled/config/insert). */
export function parseClassifiedRows(text: string): ClassifiedRow[] {
  const lines = text.split('\n')
  const rows: ClassifiedRow[] = []
  for (let i = 0; i < lines.length; i++) {
    const id = matchId(lines[i])
    if (id === undefined) continue
    const own = ownKeyLines(lines, i, blockEnd(lines, i))
    rows.push({
      id,
      name: unquoteYamlScalar(readKey(own, 'name')),
      disabled: readBool(own, 'disabled') === true,
      hasConfig: own.some(line => /^\s*config\s*:/.test(line)),
      hasInsert: own.some(line => /^\s*insert\s*:/.test(line)),
    })
  }
  return rows
}

/** Render the indented `config` key lines for a block's key indent. */
function renderConfig(indent: string, configText: string): string[] {
  const parts = configText.replace(/\s+$/, '').split('\n')
  if (parts.filter(p => p.trim() !== '').length <= 1 && !configText.includes('\n')) {
    return [`${indent}config: ${configText.trim()}`]
  }
  return [`${indent}config:`, ...parts.map(line => (line.trim() === '' ? '' : `${indent}  ${line}`))]
}

/** Render an `insert:` list block (empty items remove the key). */
function renderInsert(indent: string, items: string[]): string[] {
  if (items.length === 0) return []
  return [`${indent}insert:`, ...items.map(item => `${indent}  - ${item}`)]
}

/** Replace an existing key's block (key line + nested lines up to the next
 * same-or-less-indented line) with `render(indent)`. Returns whether it existed. */
function replaceKey(
  lines: string[], idIndex: number, key: string, render: (indent: string) => string[],
): boolean {
  const end = blockEnd(lines, idIndex)
  for (let j = idIndex + 1; j < end; j++) {
    if (!new RegExp(`^\\s*${key}\\s*:`).test(lines[j])) continue
    const keyIndent = /^(\s*)/.exec(lines[j])?.[1] ?? ''
    let remEnd = end
    for (let k = j + 1; k < end; k++) {
      const line = lines[k]
      if (line.trim() === '' || line.trim().startsWith('#')) continue
      if ((/^(\s*)/.exec(line)?.[1] ?? '').length <= keyIndent.length) { remEnd = k; break }
    }
    lines.splice(j, remEnd - j, ...render(keyIndent))
    return true
  }
  return false
}

/** Append a key block to the end of the row's block. */
function appendKey(lines: string[], idIndex: number, render: (indent: string) => string[]): void {
  const end = blockEnd(lines, idIndex)
  const indent = /^(\s*)/.exec(lines[idIndex])?.[1] ?? ''
  lines.splice(end, 0, ...render(`${indent}  `))
}

/** Return a new patch text with the row's `config` key replaced by `configText`
 * (the value's YAML body). Throws when the row is absent — config always
 * targets an existing row. */
export function setRowConfig(text: string, id: string, configText: string): string {
  text = stripEmptyArrayMarker(text)
  const lines = text.split('\n')
  const idIndex = findEffectiveIdLine(lines, id)
  if (idIndex === undefined) throw new Error(`row "${id}" not found`)
  const render = (indent: string): string[] => renderConfig(indent, configText)
  if (!replaceKey(lines, idIndex, 'config', render)) appendKey(lines, idIndex, render)
  return lines.join('\n')
}

/** Return a new patch text with the row's `insert` list set to `insertItems`
 * (each item its own `- …` entry). Creates the row block when absent. An empty
 * list removes the `insert` key. */
export function setRowInsert(text: string, id: string, insertItems: string[]): string {
  text = stripEmptyArrayMarker(text)
  const items = insertItems.map(item => item.trim()).filter(item => item !== '')
  const lines = text.split('\n')
  const idIndex = findEffectiveIdLine(lines, id)
  const render = (indent: string): string[] => renderInsert(indent, items)
  if (idIndex === undefined) {
    // No such row yet: append a fresh block at the end.
    const tail = render('  ')
    const block = [`- id: ${id}`, ...tail].join('\n') + '\n'
    const sep = text === '' ? '' : (text.endsWith('\n') ? '' : '\n')
    return text === '' ? block : text + sep + block
  }
  if (!replaceKey(lines, idIndex, 'insert', render) && items.length > 0) {
    appendKey(lines, idIndex, render)
  }
  return lines.join('\n')
}

/** Build a fresh `- id:` block's text from the given fields. */
function buildRowBlock(patch: RowCreateInput): string {
  const lines = [`- id: ${patch.id}`]
  if (patch.disabled !== undefined) lines.push(`  disabled: ${patch.disabled}`)
  if (patch.config !== undefined && patch.config.trim() !== '') {
    lines.push(...renderConfig('  ', patch.config))
  } else if (patch.insert !== undefined && patch.insert.length > 0) {
    lines.push(...renderInsert('  ', patch.insert))
  }
  return lines.join('\n')
}

/** Append a raw row block to the end of a patch document, replacing a leading
 * `[]` empty-overlay marker so the result is a single top-level list. */
export function appendRowBlock(text: string, block: string): string {
  const base = stripEmptyArrayMarker(text)
  if (base === '') return `${block}\n`
  return base.endsWith('\n') ? base + block + '\n' : `${base}\n${block}\n`
}

/** Upsert a row in the patch: create the block when absent, otherwise merge the
 * given fields in (disabled/config/insert each edited independently). */
export function upsertRow(text: string, patch: RowCreateInput): string {
  text = stripEmptyArrayMarker(text)
  const lines = text.split('\n')
  if (findEffectiveIdLine(lines, patch.id) === undefined) {
    return appendRowBlock(text, buildRowBlock(patch))
  }
  let out = text
  if (patch.disabled !== undefined) out = setRowDisabled(out, patch.id, patch.disabled)
  if (patch.config !== undefined) out = setRowConfig(out, patch.id, patch.config)
  if (patch.insert !== undefined) out = setRowInsert(out, patch.id, patch.insert)
  return out
}

/** Remove every block for one id (`- id:` through the next row / EOF). A no-op
 * when the id is absent. All other lines are preserved.
 *
 * ALL blocks go, not just the effective one: callers use this as "this row no
 * longer exists" — `addMcpServer` replaces the row wholesale, `profile:removeRow`
 * restores the bundle default. Removing only the last block would leave an
 * earlier block behind, and dsh would still apply it. */
export function removeRow(text: string, id: string): string {
  text = stripEmptyArrayMarker(text)
  let lines = text.split('\n')
  // Walk BACKWARD so a splice cannot invalidate the next index.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (matchId(lines[i]) !== id) continue
    lines = [...lines.slice(0, i), ...lines.slice(blockEnd(lines, i))]
  }
  const joined = lines.join('\n')
  return joined.trim() === '' ? EMPTY_PATCH : joined
}

/** Extract a row block's verbatim text (its `- id:` line + child keys). */
export function extractRowBlock(text: string, id: string): string | undefined {
  const lines = text.split('\n')
  const idx = findEffectiveIdLine(lines, id)
  if (idx === undefined) return undefined
  return lines.slice(idx, blockEnd(lines, idx)).join('\n')
}

/** Extract the value text of a named key (`config`, `name`, …) within a row's
 * block. Returns the scalar value for `config: {}`/`config: str`, or the
 * sub-block text (with the key's 2-space nesting stripped) for a block form.
 * `undefined` when the row or key is absent. */
export function extractKeyValue(text: string, id: string, key: string): string | undefined {
  const lines = text.split('\n')
  const idx = findEffectiveIdLine(lines, id)
  if (idx === undefined) return undefined
  const end = blockEnd(lines, idx)
  const head = new RegExp(`^\\s*${key}\\s*:\\s*(.*)$`)
  for (let j = idx + 1; j < end; j++) {
    const m = head.exec(lines[j])
    if (m === null) continue
    const inline = m[1].trim()
    if (inline !== '') return inline
    const keyIndent = /^(\s*)/.exec(lines[j])?.[1] ?? ''
    const collected: string[] = []
    for (let k = j + 1; k < end; k++) {
      const line = lines[k]
      if (line.trim() === '') { collected.push(''); continue }
      const ind = /^(\s*)/.exec(line)?.[1] ?? ''
      if (ind.length <= keyIndent.length) break
      collected.push(line.replace(new RegExp(`^\\s{${keyIndent.length + 2}}`), ''))
    }
    return collected.join('\n')
  }
  return undefined
}