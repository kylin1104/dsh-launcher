import { useEffect, useState } from 'react'
import {
  Button, Descriptions, Divider, Modal, Space, Tag, theme, Typography, message,
} from 'antd'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../lib/ipc.ts'
import AppShell from '../components/AppShell.tsx'
import EmptyState from '../components/EmptyState.tsx'
import NavList from '../components/NavList.tsx'
import ConfirmMenu, { type MenuAction } from '../components/ConfirmMenu.tsx'
import FieldLabel from '../components/FieldLabel.tsx'
import ConfigRow from '../components/ConfigRow.tsx'
import Panel from '../components/Panel.tsx'
import SectionHeading from '../components/SectionHeading.tsx'
import { AddDshModal, DataMirrorModal, DshRemoveModal, OfficialInstallModal, RenameDshModal, UpdateDshModal } from './DshModals.tsx'
import { majorOfVersion } from '../../../shared/version.ts'
import type { DshEntry } from '../../../shared/types.ts'

/** DSH 页：安装(官方安装) + 管理(列表)；弹窗在 `DshModals`。套统一 AppShell。 */
export default function DshSection() {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [dshes, setDshes] = useState<DshEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [activeId, setActiveId] = useState<string>()
  /** The entry whose details are on screen. Separate from `activeId` (the
   * ACTIVATED dsh): clicking a card only inspects it, so browsing the list can
   * never change which dsh is active — that takes the menu action. */
  const [viewId, setViewId] = useState<string>()
  const [homeInput, setHomeInput] = useState('')
  const [profileDirInput, setProfileDirInput] = useState('')
  // Exec paths that no longer exist on disk (stale = lacks the remove-guard).
  const [stalePaths, setStalePaths] = useState<Set<string>>(new Set())
  // Exec paths whose launch entry is unresolvable (incomplete install → repairable).
  const [brokenPaths, setBrokenPaths] = useState<Set<string>>(new Set())

  const [officialOpen, setOfficialOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  // 「修复/重新安装」目标：预填官方安装弹窗并强制覆盖（force 走删除同目录重装）。
  const [repairTarget, setRepairTarget] = useState<{ name: string } | null>(null)

  // 重命名弹窗（已注册 DSH）
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null)
  // 移除弹窗（可选删除文件）
  const [removeDsh, setRemoveDsh] = useState<{ id: string; name: string } | null>(null)
  // 版本更新弹窗（app 管理的 DSH）
  const [updateDsh, setUpdateDsh] = useState<{ id: string; name: string } | null>(null)
  // 数据迁移弹窗（把当前 DSH 的 home 数据迁移到另一 DSH）
  const [mirrorOpen, setMirrorOpen] = useState(false)

  const refresh = async (): Promise<void> => {
    const r = await window.api.dsh.list()
    if (!r.ok) {
      // Clear the skeleton even on failure: `loading` starts true and the rail
      // renders a spinner while it is set, so returning early here left the whole
      // page spinning forever with an empty detail pane.
      void message.error(apiErrorText(r))
      setLoading(false)
      return
    }
    setDshes(r.value.dshes)
    setActiveId(r.value.activeDshId)
    // Follow the active dsh only while nothing is being inspected, so a refresh
    // does not yank the detail pane away from the entry the user is looking at.
    setViewId(prev => (prev === undefined || !r.value.dshes.some(d => d.id === prev) ? r.value.activeDshId : prev))
    const active = r.value.dshes.find(d => d.id === r.value.activeDshId)
    setHomeInput(active?.home ?? '')
    setProfileDirInput(active?.profilesDir ?? '')
    setLoading(false)
    // Track which dsh executables no longer exist (stale) or resolve to an
    // unresolvable launch entry (broken / incomplete → repairable).
    const h = await window.api.settings.checkHealth()
    if (!h.ok) {
      // Surface it rather than silently dropping the stale/broken badges.
      void message.error(apiErrorText(h))
      return
    }
    setStalePaths(new Set(h.value.filter(x => x.kind === 'dsh-exec').map(x => x.path ?? '')))
    setBrokenPaths(new Set(h.value.filter(x => x.kind === 'dsh-broken').map(x => x.path ?? '')))
  }

  useEffect(() => { void refresh() }, [])

  // 后台的 dsh 下载/更新会话结束后联动刷新列表。必须用 onFinished：onChange
  // 推送的快照只含进行中的会话，已完成的会话永远不在其中，所以之前监听 onChange
  // 判断 status === 'done' 永远不会命中——这就导致官方安装完成后页面不刷新。
  useEffect(() => {
    return window.api.downloads.onFinished(session => {
      if (session.kind === 'dsh') void refresh()
    })
  }, [refresh])

  const activate = async (id: string, name: string): Promise<void> => {
    if (id === activeId) return
    const r = await window.api.dsh.setActive(id)
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    void message.success(t('dsh.activated', { name }))
    setActiveId(id)
    setViewId(id)
    await refresh()
  }

  const saveHome = async (value: string): Promise<string> => {
    if (viewId === undefined) return t('dsh.noDshSelected')
    const r = await window.api.dsh.setHome(viewId, value)
    if (!r.ok) return apiErrorText(r)
    setHomeInput(value)
    await refresh()
    return ''
  }

  const saveProfileDir = async (value: string): Promise<string> => {
    if (viewId === undefined) return t('dsh.noDshSelected')
    const r = await window.api.dsh.setProfileDir(viewId, value)
    if (!r.ok) return apiErrorText(r)
    setProfileDirInput(value)
    await refresh()
    return ''
  }

  const revealDir = async (id: string): Promise<void> => {
    const r = await window.api.dsh.revealDir(id)
    if (!r.ok) void message.error(apiErrorText(r))
  }

  /** Reveal a dsh's DATA home (where sessions/profiles live). */
  const revealHome = async (id: string): Promise<void> => {
    const r = await window.api.dsh.revealHome(id)
    if (!r.ok) void message.error(apiErrorText(r))
  }

  /** Reveal the profiles directory that effectively applies to a dsh. */
  const revealProfiles = async (id: string): Promise<void> => {
    const r = await window.api.dsh.revealProfiles(id)
    if (!r.ok) void message.error(apiErrorText(r))
  }

  /** Persist a drag-reorder.
   *
   * The local list MUST be reordered here: dnd-kit's transform is only a
   * transient preview during the drag, so without this the rows snap back to
   * the old order on release even though the backend saved the new one. */
  const reorder = async (ids: string[]): Promise<void> => {
    const byId = new Map(dshes.map(d => [d.id, d]))
    const next = ids.map(id => byId.get(id)).filter((d): d is DshEntry => d !== undefined)
    if (next.length === dshes.length) setDshes(next)
    const r = await window.api.dsh.reorder(ids)
    if (!r.ok) { void message.error(apiErrorText(r)); await refresh() }
  }

  const isStale = (d: DshEntry): boolean => d.execPath !== '' && stalePaths.has(d.execPath)
  const isBroken = (d: DshEntry): boolean => d.execPath !== '' && brokenPaths.has(d.execPath)

  const actionsFor = (d: DshEntry): MenuAction[] => [
    { key: 'rename', label: t('dsh.action.rename') },
    // Clicking the card activates too, so the already-active entry omits this —
    // the same rule the Profile list follows.
    ...(d.id === activeId ? [] : [{ key: 'activate', label: t('dsh.action.setCurrent') } as MenuAction]),
    // app 管理的 dsh 可原地升级版本（checkUpdate / update）。
    ...(d.managed === true
      ? [{ key: 'update', label: t('dsh.action.update') } as MenuAction]
      : []),
    // 残缺（安装不完整）的 app 托管安装可「重新安装」修复。
    ...(isBroken(d) && d.managed === true
      ? [{ key: 'repair', label: t('dsh.action.repair') } as MenuAction]
      : []),
    // 失效条目（磁盘上可执行已不存在）允许脱管清理。
    ...(isStale(d)
      ? [{ key: 'remove-stale', label: t('dsh.action.removeStale'), danger: true } as MenuAction]
      : []),
    // 仅 app 管理的（官方安装）可删除；系统级/手动加入的用户全局 dsh 不给删除入口。
    ...(d.managed === true
      ? [{ key: 'remove', label: t('dsh.action.remove'), danger: true } as MenuAction]
      : []),
  ]

  const handleAction = (d: DshEntry, key: string): void => {
    if (key === 'rename') setRenameTarget({ id: d.id, name: d.name })
    else if (key === 'activate') void activate(d.id, d.name)
    else if (key === 'update') setUpdateDsh({ id: d.id, name: d.name })
    else if (key === 'repair') setRepairTarget({ name: d.name })
    else if (key === 'remove') setRemoveDsh({ id: d.id, name: d.name })
    else if (key === 'remove-stale') {
      Modal.confirm({
        title: t('dsh.action.removeStaleConfirmTitle'),
        content: t('dsh.action.removeStaleConfirm', { name: d.name, path: d.execPath }),
        okText: t('common.confirm'),
        okButtonProps: { danger: true },
        onOk: async () => {
          const r = await window.api.dsh.remove(d.id)
          if (!r.ok) void message.error(apiErrorText(r))
          else { void message.success(t('dsh.removed')); await refresh() }
        },
      })
    }
  }

  const active = dshes.find(d => d.id === viewId)

  const exportData = async (): Promise<void> => {
    if (viewId === undefined) return
    const r = await window.api.data.export(viewId)
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    if (r.value === '') return
    void message.success(t('data.exported', { path: r.value }))
  }

  const importData = async (): Promise<void> => {
    if (viewId === undefined) return
    const entry = dshes.find(d => d.id === viewId)
    if (entry === undefined) return
    const r = await window.api.data.inspectImport()
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    if (r.value.file === '') return
    const from = r.value.manifest?.dshVersion
    const to = entry.version
    const ma = from !== undefined && from !== '' ? majorOfVersion(from) : -1
    const mb = to !== '' ? majorOfVersion(to) : -1
    const cross = ma > 0 && mb > 0 && ma !== mb
    const doImport = async (forceDsh: boolean): Promise<void> => {
      const res = await window.api.data.import(entry!.id, r.value.file, forceDsh)
      if (!res.ok) { void message.error(apiErrorText(res)); return }
      if (res.value.dshMismatch) { void message.warning(res.value.text); return }
      void message.success(res.value.text)
    }
    if (cross) {
      Modal.confirm({
        title: t('data.importConfirmTitle'),
        content: t('data.importCrossMajor', { from: from ?? '', to }),
        okText: t('data.forceImport'),
        onOk: () => void doImport(true),
      })
    } else {
      void doImport(false)
    }
  }

  return (
    <>
    <AppShell
      sider={
        <>
          <div style={{ padding: 12 }}>
            <FieldLabel>{t('dsh.section.install')}</FieldLabel>
            <Button type="primary" block onClick={() => setOfficialOpen(true)}>{t('dsh.section.officialInstall')}</Button>
          </div>

          <Divider style={{ margin: '4px 0' }} />

          <div style={{ padding: '0 16px' }}><FieldLabel>{t('dsh.section.manage')}</FieldLabel></div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            <NavList
              items={dshes}
              keyOf={d => d.id}
              selectedKey={viewId}
              onSelect={d => setViewId(d.id)}
              renderTitle={d => (
                <Space size={6}>
                  <span>{d.name}</span>
                  {d.id === activeId && <Tag color="blue">{t('ext.current')}</Tag>}
                </Space>
              )}
              renderMeta={d => (
                <span
                  style={{
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                    display: 'block',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={d.dir ?? d.execPath}
                >
                  {d.dir ?? d.execPath}
                  {isBroken(d) && <Tag color="error" style={{ marginInlineStart: 6 }}>{t('dsh.broken')}</Tag>}
                  {isStale(d) && <Tag color="error" style={{ marginInlineStart: 6 }}>{t('dsh.stale')}</Tag>}
                </span>
              )}
              actions={d => <ConfirmMenu actions={actionsFor(d)} onAction={key => handleAction(d, key)} />}
              onReorder={ids => void reorder(ids)}
              loading={loading}
              empty={<EmptyState title={t('dsh.empty.noDsh')} description={t('dsh.empty.noDshDesc')}/>}
            />
          </div>

          <div style={{ padding: '0 16px 16px' }}>
            <Button block onClick={() => setAddOpen(true)}>{t('dsh.section.add')}</Button>
          </div>
        </>
      }
    >
      {active !== undefined
        ? (
          <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
            <SectionHeading title={active.name} />
            <Panel title={t('dsh.basicInfo')}>
              {/* `tableLayout: fixed` + a fixed label column: with the default
                  auto layout the column widths follow the content, so switching
                  to a dsh with a shorter launch path visibly shifted the table. */}
              <Descriptions
                size="small"
                column={1}
                bordered
                style={{ tableLayout: 'fixed' }}
                labelStyle={{ width: 120 }}
              >
                <Descriptions.Item label={t('dsh.version')}>
                  <Tag color="geekblue">{active.version || t('common.unknown')}</Tag>
                </Descriptions.Item>
                <Descriptions.Item label={t('dsh.launchCommand')}>
                  <Typography.Text copyable code style={{ wordBreak: 'break-all' }}>
                    {active.launch ?? active.execPath}
                  </Typography.Text>
                </Descriptions.Item>
                <Descriptions.Item label={t('dsh.location')}>
                  <Space size="small">
                    <Typography.Text copyable code style={{ wordBreak: 'break-all' }}>
                      {active.dir ?? active.execPath}
                    </Typography.Text>
                    <Button size="small" onClick={() => void revealDir(active.id)}>{t('dsh.reveal')}</Button>
                  </Space>
                </Descriptions.Item>
              </Descriptions>
            </Panel>
            <Panel title={t('dsh.dirConfig')}>
              <ConfigRow
                title={t('dsh.homeTitle')}
                description={t('dsh.homeDesc')}
                value={homeInput}
                onSave={saveHome}
                onReveal={active !== undefined ? () => void revealHome(active.id) : undefined}
              />
              <div style={{ margin: '10px 0', borderTop: `1px solid ${token.colorSplit}` }} />
              <ConfigRow
                title={t('dsh.profileDirTitle')}
                description={t('dsh.profileDirDesc')}
                value={profileDirInput}
                onSave={saveProfileDir}
                onReveal={active !== undefined ? () => void revealProfiles(active.id) : undefined}
                revealDisabled={active === undefined}
                // The effective directory belongs UNDER the value, not in the
                // heading: it is a fact about that value (the override is often
                // blank, yet a directory is always in force).
                footer={t('dsh.effectiveDir', { dir: active?.profileDir ?? '—' })}
              />
            </Panel>
            <Panel title={t('dsh.dataTitle')}>
              <div style={{ marginBottom: 8, color: token.colorTextTertiary, fontSize: token.fontSizeSM }}>
                {t('dsh.dataDesc')}
              </div>
              <Space wrap>
                <Button onClick={() => void exportData()}>{t('data.export')}</Button>
                <Button onClick={() => void importData()}>{t('data.import')}</Button>
                <Button onClick={() => setMirrorOpen(true)}>{t('data.mirror')}</Button>
              </Space>
            </Panel>
          </Space>
        )
        : (loading
            ? undefined
            : <EmptyState title={t('dsh.select')} description={t('dsh.selectDesc')} />)}
    </AppShell>

    <OfficialInstallModal
      open={officialOpen || repairTarget !== null}
      onClose={() => { setOfficialOpen(false); setRepairTarget(null) }}
      onDone={() => void refresh()}
      preset={repairTarget === null ? undefined : { name: repairTarget.name, force: true }}
    />
    <AddDshModal open={addOpen} onClose={() => setAddOpen(false)} onDone={() => void refresh()} />
    <RenameDshModal target={renameTarget} onClose={() => setRenameTarget(null)} onDone={() => void refresh()} />
    <DshRemoveModal dsh={removeDsh} onClose={() => setRemoveDsh(null)} onRemoved={() => void refresh()} />
    <UpdateDshModal dsh={updateDsh} onClose={() => setUpdateDsh(null)} onDone={() => void refresh()} />
    <DataMirrorModal
      open={mirrorOpen}
      source={active === undefined ? null : { id: active.id, name: active.name, version: active.version }}
      onClose={() => setMirrorOpen(false)}
      onDone={() => void refresh()}
    />
    </>
  )
}