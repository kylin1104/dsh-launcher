/**
 * Behavior-locking tests for the line-level `cordis.patch.yml` editor.
 *
 * These lock the exact output strings — including preserving untouched lines,
 * comments and hand-written rows — the regression risk the module exists to
 * protect against.
 */
import { describe, it, expect } from 'vitest'
import {
  parsePatchRows,
  parseNamedRows,
  parseClassifiedRows,
  setRowDisabled,
  setRowConfig,
  setRowInsert,
  upsertRow,
  removeRow,
  extractRowBlock,
  extractKeyValue,
  effectiveRow,
} from './patch.ts'

describe('parsePatchRows', () => {
  it('parses row ids and disabled state', () => {
    expect(parsePatchRows('- id: a\n  disabled: true\n- id: b\n')).toEqual([
      { id: 'a', disabled: true },
      { id: 'b', disabled: false },
    ])
  })

  it('returns [] for empty text', () => {
    expect(parsePatchRows('')).toEqual([])
  })
})

describe('parseNamedRows', () => {
  it('captures the name and disabled state per block', () => {
    expect(parseNamedRows('- id: a\n  name: pkg-a\n  disabled: true\n\n- id: b\n')).toEqual([
      { id: 'a', name: 'pkg-a', disabled: true, disabledExplicit: true },
      { id: 'b', name: undefined, disabled: false, disabledExplicit: false },
    ])
  })
})

describe('parseClassifiedRows', () => {
  it('classifies shape: name/disabled/config/insert', () => {
    expect(parseClassifiedRows('- id: a\n  name: pkg-a\n  disabled: true\n  config:\n    k: v\n  insert:\n- id: b\n')).toEqual([
      { id: 'a', name: 'pkg-a', disabled: true, hasConfig: true, hasInsert: true },
      { id: 'b', name: undefined, disabled: false, hasConfig: false, hasInsert: false },
    ])
  })
})

describe('setRowDisabled', () => {
  it('appends a fresh disabled block to an empty/`[]` patch', () => {
    expect(setRowDisabled('[]', 'foo', true)).toBe('- id: foo\n  disabled: true\n')
    expect(setRowDisabled('', 'foo', true)).toBe('- id: foo\n  disabled: true\n')
  })

  it('enabling an absent row just records the enabled id', () => {
    expect(setRowDisabled('', 'foo', false)).toBe('- id: foo\n')
  })

  it('reverts a disabled row to the default by removing its override (dropping the bare id)', () => {
    expect(setRowDisabled('- id: a\n  disabled: true\n- id: b\n', 'a', false)).toBe('- id: b\n')
  })

  it('only edits the target row, preserving sibling rows byte-for-byte', () => {
    expect(setRowDisabled('- id: a\n- id: b\n  # keep me\n', 'b', true)).toBe(
      '- id: a\n- id: b\n  disabled: true\n  # keep me\n',
    )
  })

  it('leaves an explicit `disabled: false` alone instead of deleting it', () => {
    // A config may state the enabled state explicitly; enabling from there is a
    // no-op, not a rewrite of a line the user wrote deliberately.
    const text = '- id: a\n  name: "@x/y"\n  disabled: false\n'
    expect(setRowDisabled(text, 'a', false)).toBe(text)
  })

  it('leaves an already-enabled row (no disabled line) alone', () => {
    const text = '- id: a\n  name: "@x/y"\n'
    expect(setRowDisabled(text, 'a', false)).toBe(text)
  })

  it('round-trips disable→enable for a row that had NO explicit state', () => {
    // The common case: no `disabled:` line to start with. Disabling inserts one,
    // re-enabling removes it again — byte-for-byte identical.
    const text = '- id: a\n  name: "@x/y"\n- id: b\n  disabled: true\n'
    const off = setRowDisabled(text, 'a', true)
    expect(off).toBe('- id: a\n  disabled: true\n  name: "@x/y"\n- id: b\n  disabled: true\n')
    expect(setRowDisabled(off, 'a', false)).toBe(text)
  })

  it('an explicitly-enabled row is not rewritten by a redundant enable', () => {
    // `disabled: false` is a deliberate statement, but toggling such a row off
    // and back on intentionally normalizes it to the default. With nothing left
    // in the block, the id row goes too (the module's normal "bare id" cleanup).
    const text = '- id: a\n  disabled: false\n'
    const off = setRowDisabled(text, 'a', true)
    expect(off).toBe('- id: a\n  disabled: true\n')
    // Emptying the document must yield dsh's empty-array form, not '': dsh's
    // parsePatchList rejects an empty file ("must be a top-level YAML array"),
    // so writing '' here would stop the layer from booting.
    expect(setRowDisabled(off, 'a', false)).toBe('[]\n')
  })
})

