/**
 * Application-level state aggregated from persisted settings — the single
 * dependency source for the IPC layer.
 *
 * dsh selection, the active install, effective directories and the plugin-store
 * location all live here, derived from `AppSettings` (never module globals that
 * drift out of sync). The only injected piece is the Electron `userData` path
 * (via {@link configureAppState}); `core` itself stays free of Electron imports.
 */
import { join } from 'node:path'
import { loadSettings, saveSettings, type AppSettings } from './settings.ts'
import type { DshEntry } from '../../shared/types.ts'

/** The dsh shape a scope carries through plugin-scoped scans. */
export interface DshScope {
  id: string
  name: string
  version?: string
  home: string
  profilesDir?: string
}

/** Electron `userData` dir, injected from the main entry before any IPC. */
let userData = ''

/** Configure app-state defaults that depend on the Electron `userData` path. */
export function configureAppState(dataDir: string): void {
  userData = dataDir
}

// ── dsh selection ───────────────────────────────────────────────────────────

/** Registered dsh installs + the active id, from settings. */
export function readDshState(): { dshes: DshEntry[]; activeDshId?: string } {
  const s = loadSettings()
  return { dshes: s.dshes ?? [], activeDshId: s.activeDshId }
}

/** Persist the registered dsh list + active id. */
export function writeDshState(dshes: DshEntry[], activeDshId?: string): void {
  saveSettings({ ...loadSettings(), dshes, activeDshId })
}

/**
 * Reorder the registered dsh list to match `ids`.
 *
 * `ids` must name EXACTLY the registered set: a partial list would silently
 * drop entries, an unknown id would inject one, and a duplicate would both drop
 * and duplicate. Any mismatch is refused rather than partially applied.
 * Returns false when the order was rejected (nothing written).
 */
export function reorderDshes(ids: readonly string[]): boolean {
  const { dshes, activeDshId } = readDshState()
  if (ids.length !== dshes.length) return false
  const byId = new Map(dshes.map(d => [d.id, d]))
  const next: DshEntry[] = []
  for (const id of ids) {
    const entry = byId.get(id)
    if (entry === undefined) return false
    next.push(entry)
    byId.delete(id)
  }
  if (byId.size > 0) return false
  writeDshState(next, activeDshId)
  return true
}

/** The active dsh entry, or `undefined` when none is selected. */
export function activeDshEntry(): DshEntry | undefined {
  const { dshes, activeDshId } = readDshState()
  return dshes.find(d => d.id === activeDshId)
}

// ── profile selection ───────────────────────────────────────────────────────

/**
 * The profile marked as current for the active dsh, or `undefined`.
 *
 * Stored per dsh (`Record<dshId, name>`) so each install remembers its own
 * choice — switching dsh swaps the profile view without clobbering the last
 * selection. A name whose profile no longer exists is treated as unset rather
 * than returned stale.
 */
export function activeProfile(): string | undefined {
  const s = loadSettings()
  const dshId = s.activeDshId
  if (dshId === undefined) return undefined
  const name = s.activeProfiles?.[dshId]
  return typeof name === 'string' && name.trim() !== '' ? name : undefined
}

/** Mark a profile as current for the active dsh. Pass `undefined` to clear. */
export function setActiveProfile(name: string | undefined): void {
  const s = loadSettings()
  const dshId = s.activeDshId
  if (dshId === undefined) return
  const next = { ...(s.activeProfiles ?? {}) }
  if (name === undefined || name.trim() === '') delete next[dshId]
  else next[dshId] = name
  saveSettings({ ...s, activeProfiles: next })
}

// ── profile display order ───────────────────────────────────────────────────

/** The user-chosen profile order for the active dsh (may be empty). */
export function profileOrder(): string[] {
  const s = loadSettings()
  const dshId = s.activeDshId
  if (dshId === undefined) return []
  const order = s.profileOrder?.[dshId]
  return Array.isArray(order) ? order : []
}

/**
 * Sort `names` into the user's saved order, appending anything not listed
 * alphabetically — so a newly created profile shows up predictably even though
 * it is not in the saved order yet.
 */
