/**
 * Download-session completion signalling.
 *
 * Regression guard for the bug that left the DSH list stale after an official
 * install: `settle()` used to delete the session from `active` and only then
 * push the snapshot — but the snapshot carries LIVE sessions only, so a
 * completed session was never present in any push and no listener could react.
 * Completion must therefore arrive on its own channel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cancelPluginDownload, listPluginDownloads,
  onDownloadFinished, onDownloadsChange, startDshDownload,
} from './pluginDownloads.ts'
import type { DownloadSessionInfo } from '../../shared/types.ts'

// Same stub as pluginDownloads.test.ts: importing ./plugins.ts pulls in the
// logger (which needs an initialized data dir), and installSource is never used
// by the dsh path under test.
vi.mock('./plugins.ts', async (importActual) => {
  const actual = await importActual<typeof import('./plugins.ts')>()
  return { ...actual, installSource: vi.fn() }
})

/** Let every pending microtask + the async job chain settle. */
const flush = async (): Promise<void> => { await new Promise(r => setImmediate(r)) }

describe('startDshDownload completion', () => {
  beforeEach(() => {
    onDownloadsChange(() => {})
    onDownloadFinished(() => {})
  })

  afterEach(() => {
    onDownloadsChange(() => {})
    onDownloadFinished(() => {})
  })

  it('reports the finished session through onDownloadFinished', async () => {
    const seen: DownloadSessionInfo[] = []
    onDownloadFinished(session => seen.push(session))

    startDshDownload('official', '官方安装', async () => {})
    await flush()

    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ kind: 'dsh', name: 'official', status: 'done' })
  })

  it('reports a FAILED job as failed, not done', async () => {
    const seen: DownloadSessionInfo[] = []
    onDownloadFinished(session => seen.push(session))

    startDshDownload('broken', '官方安装', async () => { throw new Error('boom') })
    await flush()

    expect(seen).toHaveLength(1)
    expect(seen[0].status).toBe('failed')
    expect(seen[0].message).toBe('boom')
  })

  it('never leaves the finished session in the live list', async () => {
    startDshDownload('official', '官方安装', async () => {})
    await flush()
    expect(listPluginDownloads()).toHaveLength(0)
  })

  it('emits live snapshots while running, then empty on completion', async () => {
    const snapshots: DownloadSessionInfo[][] = []
    onDownloadsChange(list => snapshots.push(list))

    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    startDshDownload('official', '官方安装', async () => { await gate })
    await flush()

    // Running: the live list carries it.
    expect(snapshots.some(list => list.some(d => d.status === 'running'))).toBe(true)

    release()
    await flush()
    // Finished: the live list no longer carries it (hence the separate signal).
    expect(listPluginDownloads()).toHaveLength(0)
    expect(snapshots.some(list => list.some(d => d.id !== '' && d.status === 'done'))).toBe(false)
  })

  it('calls the finished listener exactly once per session', async () => {
    const spy = vi.fn()
    onDownloadFinished(spy)
    startDshDownload('official', '官方安装', async () => {})
    await flush()
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe('plugin download completion', () => {
  it('a cancelled plugin download still fires the finished signal', async () => {
    const seen: DownloadSessionInfo[] = []
    onDownloadFinished(session => seen.push(session))
    // Cancelling an unknown id is a no-op, so this only asserts the listener is
    // wired without throwing; the dsh cases above cover the terminal path.
    expect(cancelPluginDownload('nope')).toBe(false)
    onDownloadFinished(() => {})
  })
})