describe('setRowConfig', () => {
  it('writes a single-line config override into the existing block', () => {
    expect(setRowConfig('- id: a\n  config:\n    k: v\n', 'a', 'k2: v2')).toBe('- id: a\n  config: k2: v2')
  })

  it('throws when the row is absent', () => {
    expect(() => setRowConfig('- id: a\n', 'nope', 'k: v')).toThrow('not found')
  })
})

describe('setRowInsert', () => {
  it('appends an insert list to an existing row', () => {
    const out = setRowInsert('- id: a\n', 'a', ['x', 'y'])
    expect(out).toContain('  insert:')
    expect(out).toContain('    - x')
    expect(out).toContain('    - y')
  })

  it('creates the block when the row does not exist', () => {
    expect(setRowInsert('', 'foo', ['z'])).toBe('- id: foo\n  insert:\n    - z\n')
  })
})

describe('upsertRow', () => {
  it('creates a disabled row from scratch', () => {
    expect(upsertRow('', { id: 'a', disabled: true })).toBe('- id: a\n  disabled: true\n')
  })

  it('merges disabled + config onto an existing row', () => {
    expect(upsertRow('- id: a\n', { id: 'a', disabled: true, config: 'k: v' })).toContain('  disabled: true')
    expect(upsertRow('- id: a\n', { id: 'a', disabled: true, config: 'k: v' })).toContain('  config: k: v')
  })
})

describe('removeRow', () => {
  it('drops the whole block, leaving siblings intact', () => {
    expect(removeRow('- id: a\n  disabled: true\n- id: b\n', 'a')).toBe('- id: b\n')
  })

  it('is a no-op when the row is absent', () => {
    expect(removeRow('- id: a\n', 'nope')).toBe('- id: a\n')
  })
})

describe('extractRowBlock', () => {
  it('returns the verbatim `- id:` + child keys', () => {
    expect(extractRowBlock('- id: a\n  disabled: true\n- id: b\n', 'a')).toBe('- id: a\n  disabled: true')
  })
})

describe('empty-array overlay marker', () => {
  const TEMPLATE = '# Your patch layer\n[]\n'

  it('replaces a lone-`[]` template when a row is upserted', () => {
    expect(upsertRow(TEMPLATE, { id: 'a', disabled: true })).toBe('# Your patch layer\n- id: a\n  disabled: true\n')
  })

  it('setRowInsert on an empty template does not leave the `[]` marker', () => {
    const out = setRowInsert(TEMPLATE, 'a', ['x'])
    expect(out).not.toContain('[]')
    expect(out).toContain('- id: a')
    expect(out).toContain('    - x')
  })

  it('keeps nested `[]` values untouched', () => {
    const out = upsertRow('- id: a\n  config:\n    mark: []\n', { id: 'b', disabled: true })
    expect(out).toContain('    mark: []')
  })

  it('heals a historical patch that already has `[]` before real rows', () => {
    const bad = '[]\n- id: storage\n  name: "@deepseek-ai/dsh-storage"\n'
    const healed = setRowDisabled(bad, 'storage', true)
    expect(healed).not.toContain('[]')
    expect(healed).toContain('- id: storage')
    expect(healed).toContain('disabled: true')
  })
})

describe('extractKeyValue', () => {
  it('extracts a nested block value for a key', () => {
    expect(extractKeyValue('- id: a\n  config:\n    k: v\n- id: b\n', 'a', 'config')).toBe('k: v')
  })

  it('handles inline scalar values', () => {
    expect(extractKeyValue('- id: a\n  config: {q: 1}\n', 'a', 'config')).toBe('{q: 1}')
  })
})

/**
 * An id can appear in MORE THAN ONE block: an external tool can write a disable by
 * APPENDING a fresh `- id:` row instead of editing the original, so a file it has
 * touched holds two blocks for one id. dsh resolves the LAST block and inherits a
 * field it omits (measured with `dsh --profile <p> --dump-config`), so reading or
 * writing the first block shows the wrong state and a toggle aimed at it silently
 * does nothing.
 */
