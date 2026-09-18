/** Skill browser. Read-only here: dsh has no NATIVE skill enable/disable switch
 * (frontmatter `disable-model-invocation` only stops automatic model invocation),
 * so offering a toggle would silently do nothing. A dsh PLUGIN can still provide
 * one by registering a lower-rank override provider, but that lives inside the dsh
 * process and cannot be driven from this external one.
 *
 * What it DOES show is what dsh itself only logs: which same-named skill wins
 * and which rows are therefore inactive. Each row is labelled by the discovery
 * SOURCE dsh resolves it from (its own `Source` ids and rank order), so the
 * labels match the mechanism rather than inventing a parallel vocabulary. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Input, Modal, Pagination, Space, Table, Tag, Tooltip, message, theme } from 'antd'
import { ReloadOutlined, FolderOpenOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { apiErrorText } from '../lib/ipc.ts'
import Panel from '../components/Panel.tsx'
import SectionHeading from '../components/SectionHeading.tsx'
import { MODAL } from '../theme.ts'
import type { SkillRootInfo, SkillRow, SkillScanResult, SkillSource } from '../../../shared/types.ts'

/**
 * Tag colour per discovery source, warm (highest precedence) to cool.
 *
 * Keyed by dsh's OWN source ids — there is no intermediate "tier" grouping.
 * Collapsing `project-dsh`/`project-agents` into one tier (and the two user
 * roots into another) produced a second set of names that disagreed with the
 * labels, which is exactly the confusion this removes.
 */
const SOURCE_COLOR: Record<SkillSource, string> = {
  'project-dsh': 'magenta',
  'project-agents': 'volcano',
  custom: 'purple',
  'user-dsh': 'geekblue',
  'user-agents': 'blue',
  bundled: 'default',
}

