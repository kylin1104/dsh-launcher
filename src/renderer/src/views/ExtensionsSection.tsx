/** The "MCP / Skill" tab: a two-pane shell whose left rail switches between the
 * two views and reports what the panes are scoped to.
 *
 * The rail SWITCHES the active DSH and REPORTS the current profile. "Current
 * profile" is a persisted app setting whose entry points live on the DSH and
 * Profile pages, so the rail only displays it; which profile's config the pane
 * browses is the pane's own 查看范围 control.
 *
 * MCP rows are toggleable (the row's own layer is the write target); Skill is a
 * read-only browser because dsh exposes no skill enable/disable switch. */

import { useCallback, useEffect, useState } from 'react'
import { Select, Tag, theme, message } from 'antd'
import { ApiOutlined, ThunderboltOutlined, RobotOutlined, ProfileOutlined, FileTextOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import AppShell from '../components/AppShell.tsx'
import NavList from '../components/NavList.tsx'
import McpSection from './McpSection.tsx'
import SkillSection from './SkillSection.tsx'
import RuleSection from './RuleSection.tsx'
import { apiErrorText } from '../lib/ipc.ts'
import type { DshEntry, McpScanResult } from '../../../shared/types.ts'

type ExtView = 'mcp' | 'skill' | 'rule'

/** One labelled row in the rail. Default layout puts the caption above the
 * control (right for a full-width dropdown); `inline` puts caption and value on
 * ONE line, which is what a short read-only value wants. */
function PickerRow({ icon, label, children, inline }: {
  icon: JSX.Element
  label: string
  children: React.ReactNode
  inline?: boolean
}): JSX.Element {
  const { token } = theme.useToken()
  const caption = (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {icon}
      <span>{label}</span>
    </span>
  )
  if (inline === true) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, marginBottom: 10,
        fontSize: token.fontSizeSM, color: token.colorTextTertiary,
      }}>
        <span style={{ flexShrink: 0, display: 'inline-flex' }}>{caption}</span>
        {children}
      </div>
    )
  }
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4,
        fontSize: token.fontSizeSM, color: token.colorTextTertiary,
      }}>
        {caption}
      </div>
      {children}
    </div>
  )
}

export default function ExtensionsSection() {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [view, setView] = useState<ExtView>('mcp')
  const [scan, setScan] = useState<McpScanResult | null>(null)
  // Which profile's rows the MCP pane lists. `'effective'` is the composition
  // dsh actually loads (home + the CURRENT profile); `'all'` is the home layer
  // alone; anything else is that one profile's own file.
  const [profile, setProfile] = useState<string>('effective')
  const [dshes, setDshes] = useState<DshEntry[]>([])
  const [activeDshId, setActiveDshId] = useState<string>()

  const onScan = useCallback((next: McpScanResult) => { setScan(next) }, [])

  /** Read the dsh roster + the persisted current profile. */
  const loadScope = useCallback(async (): Promise<void> => {
    const r = await window.api.dsh.list()
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    setDshes(r.value.dshes)
    setActiveDshId(r.value.activeDshId)
  }, [])

  useEffect(() => { void loadScope() }, [loadScope])

  // Drop a stale selection when the active dsh changes (its profiles differ).
  useEffect(() => {
    if (profile !== 'all' && profile !== 'effective' && scan !== null && !scan.profiles.includes(profile)) {
      setProfile('effective')
    }
  }, [scan, profile])

  const switchDsh = async (id: string): Promise<void> => {
    if (id === activeDshId) return
    const r = await window.api.dsh.setActive(id)
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    setActiveDshId(id)
    // The whole pane belongs to the other dsh now; reset to the effective view
    // and let the scan report the new roster.
    setProfile('effective')
    setScan(null)
    await loadScope()
  }

  const profiles = scan?.profiles ?? []
  const activeProfileName = scan?.activeProfile

  const sider = (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '10px 12px', borderBottom: `1px solid ${token.colorSplit}` }}>
        <PickerRow icon={<RobotOutlined />} label={t('mcp.scope')}>
          <Select
            size="small"
            style={{ width: '100%' }}
            value={activeDshId}
            onChange={id => void switchDsh(String(id))}
            placeholder={t('mcp.scopeNone')}
            options={dshes.map(d => ({ value: d.id, label: d.name }))}
          />
        </PickerRow>
        {/* Read-only: "current profile" is a persisted app setting, and the
            entry points that CHANGE it live on the DSH / Profile pages. Showing
            it as a tag answers "what is current" without adding a second place
            that writes the same state — the pane's own 查看范围 control is what
            picks which profile's config to browse. */}
        <PickerRow inline icon={<ProfileOutlined />} label={t('mcp.scopeProfile')}>
          <Tag
            color={activeProfileName === undefined ? undefined : 'geekblue'}
            style={{
              marginInlineEnd: 0, minWidth: 0,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
          >
            {activeProfileName ?? t('mcp.scopeProfileNone')}
          </Tag>
        </PickerRow>
      </div>

      <div style={{ padding: 8 }}>
        <NavList<{ key: ExtView; label: string; icon: JSX.Element }>
          items={[
            { key: 'mcp', label: t('ext.view.mcp'), icon: <ApiOutlined /> },
            { key: 'skill', label: t('ext.view.skill'), icon: <ThunderboltOutlined /> },
            { key: 'rule', label: t('ext.view.rule'), icon: <FileTextOutlined /> },
          ]}
          keyOf={item => item.key}
          selectedKey={view}
          onSelect={item => setView(item.key)}
          renderTitle={item => (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              {item.icon}<span>{item.label}</span>
            </span>
          )}
        />
      </div>
    </div>
  )

  return (
    <AppShell sider={sider}>
      {/* Keyed on the active dsh: switching it REMOUNTS the pane, so the scan
          re-runs against the new dsh's layers and every piece of pane state
          (page, filter, dialog) resets with it. Without this the panes kept
          rendering the previous dsh's data — the scan only ran on mount. */}
      {view === 'mcp'
        ? (
          <McpSection
            key={activeDshId ?? 'none'}
            profiles={profiles}
            profileFilter={profile}
            onProfileFilter={setProfile}
            onScan={onScan}
          />
        )
        : view === 'skill'
          ? <SkillSection key={activeDshId ?? 'none'} />
          // The rule file is per-HOME, not per-profile, so it needs no range
          // picker — the rail's active dsh is its whole scope. Keyed for the same
          // reason as the others: switching dsh must re-read the other's file.
          : <RuleSection key={activeDshId ?? 'none'} />}
    </AppShell>
  )
}
