import { useState, type ReactNode } from 'react'
import { Spin, theme } from 'antd'
import {
  DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import EmptyState from './EmptyState.tsx'

interface NavListProps<T> {
  items: readonly T[]
  keyOf: (item: T) => string
  selectedKey?: string
  onSelect?: (item: T) => void
  renderTitle: (item: T, selected: boolean) => ReactNode
  renderMeta?: (item: T) => ReactNode
  /** Right-aligned action trigger(s) (e.g. a ConfirmMenu). */
  actions?: (item: T) => ReactNode
  empty?: ReactNode
  loading?: boolean
  /** When set, rows become drag-reorderable and this fires with the new id order. */
  onReorder?: (ids: string[]) => void
}

/** Drag-handle bindings passed down from the sortable wrapper. */
interface DragHandle {
  attributes: Record<string, unknown>
  listeners: Record<string, unknown> | undefined
}

/** One block-style row: canvas-tinted so it lifts off the white rail, with a
 * primary accent bar + tint when selected. Hover lifts it with a tint. */
function NavItem({ title, meta, onSelect, actions, selected, drag }: {
  title: ReactNode
  meta?: ReactNode
  onSelect?: () => void
  actions?: ReactNode
  selected?: boolean
  /** Drag-handle bindings; when absent the row is not draggable. */
  drag?: DragHandle
}): JSX.Element {
  const { token } = theme.useToken()
  const [hovered, setHovered] = useState(false)
  const clickable = onSelect !== undefined
  const active = selected ?? false
  const borderColor = active ? token.colorPrimary : token.colorBorder
  return (
    <div
      role="option"
      aria-selected={active}
      onClick={clickable ? onSelect : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onKeyDown={clickable ? (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect?.() }
      } : undefined}
      tabIndex={clickable ? 0 : undefined}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        cursor: clickable ? 'pointer' : 'default',
        padding: '10px 12px',
        borderRadius: token.borderRadiusLG,
        background: active ? token.colorPrimaryBg : (hovered ? token.colorPrimaryBgHover : token.colorBgLayout),
        border: `1px solid ${borderColor}`,
        borderInlineStart: active ? `3px solid ${token.colorPrimary}` : `1px solid ${borderColor}`,
        marginBottom: 8,
        transition: 'background 0.15s',
      }}
    >
      {/* The handle owns the drag listeners so a plain click elsewhere still
          selects the row (a whole-row drag would swallow that click). Its own
          click is stopped from reaching the row: otherwise releasing a drag
          selected that row, which fired an activate/refresh that raced the
          reorder IPC and could restore the pre-drag order. */}
      {drag !== undefined && (
        <span
          {...drag.attributes}
          {...(drag.listeners ?? {})}
          aria-label="drag"
          onClick={event => event.stopPropagation()}
          style={{ cursor: 'grab', flexShrink: 0, touchAction: 'none', color: token.colorTextTertiary, fontSize: 14 }}
        >
          ⠿
        </span>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontWeight: active ? 600 : 400, color: token.colorText,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {title}
        </div>
        {meta !== undefined && (
          <div style={{ fontSize: token.fontSizeSM, color: token.colorTextTertiary, marginTop: 2 }}>{meta}</div>
        )}
      </div>
      {actions !== undefined && (
        <div style={{ flex: '0 0 auto' }} onClick={event => event.stopPropagation()}>{actions}</div>
      )}
    </div>
  )
}

/** One sortable wrapper — dnd-kit needs the transform on the outermost node. */
function SortableRow({ id, children }: {
  id: string
  children: (drag: DragHandle) => ReactNode
}): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: transform !== null ? CSS.Transform.toString(transform) : undefined,
        transition,
        opacity: isDragging ? 0.4 : 1,
        zIndex: isDragging ? 1 : undefined,
        position: 'relative',
      }}
    >
      {children({
        attributes: attributes as unknown as Record<string, unknown>,
        listeners: listeners as unknown as Record<string, unknown> | undefined,
      })}
    </div>
  )
}

/**
 * Clickable navigation list with unified block-style rows (canvas-tinted with
 * activate accent on select, tint on hover). Shared by DshSection and
 * ProfileSection so the two rails stay visually identical.
 *
 * Pass `onReorder` to make rows drag-reorderable (dnd-kit, via the handle at the
 * left of each row). Without it the list behaves exactly as before.
 */
export default function NavList<T>({
  items, keyOf, selectedKey, onSelect, renderTitle, renderMeta, actions, empty, loading, onReorder,
}: NavListProps<T>): ReactNode {
  // A drag must be INTENTIONAL. Without an activation constraint, dnd-kit treats
  // a plain press-and-release as a drag, so clicking a row's drag handle (or
  // merely pressing on it) fired `onDragEnd` and moved that row to wherever the
  // pointer happened to be — which is how "activate a dsh" silently reordered
  // the list. 5px of travel is required before a drag begins.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  if (loading) return <Spin style={{ display: 'block', margin: '24px auto' }} />
  if (items.length === 0) return empty ?? <EmptyState />

  const onDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event
    if (over === null || active.id === over.id) return
    const ids = items.map(keyOf)
    const from = ids.indexOf(String(active.id))
    const to = ids.indexOf(String(over.id))
    if (from < 0 || to < 0) return
    const next = [...ids]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    onReorder?.(next)
  }

  const renderRow = (item: T, drag?: DragHandle): ReactNode => {
    const key = keyOf(item)
    const selected = key === selectedKey
    return (
      <NavItem
        title={renderTitle(item, selected)}
        meta={renderMeta !== undefined ? renderMeta(item) : undefined}
        actions={actions !== undefined ? actions(item) : undefined}
        selected={selected}
        onSelect={onSelect !== undefined ? () => onSelect(item) : undefined}
        {...(drag !== undefined ? { drag } : {})}
      />
    )
  }

  const list = (
    <div role="listbox" style={{ padding: '0 8px' }}>
      {items.map(item => onReorder === undefined
        ? <div key={keyOf(item)}>{renderRow(item)}</div>
        : <SortableRow key={keyOf(item)} id={keyOf(item)}>{drag => renderRow(item, drag)}</SortableRow>)}
    </div>
  )

  if (onReorder === undefined) return list
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} autoScroll={false} onDragEnd={onDragEnd}>
      <SortableContext items={items.map(keyOf)} strategy={verticalListSortingStrategy}>
        {list}
      </SortableContext>
    </DndContext>
  )
}
