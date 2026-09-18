/**
 * End-to-end verification of the new MCP / Skill features against the REAL app
 * bundle, in a real Electron main process.
 *
 * It boots `out/main/index.js` (the actual built entry, so the real IPC
 * registrations run), then drives the same channels the renderer uses and
 * asserts on the results:
 *
 *   mcp:scan         → the MCP rows on this machine
 *   skill:scan       → skill roots + shadowing
 *   skill:read       → one skill body
 *   mcp:setDisabled  → disable then re-enable, asserting the patch file changes
 *                      and is restored byte-for-byte
 *
 * A window is never shown; the process exits with 0 only if every check passes.
 *
 * Run: electron scripts/e2e-extensions.cjs
 */
const { app, ipcMain, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync, existsSync } = require('node:fs')
const { join } = require('node:path')

const failures = []
function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`)
  if (!ok) failures.push(name)
}

/** Call a registered ipcMain handler the way the renderer would. */
async function invoke(channel, ...args) {
  const handlers = ipcMain._invokeHandlers
  const fn = handlers?.get(channel)
  if (fn === undefined) throw new Error(`no handler for ${channel}`)
  const event = { sender: { send() {} } }
  return await fn(event, ...args)
}

app.whenReady().then(async () => {
  try {
    // Boot the real main bundle — registers every IPC handler, opens the DB.
    require(join(__dirname, '..', 'out', 'main', 'index.js'))
    await new Promise(r => setTimeout(r, 2500))
    for (const w of BrowserWindow.getAllWindows()) w.hide()

    // ── mcp:scan ───────────────────────────────────────────────────────────
    const mcp = await invoke('mcp:scan')
    check('mcp:scan ok', mcp.ok === true, mcp.ok ? '' : JSON.stringify(mcp))
    if (mcp.ok) {
      const rows = mcp.value.rows
      console.log(`      MCP rows: ${rows.length}`)
      for (const r of rows) {
        console.log(`        - ${r.id} | ${r.serverName} | ${r.layer}${r.profile ? '/' + r.profile : ''} | ${r.transport ?? '-'} | disabled=${r.disabled}${r.shadowedBy ? ' | SHADOWED by ' + r.shadowedBy.layer + '/' + r.shadowedBy.id : ''}`)
      }
      check('mcp:scan found rows', rows.length > 0)
      check('mcp rows carry a serverName', rows.every(r => typeof r.serverName === 'string' && r.serverName !== ''))
      check('mcp rows carry a layer', rows.every(r => r.layer === 'profile' || r.layer === 'home'))
      check('mcp rows carry a file path', rows.every(r => typeof r.file === 'string' && r.file.endsWith('cordis.patch.yml')))
      check('mcp scan reports the home path', typeof mcp.value.homePath === 'string' && mcp.value.homePath.endsWith('cordis.patch.yml'))
      check('mcp scan reports the profiles with a patch file', Array.isArray(mcp.value.profiles))
      check('mcp scan reports the active dsh', mcp.value.dsh !== undefined && typeof mcp.value.dsh?.name === 'string')
    }

    // ── mcp:openPatchFile must refuse a layer it was not told about ────────
    const badOpen = await invoke('mcp:openPatchFile', 'nope', undefined)
    check('mcp:openPatchFile refuses an unknown layer', badOpen.ok === false)

    // ── skill:scan ─────────────────────────────────────────────────────────
    const skill = await invoke('skill:scan')
    check('skill:scan ok', skill.ok === true, skill.ok ? '' : JSON.stringify(skill))
    if (skill.ok) {
      console.log(`      skill rows: ${skill.value.rows.length}, shadowed: ${skill.value.shadowedCount}`)
      for (const root of skill.value.roots) {
        console.log(`        root ${root.source} rank=${root.rank} exists=${root.exists} count=${root.count}`)
      }
      check('skill:scan found skills', skill.value.rows.length > 0)
      check('skill rows carry a rank', skill.value.rows.every(r => typeof r.rank === 'number'))
      check('skill rows carry a source', skill.value.rows.every(r => typeof r.source === 'string'))
    }

    // ── skill:read ─────────────────────────────────────────────────────────
    if (skill.ok && skill.value.rows.length > 0) {
      const first = skill.value.rows[0]
      const body = await invoke('skill:read', first.name, first.source, first.rank)
      check('skill:read ok', body.ok === true, body.ok ? '' : JSON.stringify(body))
      if (body.ok) {
        console.log(`      read ${first.name}: ${body.value.content.length} chars from ${body.value.file}`)
        check('skill:read returned content', body.value.content.length > 0)
      }
      const bogus = await invoke('skill:read', 'definitely-not-a-skill-xyz', first.source, first.rank)
      check('skill:read refuses an unknown name', bogus.ok === false)
    }

    // ── mcp:setDisabled round-trip (change, then restore byte-for-byte) ────
    if (mcp.ok && mcp.value.rows.length > 0) {
      const row = mcp.value.rows[0]
      const before = readFileSync(row.file, 'utf8')
      const target = { layer: row.layer, ...(row.profile !== undefined ? { profile: row.profile } : {}), id: row.id }

      const off = await invoke('mcp:setDisabled', target, !row.disabled)
      check('mcp:setDisabled toggled', off.ok === true, off.ok ? '' : JSON.stringify(off))
      const afterOff = readFileSync(row.file, 'utf8')
      check('patch file changed on toggle', afterOff !== before)

      const rescan = await invoke('mcp:scan')
      const after = rescan.ok ? rescan.value.rows.find(r => r.id === row.id && r.layer === row.layer) : undefined
      check('rescan reflects the new state', after !== undefined && after.disabled === !row.disabled,
        `expected disabled=${!row.disabled}, got ${after ? after.disabled : 'missing'}`)

      const on = await invoke('mcp:setDisabled', target, row.disabled)
      check('mcp:setDisabled restored', on.ok === true)
      const restored = readFileSync(row.file, 'utf8')
      check('patch file restored byte-for-byte', restored === before,
        restored === before ? '' : 'FILE DIFFERS — inspect ' + row.file)
      if (restored !== before) writeFileSync(row.file + '.e2e-backup', before)
    }

    const badLayer = await invoke('mcp:setDisabled', { layer: 'nope', id: 'x' }, true)
    check('mcp:setDisabled refuses an unknown layer', badLayer.ok === false)

    // An id that names no existing row must be REFUSED, not appended: the
    // underlying setRowDisabled creates a fresh block for an unknown id, which
    // would inject a junk row into the user's config.
    if (mcp.ok && mcp.value.rows.length > 0) {
      const row = mcp.value.rows[0]
      const target = { layer: row.layer, ...(row.profile !== undefined ? { profile: row.profile } : {}), id: 'e2e-nonexistent-row' }
      const before = readFileSync(row.file, 'utf8')
      const badId = await invoke('mcp:setDisabled', target, true)
      check('mcp:setDisabled refuses an unknown row', badId.ok === false)
      check('no junk row was appended', readFileSync(row.file, 'utf8') === before)
    }

    // ── mcp:parseClaude previews WITHOUT writing anything ──────────────────
    const homePath = mcp.ok ? mcp.value.homePath : ''
    const homeBefore = homePath !== '' && existsSync(homePath) ? readFileSync(homePath, 'utf8') : null
    const parsed = await invoke('mcp:parseClaude', JSON.stringify({
      mcpServers: {
        'e2e-probe': { command: 'node', args: ['--version'], env: { K: 'v' } },
        'e2e-remote': { url: 'http://127.0.0.1:1/mcp' },
        'e2e-broken': { nothing: true },
      },
    }), 'home')
    check('mcp:parseClaude ok', parsed.ok === true, parsed.ok ? '' : JSON.stringify(parsed))
    if (parsed.ok) {
      check('mcp:parseClaude converted 2 servers', parsed.value.servers.length === 2, `got ${parsed.value.servers.length}`)
      check('mcp:parseClaude reported the 1 skipped entry', parsed.value.skipped.length === 1, `got ${parsed.value.skipped.length}`)
      console.log(`      skipped: ${JSON.stringify(parsed.value.skipped)}`)
    }
    const homeAfter = homePath !== '' && existsSync(homePath) ? readFileSync(homePath, 'utf8') : null
    check('mcp:parseClaude wrote nothing', homeBefore === homeAfter)

    // ── mcp:add validates its input ────────────────────────────────────────
    const badAdd = await invoke('mcp:add', { layer: 'home', serverName: '', transport: 'stdio' })
    check('mcp:add refuses an empty name', badAdd.ok === false)
    const badAdd2 = await invoke('mcp:add', { layer: 'nope', serverName: 'x', transport: 'stdio' })
    check('mcp:add refuses an unknown layer', badAdd2.ok === false)
    const badAdd3 = await invoke('mcp:add', { layer: 'profile', serverName: 'x', transport: 'stdio' })
    check('mcp:add refuses a profile layer with no profile', badAdd3.ok === false)
  } catch (error) {
    console.error('E2E ERROR', error)
    failures.push('exception')
  } finally {
    console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : 'FAILURES: ' + failures.join(', ')}`)
    app.exit(failures.length === 0 ? 0 : 1)
  }
})
