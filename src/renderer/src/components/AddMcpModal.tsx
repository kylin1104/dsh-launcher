/** The "add MCP server" dialog.
 *
 * Layout: a two-column grid of label-over-control fields, where each field's
 * explanation sits INLINE after its title rather than in a separate hint line,
 * and related fields are grouped by grid placement instead of by bold section
 * headings (the headings read as heavy and broke the form into slabs).
 *
 * Two ways in: fill one server in by hand, or paste another agent tool's
 * `mcpServers` config, preview the mapping, then write the batch.
 *
 * Both write to a user-chosen SCOPE, because in dsh a server is a patch row and
 * the scope decides whether every profile can call it or just one. */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert, Button, Checkbox, Input, Modal, Radio, Select, Space, Table, Tag,
  Typography, theme, message,
} from 'antd'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../lib/ipc.ts'
import { MODAL } from '../theme.ts'
import type { McpAddInput, McpImportPreview, McpLayer } from '../../../shared/types.ts'

/** Transports dsh understands. */
const TRANSPORTS = ['stdio', 'streamable-http', 'sse']

/** The scope picker's value. */
type ScopeValue = 'all' | string

interface Props {
  open: boolean
  /** Profiles available as a target scope. */
  profiles: string[]
  /** Pre-select a profile (the pane's current filter), when any. */
  defaultProfile?: string
  onClose: () => void
  /** Called after a successful write so the pane can re-scan. */
  onDone: () => void | Promise<void>
}