export function applyProfileOrder(names: readonly string[]): string[] {
  const saved = profileOrder()
  const rank = new Map(saved.map((name, i) => [name, i]))
  return [...names].sort((a, b) => {
    const ra = rank.get(a)
    const rb = rank.get(b)
    if (ra !== undefined && rb !== undefined) return ra - rb
    if (ra !== undefined) return -1
    if (rb !== undefined) return 1
    return a.localeCompare(b)
  })
}

/**
 * Persist a profile order for the active dsh.
 *
 * Nothing is validated against the profile list here: profiles come and go
 * (create / delete / trash), so the saved order is a PREFERENCE that
 * {@link applyProfileOrder} reconciles on read. Requiring it to match exactly
 * would silently drop the order every time a profile was added or removed.
 */
export function setProfileOrder(names: readonly string[]): void {
  const s = loadSettings()
  const dshId = s.activeDshId
  if (dshId === undefined) return
  saveSettings({ ...s, profileOrder: { ...(s.profileOrder ?? {}), [dshId]: [...names] } })
}

/** The configured profiles dir for a dsh: its override, else `<home>/profiles`. */
export function effectiveProfileDir(entry: DshEntry): string {
  const dir = entry.profilesDir
  return typeof dir === 'string' && dir.trim() !== '' ? dir : join(entry.home, 'profiles')
}

/** The dsh context a profile/data operation targets — normally the active dsh,
 * but version migration / data export can target an explicit dsh. Carries just
 * the fields core functions need, so they don't depend on the full entry. */
export interface DshContext {
  home: string
  /** Override for the profiles dir (default `<home>/profiles`). */
  profilesDirOverride?: string
  /** The dsh version, for export version-tagging and cross-version gates. */
  version: string
}

/** Build a DshContext from a dsh entry. */
export function contextForEntry(entry: DshEntry): DshContext {
  return {
    home: entry.home,
    profilesDirOverride: entry.profilesDir,
    version: entry.version,
  }
}

/** The profiles root a context operates on: its override, else `<home>/profiles`. */
export function profilesRootFor(ctx: DshContext): string {
  const dir = ctx.profilesDirOverride
  return typeof dir === 'string' && dir.trim() !== '' ? dir : join(ctx.home, 'profiles')
}

/** The plugin-scan scopes derived from every registered dsh. */
export function dshScopes(): DshScope[] {
  return readDshState().dshes.map(d => ({
    id: d.id, name: d.name, version: d.version, home: d.home, profilesDir: d.profilesDir,
  }))
}

// ── directory defaults ──────────────────────────────────────────────────────

/** Default plugin store under `userData` — used until the user chooses one. */
function defaultPluginDir(): string {
  return join(userData, 'plugins')
}

/** The effective plugin store dir: the user-configured one, else the default. */
export function pluginDir(): string {
  const dir = loadSettings().pluginDir
  return typeof dir === 'string' && dir.trim() !== '' ? dir : defaultPluginDir()
}

/** Default base of the local dsh version repository. */
export function defaultVersionDir(): string {
  return join(userData, 'dsh', 'versions')
}

/** The dsh version repository location from settings (default fallback). Empty /
 * whitespace counts as unset, mirroring `pluginDir()`. */
export function dshVersionDir(): string {
  const dir = loadSettings().dshVersionDir
  return typeof dir === 'string' && dir.trim() !== '' ? dir : defaultVersionDir()
}

/** True when a genuinely fresh install should run the onboarding wizard: no
 * completion flag AND no user data yet (upgraded users with data are treated
 * as already configured — never re-surveyed). */
export function shouldRunOnboarding(): boolean {
  const s = loadSettings()
  if (s.onboarded === true) return false
  const hasUserData =
    (s.dshes?.length ?? 0) > 0 ||
    (typeof s.pluginDir === 'string' && s.pluginDir.trim() !== '') ||
    (typeof s.dshVersionDir === 'string' && s.dshVersionDir.trim() !== '')
  return !hasUserData
}

/** Convenience re-exports used by IPC modules that read/write settings. */
export type { AppSettings }