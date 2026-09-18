/** MCP server management. Lists every `@deepseek-ai/dsh-mcp-client` row across
 * the layers the Launcher owns (profile + home) and toggles one in place.
 *
 * There is no standalone MCP config file in dsh — a server IS a patch row — so
 * the row is the unit of management, and the layer the row came from is where
 * its enabled state is written.
 *
 * The server name and the patch row id are shown together in one cell: the name
 * is what you recognise, the id is the key the composition order
 * (`bundle → profile → home`) overrides by, so they answer the same question and
 * belong side by side rather than in two competing columns. */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Button, Radio, Space, Switch, Table, Tag, Tooltip, message, theme } from 'antd'
import { FolderOpenOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { apiErrorText } from '../lib/ipc.ts'
import Panel from '../components/Panel.tsx'
import SectionHeading from '../components/SectionHeading.tsx'
import AddMcpModal from '../components/AddMcpModal.tsx'
import type { McpScanResult, McpServerRow } from '../../../shared/types.ts'

/** Layer tags: the shared layer outranks a profile's own, so it reads stronger. */
const LAYER_COLOR: Record<string, string> = { home: 'gold', profile: 'blue' }

/** Render a row's target: the command for stdio, the URL for http. */
function targetOf(row: McpServerRow): string {
  if (row.url !== undefined && row.url !== '') return row.url
  if (row.command !== undefined && row.command !== '') {
    return [row.command, ...row.args].join(' ')
  }
  return '-'
}

/** Human label for a layer, e.g. "Profile 层 · web". */
/** Human label for a scope, e.g. "仅 web". The profile name is interpolated
 * INTO the translated string — appending it after a bare `t(...)` call left the
 * `{{profile}}` placeholder in the output. */
function layerLabel(layer: McpServerRow['layer'], profile: string | undefined, t: TFunction): string {
  return layer === 'home' ? t('mcp.layer.home') : t('mcp.layer.profile', { profile: profile ?? '' })
}

interface Props {
  /** Profiles that have a patch file, for the range picker. */
  profiles: string[]
  /** `'all'` or a profile name. */
  profileFilter: string
  onProfileFilter: (next: string) => void
  onScan: (result: McpScanResult) => void
}

export default function McpSection({ profiles, profileFilter, onProfileFilter, onScan }: Props) {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [data, setData] = useState<McpScanResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busyKey, setBusyKey] = useState('')
  const [addOpen, setAddOpen] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    const r = await window.api.mcp.scan()
    setLoading(false)
    if (!r.ok) { setError(apiErrorText(r)); return }
    setError('')
    setData(r.value)
    onScan(r.value)
  }, [onScan])

  useEffect(() => { void load() }, [load])

  const toggle = async (row: McpServerRow, disabled: boolean): Promise<void> => {
    const key = `${row.layer}:${row.profile ?? ''}:${row.id}`
    setBusyKey(key)
    const r = await window.api.mcp.setDisabled(
      { layer: row.layer, ...(row.profile !== undefined ? { profile: row.profile } : {}), id: row.id },
      disabled,
    )
    setBusyKey('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    void message.success(t('mcp.toggled', {
      state: disabled ? t('mcp.disabledState') : t('mcp.enabledState'),
      name: row.serverName,
    }))
    await load()
  }

  const createHomePatch = async (): Promise<void> => {
    const r = await window.api.mcp.ensureHomePatch()
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    void message.success(t('mcp.homeCreated'))
    await load()
  }

  const openFile = async (layer: 'home' | 'profile', profile?: string): Promise<void> => {
    const r = await window.api.mcp.openPatchFile(layer, profile)
    if (!r.ok) void message.error(apiErrorText(r))
  }

  /** The profile dsh actually loads right now (absent when none is selected or
   * the persisted one no longer exists). */
  const activeProfile = data?.activeProfile

  /**
   * The range picker selects ONE FILE, not a union: dsh keeps a separate patch
   * file per profile plus the shared home file, and "共用" showing every layer's
   * rows while its own file is empty was self-contradictory (the list looked
   * populated, the file it opens was blank).
   *
   * `effective` is the deliberate exception: it is the COMPOSITION dsh actually
   * loads — home plus the CURRENT profile, home winning ties — which is the one
   * question the per-file views cannot answer (you would read two files and dedupe
   * in your head). A row shadowed by the home layer is still LISTED (marked
   * 未生效) rather than hidden, because "I configured it and it does nothing" has
   * to stay visible.
   */
  const rows = useMemo(() => {
    const all = data?.rows ?? []
    if (profileFilter === 'effective') {
      return all.filter(r => r.layer === 'home'
        || (r.layer === 'profile' && r.profile === activeProfile))
    }
    if (profileFilter === 'all') return all.filter(r => r.layer === 'home')
    return all.filter(r => r.layer === 'profile' && r.profile === profileFilter)
  }, [data, profileFilter, activeProfile])

  const homeMissing = data?.homeMissing ?? false
  const provisional = data?.homePathProvisional ?? false
  const hasDsh = data?.dsh !== null && data?.dsh !== undefined

  /** The file "open config" targets: exactly the file the range is showing, so
   * switching the profile opens that profile's own file. */
  const scope: { layer: 'home' | 'profile'; profile?: string } = useMemo(
    () => (profileFilter === 'all' ? { layer: 'home' } : { layer: 'profile', profile: profileFilter }),
    [profileFilter],
  )

  // `effective` spans TWO files, so it has no single target for "open config" —
  // each row's own layer tag is how you reach a file from here.
  const isEffective = profileFilter === 'effective'

  const scopeLabel = isEffective
    ? t('mcp.range.effective')
    : scope.layer === 'home'
      ? t('mcp.layer.home')
      : layerLabel('profile', scope.profile, t)

  const columns = [
    {
      title: t('mcp.colServer'),
      key: 'server',
      render: (_: unknown, r: McpServerRow) => (
        <Space orientation="vertical" size={0}>
          <Space size={6}>
            <span style={{ fontWeight: 500 }}>{r.serverName}</span>
            {r.shadowedBy !== undefined && (
              <Tooltip title={t('mcp.shadowedTip', {
                name: r.serverName,
                layer: layerLabel(r.shadowedBy.layer, r.shadowedBy.profile, t),
              })}>
                <Tag color="red">{t('mcp.shadowed')}</Tag>
              </Tooltip>
            )}
            {/* A later block in the SAME file carries this id, so dsh resolves that
                one and this block's own switch is not the live state. Surfaces an
                appended override written by any external tool. */}
            {r.overriddenByLater === true && (
              <Tooltip title={t('mcp.overriddenTip')}>
                <Tag color="orange">{t('mcp.overridden')}</Tag>
              </Tooltip>
            )}
          </Space>
          {/* The row id decides which layer wins for a duplicate name. */}
          <Tooltip title={`${t('mcp.colIdHint')}: ${r.id}`}>
            <span style={{
              fontFamily: 'monospace', fontSize: token.fontSizeSM, color: token.colorTextTertiary,
              display: 'inline-block', maxWidth: 320, overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {r.id}
            </span>
          </Tooltip>
        </Space>
      ),
    },
    {
      title: t('mcp.colTransport'),
      dataIndex: 'transport',
      key: 'transport',
      width: 130,
      render: (v: string | undefined) => v !== undefined && v !== '' ? <Tag>{v}</Tag> : <span style={{ color: token.colorTextTertiary }}>-</span>,
    },
    {
      title: t('mcp.colTarget'),
      key: 'target',
      render: (_: unknown, r: McpServerRow) => (
        <Tooltip title={targetOf(r)}>
          <span style={{
            fontFamily: 'monospace', fontSize: token.fontSizeSM,
            display: 'inline-block', maxWidth: 340, overflow: 'hidden',
            textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom',
          }}>
            {targetOf(r)}
          </span>
        </Tooltip>
      ),
    },
    {
      title: t('mcp.colLayer'),
      key: 'layer',
      width: 180,
      render: (_: unknown, r: McpServerRow) => (
        <Tooltip title={r.layer === 'home' ? t('mcp.layer.homeHint') : t('mcp.layer.profileHint', { profile: r.profile ?? '' })}>
          <Tag color={LAYER_COLOR[r.layer]} style={{ cursor: 'pointer' }}
            onClick={() => void openFile(r.layer, r.profile)}>
            {layerLabel(r.layer, r.profile, t)}
          </Tag>
        </Tooltip>
      ),
    },
    {
      title: t('mcp.colState'),
      key: 'state',
      // Fixed width so the switch's presence never re-flows the other columns.
      width: 130,
      render: (_: unknown, r: McpServerRow) => {
        const key = `${r.layer}:${r.profile ?? ''}:${r.id}`
        // A shadowed row never takes effect: the DSH level wins, so toggling this
        // row cannot change what dsh runs. Offering a switch here would report a
        // change that never happens — the "no control that silently does nothing"
        // rule — so the cell states the reason instead of the control.
        if (r.shadowedBy !== undefined) {
          return (
            <Tooltip title={t('mcp.shadowedTip', {
              name: r.serverName,
              layer: layerLabel(r.shadowedBy.layer, r.shadowedBy.profile, t),
            })}>
              <span style={{ color: token.colorTextTertiary, fontSize: token.fontSizeSM }}>
                {t('mcp.inert')}
              </span>
            </Tooltip>
          )
        }
        return (
          <Switch
            size="small"
            checked={!r.disabled}
            // Any write in flight locks EVERY switch: `setMcpServerDisabled` is
            // read-modify-write, so two toggles against the same file would race
            // and the later write would silently drop the earlier one.
            disabled={busyKey !== ''}
            loading={busyKey === key}
            checkedChildren={t('mcp.enabled')}
            unCheckedChildren={t('mcp.disabled')}
            onChange={checked => { void toggle(r, !checked) }}
          />
        )
      },
    },
  ]

  return (
    <div style={{ padding: token.padding }}>
      <SectionHeading
        title={t('mcp.title')}
        description={t('mcp.desc')}
        extra={(
          <Space>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setAddOpen(true)}>{t('mcp.add')}</Button>
            {/* One file per range, so there is a single target — except the
                EFFECTIVE range, which spans the home file and the current
                profile's file. Disabled there instead of guessing one. */}
            <Tooltip title={isEffective ? t('mcp.openFileEffective') : t('mcp.openFileFor', { scope: scopeLabel })}>
              <Button
                icon={<FolderOpenOutlined />}
                disabled={isEffective || (scope.layer === 'home' && !hasDsh)}
                onClick={() => void openFile(scope.layer, scope.profile)}
              >
                {t('mcp.openFile')}
              </Button>
            </Tooltip>
            <span style={{ color: token.colorTextSecondary }}>{t('mcp.count', { count: rows.length })}</span>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>{t('ext.refresh')}</Button>
          </Space>
        )}
      />

      <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
        {/* The range picker lives beside the list it filters, not in the rail.
            It is a pure VIEW filter: it picks what to look at and never writes
            the app's "current profile" setting. 「生效」 composes the home layer
            with the CURRENT profile (that is what dsh loads); every other choice
            shows exactly one file. */}
        <Space size="middle" wrap>
          <span style={{ color: token.colorTextSecondary }}>{t('mcp.rangeLabel')}</span>
          <Radio.Group
            value={profileFilter}
            onChange={e => onProfileFilter(String(e.target.value))}
            optionType="button"
            buttonStyle="solid"
            options={[
              { label: t('mcp.range.effective'), value: 'effective' },
              { label: t('mcp.range.shared'), value: 'all' },
              ...profiles.map(name => ({ label: name, value: name })),
            ]}
          />
        </Space>

        <Alert type="info" showIcon title={isEffective ? t('mcp.effectiveHint') : t('mcp.layerOrder')} />

        {/* No active dsh → the shared-layer path is a guess, so say so instead of
            offering to create a file that will move out from under the user. */}
        {!hasDsh && <Alert type="warning" showIcon title={t('mcp.scopeNoDsh')} />}

        {homeMissing && !provisional && (
          <Alert
            type="info"
            showIcon
            title={t('mcp.homeMissingTitle')}
            description={t('mcp.homeMissingBody', { path: data?.homePath ?? '' })}
            action={(
              <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => void createHomePatch()}>
                {t('mcp.homeCreate')}
              </Button>
            )}
          />
        )}
        {error !== '' && <Alert type="error" showIcon title={error} />}

        <Panel pad={false}>
          <Table<McpServerRow>
            size="small"
            rowKey={r => `${r.layer}:${r.profile ?? ''}:${r.id}`}
            columns={columns}
            dataSource={rows}
            loading={loading}
            pagination={false}
            scroll={{ x: 'max-content' }}
            locale={{ emptyText: t('mcp.emptyIn', { scope: scopeLabel }) }}
          />
        </Panel>
      </Space>

      <AddMcpModal
        open={addOpen}
        profiles={profiles}
        defaultProfile={profileFilter === 'all' ? undefined : profileFilter}
        onClose={() => setAddOpen(false)}
        onDone={load}
      />
    </div>
  )
}