describe('an id carried by several blocks', () => {
  const APPENDED_OVERRIDE = [
    '- insert:',
    '    - id: mcp-x',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: x',
    '',
    '# written by an external tool: disable mcp-x',
    '- id: mcp-x',
    "  name: '@deepseek-ai/dsh-mcp-client'",
    '  disabled: true',
    '',
  ].join('\n')

  it('effectiveRow reports the last block', () => {
    expect(effectiveRow(APPENDED_OVERRIDE, 'mcp-x')?.disabled).toBe(true)
  })

  it('inherits disabled from an earlier block when a later one omits it', () => {
    const text = '- id: x\n  disabled: true\n\n- id: x\n  name: p\n'
    expect(effectiveRow(text, 'x')?.disabled).toBe(true)
  })

  it('lets a later explicit false win over an earlier true', () => {
    const text = '- id: x\n  disabled: true\n\n- id: x\n  disabled: false\n'
    expect(effectiveRow(text, 'x')?.disabled).toBe(false)
  })

  it('enabling edits the LAST block, so the change actually takes effect', () => {
    const out = setRowDisabled(APPENDED_OVERRIDE, 'mcp-x', false)
    // The appended override is the block dsh resolves, so that is the one edited:
    // its `disabled: true` goes away, and the effective state flips to enabled.
    expect(effectiveRow(out, 'mcp-x')?.disabled).toBe(false)
    expect(out).not.toMatch(/written by an external tool[\s\S]*disabled: true/)
  })

  it('disabling edits the LAST block too', () => {
    const two = '- id: x\n  name: p\n\n- id: x\n  name: p\n  disabled: false\n'
    const out = setRowDisabled(two, 'x', true)
    expect(effectiveRow(out, 'x')?.disabled).toBe(true)
  })

  it('writes an explicit false when deleting the line would inherit true', () => {
    // Removing the trailing `disabled: true` would inherit the earlier `true`,
    // leaving the row disabled despite the "enable" — so it must write false.
    const text = '- id: x\n  disabled: true\n\n- id: x\n  disabled: true\n'
    const out = setRowDisabled(text, 'x', false)
    expect(effectiveRow(out, 'x')?.disabled).toBe(false)
  })

  it('enables when the LAST block omits disabled but inherits true', () => {
    // The last block states nothing, so it inherits the earlier `true` and the row
    // is effectively disabled. There is no line to delete here, so enabling must
    // INSERT an explicit false — otherwise the toggle would silently do nothing.
    const text = '- id: x\n  disabled: true\n\n- id: x\n  name: p\n'
    expect(effectiveRow(text, 'x')?.disabled).toBe(true)
    const out = setRowDisabled(text, 'x', false)
    expect(effectiveRow(out, 'x')?.disabled).toBe(false)
    // The other keys of the last block survive.
    expect(out).toContain('name: p')
  })

  it('leaves an effectively-enabled row alone when nothing states disabled', () => {
    const text = '- id: x\n  name: p\n'
    expect(setRowDisabled(text, 'x', false)).toBe(text)
  })
})

/**
 * Block boundaries and nesting. A `- ` line only ends a block when it is indented
 * no deeper than that block's own `- id:`; otherwise a block-style sequence in
 * `config:` looked like a new row, hiding the row's own keys (a disabled server
 * read as enabled, and writing produced a duplicate key that js-yaml rejects).
 */
describe('a block containing a nested sequence', () => {
  const NESTED_SEQ = [
    '- id: mcp-x',
    "  name: '@deepseek-ai/dsh-mcp-client'",
    '  config:',
    '    serverName: x',
    '    args:',
    '      - "s.js"',
    '  disabled: true',
    '',
  ].join('\n')

  it('still sees the row own disabled: after the sequence', () => {
    expect(parseNamedRows(NESTED_SEQ)[0]?.disabled).toBe(true)
    expect(effectiveRow(NESTED_SEQ, 'mcp-x')?.disabled).toBe(true)
  })

  it('does not add a second disabled: key when disabling', () => {
    const out = setRowDisabled(NESTED_SEQ, 'mcp-x', true)
    expect(out.match(/^\s*disabled:/gm)).toHaveLength(1)
  })

  it('enabling is not a silent no-op', () => {
    const out = setRowDisabled(NESTED_SEQ, 'mcp-x', false)
    expect(effectiveRow(out, 'mcp-x')?.disabled).toBe(false)
  })

  it('a nested disabled lookalike is not the row state', () => {
    const text = '- id: x\n  config:\n    opts:\n      disabled: false\n  disabled: true\n  name: p\n'
    expect(parseNamedRows(text)[0]?.disabled).toBe(true)
  })

  it('a row nested in insert: does not inherit its parent keys', () => {
    const text = '- id: group\n  insert:\n    - id: child-a\n      name: "@x/a"\n  disabled: true\n'
    const rows = parseNamedRows(text)
    expect(rows.find(r => r.id === 'group')?.disabled).toBe(true)
    // The parent's `disabled:` is shallower than the child's own id — not its key.
    expect(rows.find(r => r.id === 'child-a')?.disabled).toBe(false)
    expect(rows.find(r => r.id === 'child-a')?.name).toBe('@x/a')
  })
})

