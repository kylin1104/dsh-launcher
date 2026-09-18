/**
 * Encoding-aware decoding of a Windows child process's output stream.
 *
 * A dsh run is a NODE process (UTF-8 output), but the tools it spawns on Windows
 * — cmd.exe, `.cmd` shims, and native executables — write in the system ANSI
 * codepage (GBK on a Chinese system). Mixing the two means a plain
 * `data.toString('utf8')` renders the GBK bytes as mojibake
 * (`ϵͳ�Ҳ���ָ����·����` = "系统找不到指定的路径").
 *
 * This decoder is stateful across chunks: a UTF-8 multi-byte character may be
 * split at a chunk boundary, so the tail of a chunk that looks like an
 * unfinished UTF-8 sequence is held back until the next chunk. A chunk that is
 * valid UTF-8 decodes as UTF-8; one that is not (GBK) decodes as GBK.
 *
 * Both decoders are built in (Node's `TextDecoder` supports `gbk`), so no
 * dependency is added.
 */

import { TextDecoder } from 'node:util'

const utf8Decoder = new TextDecoder('utf-8')
const gbkDecoder = new TextDecoder('gbk')

/** Expected UTF-8 sequence length for a lead byte; 0 when the byte cannot start
 * a UTF-8 sequence (i.e. it is a GBK continuation byte or a lone 0x80–0xBF). */
function utf8SeqLen(byte: number): number {
  if (byte < 0x80) return 1
  if ((byte & 0xE0) === 0xC0) return 2
  if ((byte & 0xF0) === 0xE0) return 3
  if ((byte & 0xF8) === 0xF0) return 4
  return 0
}

/** Outcome of scanning a buffer for UTF-8 validity. */
export type Utf8Scan =
  | { kind: 'utf8' }
  /** The whole buffer is valid UTF-8, except `pending` trailing bytes that begin
   * a multi-byte sequence and need the next chunk to complete. */
  | { kind: 'pending'; pending: number }
  /** A byte that can never appear in valid UTF-8 (GBK content). */
  | { kind: 'invalid' }

/** Scan `buf` for UTF-8 validity, reporting how many trailing bytes are an
 * unfinished multi-byte sequence (to be completed by the next chunk). */
export function scanUtf8(buf: Buffer): Utf8Scan {
  let i = 0
  while (i < buf.length) {
    const len = utf8SeqLen(buf[i])
    if (len === 0) return { kind: 'invalid' }
    if (i + len > buf.length) return { kind: 'pending', pending: buf.length - i }
    for (let j = 1; j < len; j++) {
      if ((buf[i + j] & 0xC0) !== 0x80) return { kind: 'invalid' }
    }
    i += len
  }
  return { kind: 'utf8' }
}

/**
 * A stateful decoder that converts raw child-process bytes into text, choosing
 * UTF-8 or GBK per chunk and carrying an unfinished UTF-8 tail across chunks.
 *
 * Use one instance per output stream (stdout / stderr), created at spawn time.
 */
export function createOutputDecoder(): (chunk: Buffer) => string {
  let pending = Buffer.alloc(0)
  return (chunk: Buffer): string => {
    const buf = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk
    const scan = scanUtf8(buf)
    if (scan.kind === 'utf8') {
      pending = Buffer.alloc(0)
      return utf8Decoder.decode(buf)
    }
    if (scan.kind === 'pending') {
      // Hold the unfinished tail for the next chunk; decode what is complete.
      const head = buf.subarray(0, buf.length - scan.pending)
      pending = Buffer.from(buf.subarray(buf.length - scan.pending))
      return scanUtf8(head).kind === 'utf8'
        ? utf8Decoder.decode(head)
        : gbkDecoder.decode(head)
    }
    // Deterministically non-UTF-8: the GBK fallback.
    pending = Buffer.alloc(0)
    return gbkDecoder.decode(buf)
  }
}
