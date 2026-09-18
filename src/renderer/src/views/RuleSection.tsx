/** The "规则" pane: view and edit the active dsh's global instruction file
 * (`$DSH_HOME/AGENTS.md`) — the one file dsh injects into every session under
 * that home, regardless of project.
 *
 * Rendered INSIDE the extensions shell (`ExtensionsSection`), which already owns
 * the DSH switcher and remounts this pane when the active dsh changes — so the
 * file shown always belongs to the dsh named in the rail.
 *
 * Project-level instruction files are deliberately absent: they are discovered
 * from a session's workspace upward, and the Launcher has no workspace concept,
 * so the pane explains that rather than showing a layer that never applies. */

import { useCallback, useEffect, useState } from 'react'
import { Button, Input, Space, Tag, Tooltip, Typography, theme, message } from 'antd'
import { FolderOpenOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../lib/ipc.ts'
import Panel from '../components/Panel.tsx'
import SectionHeading from '../components/SectionHeading.tsx'
import EmptyState from '../components/EmptyState.tsx'
import type { RuleFile } from '../../../shared/types.ts'

/** Bytes → a short human string. */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

export default function RuleSection(): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [file, setFile] = useState<RuleFile | null>(null)
  // The text last read from / written to disk; the draft is compared against it.
  const [saved, setSaved] = useState('')
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    const r = await window.api.rule.read()
    setLoading(false)
    if (!r.ok) {
      setError(apiErrorText(r))
      setFile(null)
      return
    }
    setError('')
    setFile(r.value.file)
    setSaved(r.value.content)
    setDraft(r.value.content)
  }, [])

  useEffect(() => { void load() }, [load])

  const dirty = draft !== saved

  const save = async (): Promise<void> => {
    setSaving(true)
    const r = await window.api.rule.write(draft)
    setSaving(false)
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    setFile(r.value)
    setSaved(draft)
    void message.success(t('rule.saved'))
  }

  const reveal = async (): Promise<void> => {
    const r = await window.api.rule.reveal()
    if (!r.ok) void message.error(apiErrorText(r))
  }

  /** Open the file in the OS default editor. Same action as clicking the path. */
  const openFile = async (): Promise<void> => {
    const r = await window.api.rule.openFile()
    if (!r.ok) void message.error(apiErrorText(r))
  }

  // Usage against dsh's per-file cap. Over it, dsh ignores the file ENTIRELY (not
  // a truncation), so this is worth flagging before the user saves.
  const bytes = new TextEncoder().encode(draft).length
  const overLimit = file !== null && bytes > file.sourceLimit

  const heading = (
    <SectionHeading
      title={t('rule.title')}
      description={t('rule.desc')}
      extra={(
        <Space>
          <Button icon={<FolderOpenOutlined />} onClick={() => void reveal()}>{t('rule.reveal')}</Button>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>{t('ext.refresh')}</Button>
          <Button
            type="primary"
            icon={<SaveOutlined />}
            loading={saving}
            disabled={!dirty || overLimit}
            onClick={() => void save()}
          >
            {t('common.save')}
          </Button>
        </Space>
      )}
    />
  )

  const body = (): JSX.Element => {
    if (loading) return <Panel><EmptyState title={t('rule.loading')} /></Panel>
    if (error !== '' || file === null) {
      return <Panel><EmptyState title={t('rule.loadFailed')} description={error} /></Panel>
    }
    return (
      <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
        <Panel
          title={t('rule.file')}
          // The path is the PANEL's own description, not a body line: it sits in
          // the header under the title, beside the status tags. Clicking it opens
          // the file in the OS default editor; while the file does not exist it
          // stays plain text — there is nothing to open, and a link that can only
          // fail is worse than no link (the header's "show in file manager" action
          // covers locating the missing file or its folder).
          description={file.exists ? (
            <Tooltip title={t('rule.openFileTip')}>
              <Typography.Link
                onClick={() => void openFile()}
                style={{
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                  wordBreak: 'break-all',
                }}
              >
                {file.path}
              </Typography.Link>
            </Tooltip>
          ) : (
            <Typography.Text
              style={{
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                wordBreak: 'break-all',
              }}
              type="secondary"
            >
              {file.path}
            </Typography.Text>
          )}
          extra={(
            <Space size={6}>
              <Tag color={file.exists ? 'geekblue' : undefined}>
                {file.exists ? t('rule.exists') : t('rule.missing')}
              </Tag>
              {file.bytes !== undefined && <Tag>{humanSize(file.bytes)}</Tag>}
            </Space>
          )}
        >
          {/* How dsh reads this file — the load order, the budget, and the
              per-file cap are all non-obvious and all change what the model
              actually receives. */}
          <ul style={{
            margin: 0, paddingInlineStart: 20, color: token.colorTextSecondary,
            fontSize: token.fontSizeSM, lineHeight: 1.8,
          }}>
            <li>{t('rule.order')}</li>
            <li>{t('rule.budget', { used: humanSize(bytes), budget: humanSize(file.budget) })}</li>
            <li>{t('rule.limit', { limit: humanSize(file.sourceLimit) })}</li>
            <li>{t('rule.projectScope')}</li>
          </ul>
        </Panel>

        {overLimit && (
          <Panel>
            <span style={{ color: token.colorError }}>
              {t('rule.overLimit', { limit: humanSize(file.sourceLimit) })}
            </span>
          </Panel>
        )}

        <Panel title={t('rule.editor')} description={dirty ? t('rule.unsaved') : t('rule.inSync')}>
          <Input.TextArea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            autoSize={{ minRows: 12, maxRows: 24 }}
            spellCheck={false}
            style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: token.fontSizeSM }}
            placeholder={t('rule.placeholder')}
          />
        </Panel>
      </Space>
    )
  }

  return (
    <div style={{ padding: token.padding }}>
      {heading}
      {body()}
    </div>
  )
}