describe('id spellings dsh accepts', () => {
  it('strips a double-quoted id instead of keeping the quotes', () => {
    expect(parseNamedRows('- id: "a"\n  name: p\n')[0]?.id).toBe('a')
  })

  it('reads an id followed by a trailing comment', () => {
    expect(parseNamedRows('- id: a  # mine\n  name: p\n')[0]?.id).toBe('a')
  })
})

describe('the three parsers agree on disabled', () => {
  const cases = [
    '- id: x\n  disabled: true\n  name: p\n',
    '- id: x\n  disabled: false\n  name: p\n',
    '- id: x\n  config:\n    opts:\n      disabled: true\n  name: p\n',
    '- id: x\n  name: p\n',
  ]
  for (const [i, text] of cases.entries()) {
    it(`case ${i}`, () => {
      expect(parseClassifiedRows(text)[0]?.disabled).toBe(parseNamedRows(text)[0]?.disabled)
      expect(parsePatchRows(text)[0]?.disabled).toBe(parseNamedRows(text)[0]?.disabled)
    })
  }
})

/**
 * dsh's `applyEntryPatches` asserts a block's `name:`: when it differs from the
 * row's resolved name the block is skipped WHOLE — none of its fields apply, so
 * none are inherited either. Verified against real dsh, which warns
 * `patch: name mismatch for "<id>" ..., skipping`.
 */
describe('a block naming a different package is skipped', () => {
  it('resolves against the name the file itself establishes', () => {
    // dsh asserts each block's `name:` against the id's CURRENT name, which comes
    // from the composed base row — not from this file alone. Measured with real
    // dsh: with base name @pkg/A this file yields {@pkg/A, disabled:true}; with
    // base name @pkg/B it yields {@pkg/B, enabled}. Modelled from the first block,
    // which is the only anchor a single patch file has.
    const text = "- id: x\n  name: '@pkg/A'\n  disabled: true\n\n- id: x\n  name: '@pkg/B'\n"
    expect(effectiveRow(text, 'x')?.name).toBe('@pkg/A')
    expect(effectiveRow(text, 'x')?.disabled).toBe(true)
  })

  it('keeps the earlier name when the later block omits it', () => {
    const text = "- id: x\n  name: '@pkg/A'\n  disabled: true\n\n- id: x\n"
    expect(effectiveRow(text, 'x')?.disabled).toBe(true)
    expect(effectiveRow(text, 'x')?.name).toBe('@pkg/A')
  })

  it('applies a same-named block normally', () => {
    const text = "- id: x\n  name: '@pkg/A'\n  disabled: true\n\n- id: x\n  name: '@pkg/A'\n  disabled: false\n"
    expect(effectiveRow(text, 'x')?.disabled).toBe(false)
  })
})

/**
 * Every reader resolves the LAST block for an id, because that is what dsh
 * composes. Reading the first reported superseded values.
 */
describe('every helper targets the effective block', () => {
  const TWO = '- id: x\n  name: p\n  config:\n    serverName: OLD\n\n- id: x\n  name: p\n  config:\n    serverName: NEW\n'

  it('extractKeyValue reads the last block', () => {
    expect(extractKeyValue(TWO, 'x', 'config')?.trim()).toBe('serverName: NEW')
  })

  it('setRowConfig writes into the last block', () => {
    const out = setRowConfig(TWO, 'x', 'serverName: THIRD')
    expect(extractKeyValue(out, 'x', 'config')?.trim()).toBe('serverName: THIRD')
  })

  it('removeRow drops EVERY block for the id, so nothing stale is left', () => {
    const out = removeRow(TWO, 'x')
    expect(effectiveRow(out, 'x')).toBeUndefined()
    expect(out).not.toContain('serverName: OLD')
    expect(out).not.toContain('serverName: NEW')
  })

  it('removeRow yields the empty-array marker rather than an empty document', () => {
    expect(removeRow('- id: x\n  name: p\n', 'x')).toBe('[]\n')
  })

  it('extractRowBlock returns the last block', () => {
    expect(extractRowBlock(TWO, 'x')).toContain('serverName: NEW')
  })
})