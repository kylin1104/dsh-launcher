/** Tests for the encoding-aware child-output decoder.
 *
 * dsh (a Node process) writes UTF-8, but Windows tools it spawns (cmd.exe,
 * `.cmd` shims, native executables) write GBK on a Chinese system. A plain
 * utf8 decode rendered the GBK bytes as mojibake. These pin the per-chunk
 * choice and the cross-chunk tail handling. */

import { describe, expect, it } from 'vitest'
import { createOutputDecoder, scanUtf8 } from './output-decode.ts'

/** GBK-encode text with the system codepage (Node has no gbk TextEncoder, so we
 * build the bytes via iconv through `Buffer` is impossible — instead use the
 * known byte sequence for the strings under test). */
const GBK_SYS_NOT_FOUND = Buffer.from([
  0xcf, 0xb5, 0xcd, 0xb3, 0xd5, 0xd2, 0xb2, 0xbb, 0xb5, 0xbd, 0xd6, 0xb8, 0xb6, 0xa8, 0xb5, 0xc4, 0xc2, 0xb7, 0xbe, 0xb6,
])
const GBK_HELLO = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]) // 你好

describe('scanUtf8', () => {
  it('accepts ASCII and multi-byte UTF-8', () => {
    expect(scanUtf8(Buffer.from('hello', 'utf8'))).toEqual({ kind: 'utf8' })
    expect(scanUtf8(Buffer.from('你好', 'utf8'))).toEqual({ kind: 'utf8' })
  })

  it('rejects GBK bytes as invalid UTF-8', () => {
    expect(scanUtf8(GBK_SYS_NOT_FOUND).kind).toBe('invalid')
    expect(scanUtf8(GBK_HELLO).kind).toBe('invalid')
  })

  it('reports a trailing unfinished multi-byte sequence as pending', () => {
    const tail = Buffer.from('你', 'utf8').subarray(0, 2) // 2 of 3 bytes
    expect(scanUtf8(tail).kind).toBe('pending')
    // A complete sequence plus an unfinished one.
    const mixed = Buffer.concat([Buffer.from('你', 'utf8'), Buffer.from('好', 'utf8').subarray(0, 1)])
    expect(scanUtf8(mixed).kind).toBe('pending')
  })
})

describe('createOutputDecoder', () => {
  it('passes UTF-8 through unchanged', () => {
    const decode = createOutputDecoder()
    expect(decode(Buffer.from('start ', 'utf8'))).toBe('start ')
    expect(decode(Buffer.from('中文输出', 'utf8'))).toBe('中文输出')
  })

  it('decodes a GBK chunk as GBK', () => {
    const decode = createOutputDecoder()
    expect(decode(GBK_SYS_NOT_FOUND)).toBe('系统找不到指定的路径')
    expect(decode(GBK_HELLO)).toBe('你好')
  })

  it('handles a UTF-8 multi-byte char split across chunks', () => {
    const decode = createOutputDecoder()
    const full = Buffer.from('你好', 'utf8')
    // First 3 bytes = '你' complete; feed the 2nd char one byte at a time.
    const out: string[] = []
    for (let i = 0; i < full.length; i++) out.push(decode(full.subarray(i, i + 1)))
    expect(out.join('')).toBe('你好')
  })

  it('recovers ASCII around a GBK burst', () => {
    const decode = createOutputDecoder()
    expect(decode(Buffer.from('before ', 'utf8'))).toBe('before ')
    expect(decode(GBK_SYS_NOT_FOUND)).toBe('系统找不到指定的路径')
    expect(decode(Buffer.from(' after', 'utf8'))).toBe(' after')
  })

  it('an empty chunk never throws', () => {
    const decode = createOutputDecoder()
    expect(decode(Buffer.alloc(0))).toBe('')
  })
})
