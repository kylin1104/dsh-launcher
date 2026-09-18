/** Tests for the global instruction file (`$DSH_HOME/AGENTS.md`).
 *
 * The interesting behaviour is what the module REFUSES: dsh ignores an oversized
 * file entirely, and an empty one contributes nothing — so a bad save is a silent
 * loss of instructions, which is exactly the failure this must prevent.
 *
 * The active dsh home comes from settings, so a temp home + temp db isolate this
 * from the real machine (the same pattern skill.test.ts uses). */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, saveSettings } from './settings.ts'
import { describeRuleFile, readRuleFile, ruleFilePath, writeRuleFile } from './rule.ts'
import type { DshEntry } from '../../shared/types.ts'

let root: string
let home: string

const ENTRY: DshEntry = {
  id: 'dsh-a', name: 'dsh@a', execPath: join('C:', 'x', 'dsh.cmd'), version: '1.0.0',
  home: '', managed: true,
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pm-rule-'))
  home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  await openDatabase(join(root, 'app.sqlite'))
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

// The active dsh MUST be set before anything resolves a path. `ruleFilePath()`
// throws without one, but `beforeEach` deletes files — so registering the temp
// home first is what keeps this test away from the real machine. (An earlier
// version of this file deleted first and wiped a real AGENTS.md, because the
// unresolved path falls back through `$DSH_HOME`.)
beforeEach(() => {
  saveSettings({ dshes: [{ ...ENTRY, home }], activeDshId: 'dsh-a' })
  expect(ruleFilePath()).toBe(join(home, 'AGENTS.md'))
  if (existsSync(ruleFilePath())) rmSync(ruleFilePath())
  if (existsSync(`${ruleFilePath()}.bak`)) rmSync(`${ruleFilePath()}.bak`)
})

describe('no active dsh', () => {
  it('refuses to resolve a path rather than falling back to a real home', () => {
    saveSettings({ dshes: [], activeDshId: undefined })
    expect(() => ruleFilePath()).toThrow(/no active dsh/)
    expect(() => describeRuleFile()).toThrow(/no active dsh/)
    expect(() => readRuleFile()).toThrow(/no active dsh/)
    expect(() => writeRuleFile('# x\n')).toThrow(/no active dsh/)
    // Restore for the suites below.
    saveSettings({ dshes: [{ ...ENTRY, home }], activeDshId: 'dsh-a' })
  })
})

describe('describeRuleFile', () => {
  it('reports a missing file with the path dsh would read', () => {
    const info = describeRuleFile()
    expect(info.path).toBe(join(home, 'AGENTS.md'))
    expect(info.exists).toBe(false)
    expect(info.bytes).toBeUndefined()
  })

  it('reports size and mtime once the file exists', () => {
    writeFileSync(ruleFilePath(), '# rules\n', 'utf8')
    const info = describeRuleFile()
    expect(info.exists).toBe(true)
    expect(info.bytes).toBe(Buffer.byteLength('# rules\n'))
    expect(info.modified).toBeDefined()
  })

  it('exposes the caps the UI needs to warn about', () => {
    const info = describeRuleFile()
    expect(info.sourceLimit).toBe(1_048_576)
    expect(info.budget).toBe(65_536)
  })
})

describe('readRuleFile', () => {
  it('returns undefined when the file is absent', () => {
    expect(readRuleFile()).toBeUndefined()
  })

  it('returns the text verbatim, multi-byte characters included', () => {
    writeFileSync(ruleFilePath(), '# 规则\n\n内容\n', 'utf8')
    expect(readRuleFile()).toBe('# 规则\n\n内容\n')
  })
})

describe('writeRuleFile', () => {
  it('creates the file and reports it back', () => {
    const info = writeRuleFile('# hello\n')
    expect(info.exists).toBe(true)
    expect(info.bytes).toBe(Buffer.byteLength('# hello\n'))
    expect(readFileSync(ruleFilePath(), 'utf8')).toBe('# hello\n')
  })

  it('overwrites existing content', () => {
    writeRuleFile('first\n')
    writeRuleFile('second\n')
    expect(readRuleFile()).toBe('second\n')
  })

  it('keeps the previous content as a .bak', () => {
    writeRuleFile('original\n')
    writeRuleFile('replacement\n')
    expect(readFileSync(`${ruleFilePath()}.bak`, 'utf8')).toBe('original\n')
  })

  it('refuses an empty save that would wipe an existing file', () => {
    writeRuleFile('# keep me\n')
    // A coded error so the toast is the translated message, not raw English.
    expect(() => writeRuleFile('   \n')).toThrow(expect.objectContaining({ code: 'rule.empty' }))
    expect(readRuleFile()).toBe('# keep me\n')
  })

  it('allows an empty save when there is no file to destroy', () => {
    expect(() => writeRuleFile('')).not.toThrow()
  })

  it('refuses content over the per-file cap dsh enforces', () => {
    // dsh ignores an oversized file ENTIRELY, so accepting it would look like the
    // save worked while the model silently stopped receiving the rules.
    expect(() => writeRuleFile('x'.repeat(1_048_577)))
      .toThrow(expect.objectContaining({ code: 'rule.tooLarge' }))
    expect(existsSync(ruleFilePath())).toBe(false)
  })

  it('accepts content exactly at the cap', () => {
    expect(() => writeRuleFile('x'.repeat(1_048_576))).not.toThrow()
  })
})
