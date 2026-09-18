import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Input, Modal, theme, message } from 'antd'
import { useTranslation } from 'react-i18next'
import SectionHeading from './SectionHeading.tsx'
import { MODAL } from '../theme.ts'

interface Props {
  title: string
  description?: string
  /** The current value; empty shows "unconfigured". */
  value: string
  /** Apply a new value; resolves to an error string, or '' on success. */
  onSave: (next: string) => Promise<string>
  /** Optional: reveal a directory in the OS file manager, beside 「Edit」. */
  onReveal?: () => void
  /**
   * Whether the reveal button is disabled. Defaults to "the value is empty",
   * which is right when the value IS the directory. Pass this explicitly when
   * the opened directory is DERIVED instead — e.g. the profiles row opens the
   * effective `<home>/profiles` while its editable override is often blank.
   */
  revealDisabled?: boolean
  /** Muted line UNDER the value row — for a derived fact about it (e.g. the
   * directory that actually applies), which belongs with the value rather than
   * in the heading's description. */
  footer?: ReactNode
}

/** A single-config edit flow: shows the current value (+「Edit」), opens a small
 * dialog (title "Edit X", input, confirm/cancel) to edit it. With `onReveal` it
 * also offers an "open" button, for the rows that name a real directory. */
export default function ConfigRow({ title, description, value, onSave, onReveal, revealDisabled, footer }: Props) {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const openEdit = (): void => {
    setDraft(value)
    setOpen(true)
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    const error = await onSave(draft.trim())
    setBusy(false)
    if (error !== '') { void message.error(error); return }
    void message.success(t('common.updatedWithTitle', { title }))
    setOpen(false)
  }

  return (
    // Full width (capped) rather than content-sized: a short value would
    // otherwise let the row shrink and the "Edit" button drift left, so
    // switching between two dshs visibly shifted the layout.
    <div style={{ width: '100%', maxWidth: 720 }}>
      <SectionHeading title={title} description={description} />
      <div style={{ display: 'flex', alignItems: 'center', gap: token.paddingSM }}>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            color: value.trim() === '' ? token.colorTextTertiary : token.colorText,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {value.trim() === '' ? t('common.unconfigured') : value}
        </span>
        {/* Grouped with 「Edit」 and icon-free: this row is about one directory,
            so a second icon button competed with the primary action. */}
        {onReveal !== undefined && (
          <Button
            disabled={revealDisabled ?? value.trim() === ''}
            onClick={onReveal}
          >
            {t('common.open')}
          </Button>
        )}
        <Button onClick={openEdit}>{t('common.edit')}</Button>
      </div>

      {footer !== undefined && (
        <div style={{ marginTop: 6, color: token.colorTextTertiary, fontSize: token.fontSizeSM }}>
          {footer}
        </div>
      )}

      <Modal
        title={t('common.editModalTitle', { title })}
        open={open}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
        onOk={() => void save()}
        onCancel={() => setOpen(false)}
        confirmLoading={busy}
        width={MODAL.narrow}
      >
        <Input value={draft} onChange={e => setDraft(e.target.value)} onPressEnter={() => void save()} />
      </Modal>
    </div>
  )
}