export default function SkillSection() {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [data, setData] = useState<SkillScanResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [q, setQ] = useState('')
  const [onlyInactive, setOnlyInactive] = useState(false)
  // Pagination is driven from the panel header (same row as the search box), so
  // the current page AND the page size have to live here rather than inside the
  // Table. Both are state, not constants: a fixed size made the size changer
  // either absent or inert.
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [body, setBody] = useState<{ name: string; content: string } | null>(null)
  const [bodyLoading, setBodyLoading] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    const r = await window.api.skill.scan()
    setLoading(false)
    if (!r.ok) { setError(apiErrorText(r)); return }
    setError('')
    setData(r.value)
  }, [])

  useEffect(() => { void load() }, [load])

  // Guards the body read against out-of-order responses: clicking row A then row B
  // could land A's content under B's title (ProfileDetail guards the same way).
  const bodySeq = useRef(0)

  const openBody = async (row: SkillRow): Promise<void> => {
    const seq = ++bodySeq.current
    setBodyLoading(true)
    setBody({ name: row.name, content: '' })
    const r = await window.api.skill.read(row.name, row.source, row.rank)
    if (seq !== bodySeq.current) return // a newer read superseded this one
    setBodyLoading(false)
    if (!r.ok) {
      setBody(null)
      void message.error(apiErrorText(r))
      return
    }
    setBody({ name: row.name, content: r.value.content })
  }

  const openDir = async (row: SkillRow): Promise<void> => {
    const r = await window.api.skill.openDir(row.name, row.source, row.rank)
    if (!r.ok) void message.error(apiErrorText(r))
  }

  const openRoot = async (root: SkillRootInfo): Promise<void> => {
    const r = await window.api.skill.openRoot(root.path)
    if (!r.ok) void message.error(apiErrorText(r))
  }

  const rows = useMemo(() => {
    const all = data?.rows ?? []
    const needle = q.trim().toLowerCase()
    return all.filter(r => {
      if (onlyInactive && r.shadowedBy === undefined) return false
      if (needle === '') return true
      return r.name.toLowerCase().includes(needle)
        || (r.description ?? '').toLowerCase().includes(needle)
        || t(`skill.scope.${r.source}`).toLowerCase().includes(needle)
        // The label no longer spells out `.dsh`/`.agents`, but those are the
        // names a user knows from the filesystem, so match the raw source id
        // too — otherwise searching "agents" would miss every one of them.
        || r.source.toLowerCase().includes(needle)
    })
  }, [data, q, onlyInactive, t])

  const roots: SkillRootInfo[] = data?.roots ?? []
  /** The slice the table renders — the header's Pagination owns the window. */
  const pageRows = useMemo(
    () => rows.slice((page - 1) * pageSize, page * pageSize),
    [rows, page, pageSize],
  )

  const columns = [
    {
      title: t('skill.colName'),
      key: 'name',
      render: (_: unknown, r: SkillRow) => (
        <Space orientation="vertical" size={0}>
          <Space size={6}>
            <span style={{ fontWeight: 500, fontFamily: 'monospace' }}>{r.name}</span>
            {!r.modelInvocable && <Tag color="orange">{t('skill.manualOnly')}</Tag>}
          </Space>
          {r.description !== undefined && (
            <span style={{
              fontSize: token.fontSizeSM, color: token.colorTextSecondary,
              maxWidth: 620, display: 'inline-block', overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {r.description}
            </span>
          )}
        </Space>
      ),
    },
    {
      // The scope tag is what decides a duplicate, so it is the whole cell; the
      // exact directory lives in its tooltip rather than as a second line.
      title: t('skill.colScope'),
      key: 'scope',
      width: 130,
      render: (_: unknown, r: SkillRow) => {
        // The tag alone carries the source; the exact directory lives in its
        // tooltip. `origin` names the OWNER (a preset), not a path, so a
        // preset-contributed row shows both.
        const hint = r.origin !== undefined
          ? `${t(`skill.scope.${r.source}`)}${t('common.qualifier', { text: r.origin })}\n${r.path}`
          : r.path
        return (
          <Tooltip title={<span style={{ whiteSpace: 'pre-line' }}>{hint}</span>}>
            <Tag color={SOURCE_COLOR[r.source]} style={{ marginInlineEnd: 0 }}>
              {t(`skill.scope.${r.source}`)}
            </Tag>
          </Tooltip>
        )
      },
    },
    {
      title: t('skill.colState'),
      key: 'state',
      width: 130,
      render: (_: unknown, r: SkillRow) => (
        r.shadowedBy === undefined
          ? <Tag color="green">{t('skill.effective')}</Tag>
          : (
            <Tooltip title={t('skill.shadowedBy', { source: t(`skill.scope.${r.shadowedBy.source}`) })}>
              <Tag color="red">{t('skill.shadowedTag')}</Tag>
            </Tooltip>
          )
      ),
    },
    {
      title: '',
      key: 'body',
      width: 170,
      render: (_: unknown, r: SkillRow) => (
        <Space size={4}>
          <Button size="small" onClick={() => void openBody(r)}>{t('skill.readBody')}</Button>
          <Button size="small" icon={<FolderOpenOutlined />} onClick={() => void openDir(r)}>
            {t('skill.openDir')}
          </Button>
        </Space>
      ),
    },
  ]

  return (
    <div style={{ padding: token.padding }}>
      <SectionHeading
        title={t('skill.title')}
        description={t('skill.desc')}
        extra={(
          <Space>
            <span style={{ color: token.colorTextSecondary }}>
              {t('skill.count', { count: data?.rows.length ?? 0 })}
              {(data?.shadowedCount ?? 0) > 0 ? ` · ${t('skill.shadowed', { count: data?.shadowedCount ?? 0 })}` : ''}
            </span>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>{t('ext.refresh')}</Button>
          </Space>
        )}
      />

      <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
        {/* Compact one-liner: the previous two-line alert ate vertical space
            above the table without adding information. The second line names the
            two dimensions the labels combine — scope (project vs user) and
            directory system (.dsh vs .agents) — because listing six flat names
            made `.dsh`/`.agents` look like two more scopes. */}
        <Alert
          type="info"
          showIcon
          title={(
            <span style={{ fontSize: token.fontSizeSM }}>
              {t('skill.legend')}{t('common.listSep')}{t('skill.legendOrder')}
              <br />
              {t('skill.legendSystem')}
            </span>
          )}
        />
        {error !== '' && <Alert type="error" showIcon title={error} />}

        <Panel title={t('skill.rootsTitle')} description={t('skill.projectNote')}>
          <Space wrap size={[8, 8]}>
            {roots.map(root => (
              <Tooltip key={`${root.source}-${root.path}`} title={root.path}>
                <Tag
                  color={root.exists ? SOURCE_COLOR[root.source] : undefined}
                  style={{ cursor: root.exists ? 'pointer' : 'default' }}
                  // A directory that does not exist must not look clickable: the
                  // click would silently do nothing. No handler when it is absent.
                  onClick={root.exists ? () => void openRoot(root) : undefined}
                >
                  {root.exists && <FolderOpenOutlined style={{ marginInlineEnd: 4 }} />}
                  {t(`skill.scope.${root.source}`)}
                  {root.exists ? ` · ${t('skill.rootsCount', { count: root.count })}` : ` · ${t('skill.rootsMissing')}`}
                </Tag>
              </Tooltip>
            ))}
          </Space>
        </Panel>

        <Panel pad={false} extra={(
          <Space size={8}>
            <Input.Search
              allowClear
              value={q}
              onChange={e => { setQ(e.target.value); setPage(1) }}
              placeholder={t('skill.searchPlaceholder')}
              style={{ width: 220 }}
            />
            <Button
              type={onlyInactive ? 'primary' : 'default'}
              onClick={() => { setOnlyInactive(v => !v); setPage(1) }}
            >
              {t('skill.filterDuplicate')}
            </Button>
            {/* Paging sits with the filters instead of being stranded under a
                long list. The size changer is compact but real, so a short list
                (where every option shows the same rows) is not the only way to
                verify it works. */}
            <Pagination
              size="small"
              current={page}
              pageSize={pageSize}
              total={rows.length}
              showSizeChanger
              pageSizeOptions={[10, 25, 50, 100]}
              onChange={(p, size) => { setPage(size === pageSize ? p : 1); setPageSize(size) }}
              hideOnSinglePage
            />
          </Space>
        )}>
          <Table<SkillRow>
            size="small"
            rowKey={r => `${r.source}:${r.rank}:${r.path}`}
            columns={columns}
            dataSource={pageRows}
            loading={loading}
            // Pagination lives in the panel header (same row as the search box),
            // so the table renders just the current slice with no second footer.
            pagination={false}
            locale={{ emptyText: t('skill.empty') }}
          />
        </Panel>
      </Space>

      <Modal
        title={t('skill.bodyTitle', { name: body?.name ?? '' })}
        open={body !== null}
        onCancel={() => setBody(null)}
        footer={<Button onClick={() => setBody(null)}>{t('common.close')}</Button>}
        width={MODAL.wide}
      >
        {bodyLoading
          ? <span style={{ color: token.colorTextSecondary }}>{t('skill.bodyLoading')}</span>
          : (
            <div style={{ maxHeight: '60vh', overflowY: 'auto', lineHeight: 1.7 }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{body?.content ?? ''}</ReactMarkdown>
            </div>
          )}
      </Modal>
    </div>
  )
}