export default function AddMcpModal({ open, profiles, defaultProfile, onClose, onDone }: Props) {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [tab, setTab] = useState<'manual' | 'import'>('manual')
  const [scope, setScope] = useState<ScopeValue>('all')
  const [saving, setSaving] = useState(false)

  // manual form
  const [name, setName] = useState('')
  const [id, setId] = useState('')
  const [transport, setTransport] = useState('stdio')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [env, setEnv] = useState('')
  const [url, setUrl] = useState('')
  const [disabled, setDisabled] = useState(false)

  // import
  const [importText, setImportText] = useState('')
  const [preview, setPreview] = useState<McpImportPreview | null>(null)

  // Reset to a clean slate whenever the dialog opens, so a previous attempt
  // never leaks into the next one. The DSH/profile captured here is a SNAPSHOT:
  // `profiles` arrives as an array from the parent and can be a fresh `[]` on any
  // re-render while the scan has not resolved, which would re-run this effect and
  // wipe a half-filled form. Depend on the modal's `open` transition instead.
  const openedRef = useRef(false)
  useEffect(() => {
    if (!open) { openedRef.current = false; return }
    if (openedRef.current) return
    openedRef.current = true
    setTab('manual')
    setSaving(false)
    setName(''); setId(''); setTransport('stdio'); setCommand(''); setArgs(''); setEnv(''); setUrl(''); setDisabled(false)
    setImportText(''); setPreview(null)
    const hasProfile = defaultProfile !== undefined && defaultProfile !== '' && profiles.includes(defaultProfile)
    setScope(hasProfile ? defaultProfile : 'all')
  }, [open, defaultProfile, profiles])

  const target = useMemo<{ layer: McpLayer; profile?: string }>(
    () => (scope === 'all' ? { layer: 'home' } : { layer: 'profile', profile: scope }),
    [scope],
  )

  /**
   * Changing the scope after a preview must drop that preview.
   *
   * `parseClaude` stamps the target layer/profile onto every converted server, and
   * the import sends those objects verbatim — so the picker would show the new
   * scope while the servers still carried the old one, writing them somewhere the
   * user did not choose. Clearing forces a re-convert against the new target.
   */
  const changeScope = (next: string): void => {
    setScope(next)
    setPreview(null)
  }

  const parseEnv = (text: string): Record<string, string> | string => {
    const out: Record<string, string> = {}
    for (const raw of text.split('\n')) {
      const line = raw.trim()
      if (line === '') continue
      const at = line.indexOf('=')
      if (at <= 0) return line
      out[line.slice(0, at).trim()] = line.slice(at + 1).trim()
    }
    return out
  }

  const doAdd = async (): Promise<void> => {
    const serverName = name.trim()
    if (serverName === '') { void message.error(t('mcp.add.needName')); return }
    if (transport === 'stdio' && command.trim() === '') { void message.error(t('mcp.add.needCommand')); return }
    if (transport !== 'stdio' && url.trim() === '') { void message.error(t('mcp.add.needUrl')); return }
    const parsedEnv = parseEnv(env)
    if (typeof parsedEnv === 'string') { void message.error(t('mcp.add.invalidEnv', { line: parsedEnv })); return }

    const input: McpAddInput = {
      ...target,
      serverName,
      transport,
      ...(id.trim() !== '' ? { id: id.trim() } : {}),
      ...(transport === 'stdio'
        ? { command: command.trim(), args: args.split('\n').map(a => a.trim()).filter(a => a !== ''), env: parsedEnv }
        : { url: url.trim() }),
      ...(disabled ? { disabled: true } : {}),
    }
    setSaving(true)
    const r = await window.api.mcp.add(input)
    setSaving(false)
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    void message.success(t('mcp.add.done', { name: serverName }))
    onClose()
    await onDone()
  }

  const doConvert = async (): Promise<void> => {
    if (importText.trim() === '') return
    const r = await window.api.mcp.parseClaude(importText, target.layer, target.profile)
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    setPreview(r.value)
  }

  const doImport = async (): Promise<void> => {
    if (preview === null || preview.servers.length === 0) return
    setSaving(true)
    const r = await window.api.mcp.import(preview.servers)
    setSaving(false)
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    void message.success(t('mcp.add.imported', { count: r.value.length }))
    onClose()
    await onDone()
  }

  /** One form field: the title, its explanation inline right after it, then the
   * control — matching the reference plugin's label style rather than a second
   * muted hint line under the input. */
  const field = (title: string, control: JSX.Element, opts?: { full?: boolean; hint?: string }): JSX.Element => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, gridColumn: opts?.full === true ? '1 / -1' : undefined }}>
      <span style={{ fontSize: token.fontSizeSM, color: token.colorTextSecondary }}>
        {title}
        {opts?.hint !== undefined && (
          <span style={{ color: token.colorTextTertiary }}>{t('common.qualifier', { text: opts.hint })}</span>
        )}
      </span>
      {control}
    </label>
  )

  const gridStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: '10px 12px',
    border: `1px solid ${token.colorBorderSecondary}`,
    borderRadius: token.borderRadiusLG,
    padding: 12,
  }

  const scopeField = field(
    t('mcp.add.scopeLabel'),
    <Select
      value={scope}
      onChange={changeScope}
      options={[
        { value: 'all', label: t('mcp.add.scopePersonal') },
        ...profiles.map(p => ({ value: p, label: t('mcp.add.scopeProfile', { profile: p }) })),
      ]}
    />,
    { full: true, hint: t('mcp.add.scopeHint') },
  )

  const manual = (
    <div style={gridStyle}>
      {scopeField}
      {field(t('mcp.add.name'), <Input value={name} onChange={e => setName(e.target.value)} placeholder="my-server" />, { hint: t('mcp.add.nameShort') })}
      {field(t('mcp.add.id'), <Input value={id} onChange={e => setId(e.target.value)} placeholder="mcp-my-server" />, { hint: t('mcp.add.idShort') })}
      {field(
        t('mcp.add.transport'),
        /* A Select rather than a Segmented: it matches the width and height of
           every other control in the grid, so the form reads as one column of
           equal fields instead of a pill strip interrupting them. */
        <Select
          value={transport}
          onChange={setTransport}
          options={TRANSPORTS.map(x => ({ value: x, label: x }))}
        />,
      )}
      {transport === 'stdio'
        ? field(t('mcp.add.command'), <Input value={command} onChange={e => setCommand(e.target.value)} placeholder="npx -y some-mcp" />, { hint: t('mcp.add.commandShort') })
        : field(t('mcp.add.url'), <Input value={url} onChange={e => setUrl(e.target.value)} placeholder="http://127.0.0.1:1234/mcp" />, { full: true })}
      {transport === 'stdio' && field(
        t('mcp.add.args'),
        <Input.TextArea rows={3} value={args} onChange={e => setArgs(e.target.value)} placeholder={'-y\nsome-mcp@latest'} />,
        { full: true, hint: t('mcp.add.argsShort') },
      )}
      {transport === 'stdio' && field(
        t('mcp.add.env'),
        <Input.TextArea rows={3} value={env} onChange={e => setEnv(e.target.value)} placeholder={'API_KEY=xxx\nDEBUG=false'} />,
        { full: true, hint: t('mcp.add.envShort') },
      )}
      <div style={{ gridColumn: '1 / -1' }}>
        <Checkbox checked={disabled} onChange={e => setDisabled(e.target.checked)}>{t('mcp.add.disabled')}</Checkbox>
      </div>
    </div>
  )

  const importTab = (
    <Space orientation="vertical" size={10} style={{ width: '100%' }}>
      <div style={gridStyle}>{scopeField}</div>
      {field(
        t('mcp.add.tab.import'),
        <Input.TextArea
          rows={9}
          value={importText}
          onChange={e => { setImportText(e.target.value); setPreview(null) }}
          placeholder={t('mcp.add.importPlaceholder')}
          style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: token.fontSizeSM }}
        />,
        { full: true },
      )}
      <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
        {t('mcp.add.importHint')}
      </Typography.Text>
      <Button onClick={() => void doConvert()} disabled={importText.trim() === ''}>{t('mcp.add.convert')}</Button>

      {preview?.error !== undefined && <Alert type="error" showIcon title={preview.error} />}
      {preview !== null && preview.error === undefined && (
        <>
          <Alert
            type={preview.servers.length > 0 ? 'success' : 'warning'}
            showIcon
            title={t('mcp.add.previewTitle', { count: preview.servers.length })}
          />
          {preview.skipped.length > 0 && (
            <Alert
              type="warning"
              showIcon
              title={t('mcp.add.previewSkipped', { count: preview.skipped.length })}
              description={(
                <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                  {preview.skipped.map(s => <li key={s.name}><code>{s.name}</code> — {s.reason}</li>)}
                </ul>
              )}
            />
          )}
          {preview.servers.length > 0 && (
            <Table<McpAddInput>
              size="small"
              rowKey="serverName"
              pagination={false}
              dataSource={preview.servers}
              columns={[
                { title: t('mcp.colServer'), dataIndex: 'serverName', render: (v: string) => <span style={{ fontWeight: 500 }}>{v}</span> },
                { title: t('mcp.colTransport'), dataIndex: 'transport', width: 150, render: (v: string) => <Tag>{v}</Tag> },
                {
                  title: t('mcp.colTarget'),
                  key: 'target',
                  render: (_: unknown, r: McpAddInput) => (
                    <span style={{ fontFamily: 'monospace', fontSize: token.fontSizeSM }}>
                      {r.url ?? [r.command, ...(r.args ?? [])].join(' ')}
                    </span>
                  ),
                },
              ]}
            />
          )}
        </>
      )}
    </Space>
  )

  const footer = tab === 'manual'
    ? (
      <Space>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button type="primary" loading={saving} onClick={() => void doAdd()}>{t('common.confirm')}</Button>
      </Space>
    )
    : (
      <Space>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button
          type="primary"
          loading={saving}
          disabled={preview === null || preview.servers.length === 0}
          onClick={() => void doImport()}
        >
          {t('mcp.add.confirmImport', { count: preview?.servers.length ?? 0 })}
        </Button>
      </Space>
    )

  return (
    <Modal
      title={t('mcp.add.title')}
      open={open}
      onCancel={onClose}
      footer={footer}
      width={MODAL.wide}
      destroyOnHidden
      styles={{ body: { maxHeight: '65vh', overflowY: 'auto', paddingTop: 8 } }}
    >
      <Radio.Group
        value={tab}
        onChange={e => setTab(e.target.value as 'manual' | 'import')}
        optionType="button"
        buttonStyle="solid"
        block
        style={{ marginBottom: 12 }}
        options={[
          { label: t('mcp.add.tab.manual'), value: 'manual' },
          { label: t('mcp.add.tab.import'), value: 'import' },
        ]}
      />
      {tab === 'manual' ? manual : importTab}
    </Modal>
  )
}
