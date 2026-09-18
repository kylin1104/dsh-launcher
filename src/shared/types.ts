/**
 * Shared types across the main-process service, preload/IPC boundary, and the
 * renderer — the single source of truth for cross-process shapes.
 *
 * Main/core re-exports these (see `src/main/core/types.ts` and the domain
 * modules) so existing import paths stay valid; renderer and preload should
 * import directly from here.
 */

// ── patch / profile layering ────────────────────────────────────────────────

/** One plugin row visible in the UI: a `- id: ...` entry in a cordis patch layer. */
export interface PluginRow {
  /** Row id (the `- id:` value). */
  id: string
  /** Whether this layer row is disabled. */
  disabled: boolean
}

/** One patch row classified for the layer stack: its block's shape. */
export interface ClassifiedRow {
  id: string
  /** Package name the row mounts, when the block declares one. */
  name?: string
  disabled: boolean
  hasConfig: boolean
  hasInsert: boolean
}

/** A layer within the composed profile stack (application order). */
export interface ProfileLayer {
  /** Where this layer comes from. */
  source: 'bundle' | 'profile' | 'home'
  /** Bundle package name when `source === 'bundle'`. */
  bundle?: string
  /** Profile name when `source === 'profile'`. */
  label?: string
  rows: ClassifiedRow[]
}

/** Input for creating/updating a row in the profile layer's patch. */
export interface RowCreateInput {
  id: string
  disabled?: boolean
  config?: string
  insert?: string[]
}

/** One point where a plugin is in use: a profile under some dsh. */
export interface PluginUsagePoint {
  dsh: string
  dshVersion?: string
  profile: string
  /** The resolved version of this plugin actually installed in the profile's
   * `node_modules` (read from its `package.json`). Absent when the profile has
   * not been installed yet, or the plugin isn't resolved into its node_modules. */
  version?: string
}

/** How an archived plugin version got into the store. `dsh` = shipped with the
 * harness (never archived); `store` = archived but its origin predates source
 * tracking (unresolved). */
export type PluginSource = 'github' | 'npm' | 'local' | 'dsh' | 'store'

/** Lifecycle state of a download task. */
export type DownloadStatus = 'running' | 'done' | 'failed' | 'cancelled'

/** What kind of install a download session represents. */
export type DownloadKind = 'plugin' | 'dsh'

/** Per-step state of a task that has visible multi-stage progress (dsh install). */
export type DownloadStepStatus = 'running' | 'ok' | 'error'

/** One progress step of a multi-stage task (e.g. dsh install: version→install→register). */
export interface DownloadStep {
  /** Step key — maps to a localized label (`dsh.official.step.<key>` for dsh). */
  key: string
  status: DownloadStepStatus
  detail?: string
  /** Optional short tag, e.g. the resolved version number. */
  meta?: string
}

/** One download task (plugin or dsh), visible to the renderer's global download panel. */
export interface DownloadSessionInfo {
  id: string
  kind: DownloadKind
  /** Display/install name (package name, or dsh install name). */
  name: string
  /** The pnpm source spec (`name@ver`, `github:owner/repo`, `file:…`) — plugin only. */
  source: string
  /** Secondary line: plugin = the source spec; dsh = target version / description. */
  detail?: string
  status: DownloadStatus
  /** Failure/cancel detail, when any. */
  message?: string
  /** Live progress steps (dsh only; plugins run as a single front-and-back step). */
  steps?: DownloadStep[]
}

/** One row of the installed-plugin overview. */
export interface InstalledOverviewRow {
  name: string
  versions: string[]
  usage: PluginUsagePoint[]
  inStore: boolean
  /** Distinct origins of the archived versions (GitHub / npm / local folder),
   * plus `dsh` when it is a built-in template. Empty when nothing resolved. */
  sources: PluginSource[]
  /** True for a dsh-bundled template (used by a profile but not in the store):
   * shown as built-in, not a manageable plugin. */
  builtin?: boolean
  /**
   * Whether another version can be fetched for this plugin. False for a
   * `local` source (installed from a folder, so there is no package to fetch)
   * and for a bundled template — asking npm for those fails. Set by the
   * overview builder once every source is known.
   */
  downloadable?: boolean
  /** Real on-disk bytes of this plugin's own files (inode-dedup across its archive
   * versions / profile copy). Absent when nothing resolved on disk. */
  sizeBytes?: number
}

/** What `profile:load` returns for one profile. */
export interface ProfileDetail {
  /** Ordered `dsh.profile.bundles` layer list. */
  bundles: string[]
  /** Profile manifest `dependencies` (package names). */
  dependencies: string[]
  /** The profile's own user-patch rows (from its `cordis.patch.yml`). */
  rows: PluginRow[]
  /** The profile's `cordis.patch.yml` content (view-only). */
  patchText: string
}

/** Uniform IPC result envelope. The failure side carries a stable error `code`
 * (mapped to localized text in the renderer via `t('errors.<code>')`) plus the
 * raw `error` string as a fallback/detail. */
export type IpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; params?: Record<string, string> | string[]; error: string }

/** Streamed status of the embedded profile runtime (main → renderer via `run:event`). */
export type RunEvent =
  | { type: 'output'; line: string }
  | { type: 'exited'; code: number | null; signal: NodeJS.Signals | null; command?: string }

// ── dsh installs ────────────────────────────────────────────────────────────

/** One registered/detected dsh install. */
export interface DshEntry {
  id: string
  name: string
  execPath: string
  version: string
  /** This dsh's own data home (profiles live under `<home>/profiles`). */
  home: string
  /** Optional override for this dsh's profiles directory (default `<home>/profiles`). */
  profilesDir?: string
  /** Effective (resolved) profiles directory, computed at read time after any
   * override; distinct from the configured `profilesDir`. */
  profileDir?: string
  /** Persisted app-managed marker (set on official install; the read side merges
   * it with a path-derived check so a clobbered marker still leaves an app
   * install deletable). System/globally-installed dsh are never managed. */
  managed?: boolean
  /** The version-repo root this install landed in (official installs only).
   * Lets delete/cleanup anchor to the actual install dir even when the current
   * `dshVersionDir` setting has since changed. Absent on legacy entries. */
  versionDir?: string
  /** User-friendly base launch command (e.g. `pnpm dsh`), derived at read time. */
  launch?: string
  /** Directory holding this dsh's executable (derived, for reveal-in-explorer). */
  dir?: string
}

// ── health check (disk ↔ app sync) ───────────────────────────────────────────

/** What a health check flagged on the disk vs. the app's recorded state. */
export type HealthIssueKind =
  /** A registered dsh's executable no longer exists on disk. */
  | 'dsh-exec'
  /** The dsh executable exists but its launch entry is unresolvable (incomplete install). */
  | 'dsh-broken'
  /** No plugin store location is configured. */
  | 'store-unconfigured'
  /** The plugin store dir is configured but does not exist on disk. */
  | 'store-missing'
  /** A catalogued store plugin's node_modules dir is missing on disk. */
  | 'plugin-missing'

/** One flagged discrepancy, surfaced by `settings:checkHealth`. */
export interface HealthIssue {
  kind: HealthIssueKind
  /** Dsh name / plugin name / 'plugin store'. */
  label: string
  path?: string
  missing: boolean
}

// ── node runtime detection ───────────────────────────────────────────────────

/** Which node the launcher will run dsh with, + the versions it detected. */
export interface NodeEnvironment {
  /** The app's bundled Node version (process.versions.node). */
  bundled: string
  /** A system `node` on PATH, if any. */
  system: { installed: boolean; version: string }
  /** The user's explicit choice (`'system'` = use system node when usable). */
  preference: 'system' | 'bundled'
  /** The node actually used to run dsh (after fallback if the choice is unusable). */
  prefer: 'system' | 'bundled'
}

// ── launcher self-update (GitHub releases) ───────────────────────────────────

/** One launcher GitHub release (normalised; leading `v` stripped). */
export interface AppRelease {
  /** Tag without the leading `v` (e.g. `0.2.0-beta2`). */
  tag: string
  /** Alias of `tag` kept explicit for display. */
  version: string
  /** The release page URL to open when a newer one exists. */
  url: string
  /** ISO publish timestamp, when the API provides one. */
  publishedAt?: string
}

/** Result of `app:checkUpdate`: the installed version and a newer release, if any. */
export interface AppUpdateInfo {
  current: string
  /** The highest newer release, or `null` when already up to date. */
  latest: AppRelease | null
}

// ── dsh official install ─────────────────────────────────────────────────────

/** Successful official-install payload, returned to the renderer so the dialog
 * can show the installed version + paths. */
export interface DshInstallResult {
  /** Directory name under the version repo (e.g. `official`). */
  name: string
  /** Actual npm version installed (read from the installed package.json). */
  version: string
  /** Executable path (`.bin/dsh.cmd` shim). */
  execPath: string
  /** Dedicated home (`<versionRepo>/../homes/<name>`). */
  home: string
  /** Install root directory (`<versionRepo>/<name>`). */
  dir: string
}

/** Streamed per-step progress of an official dsh install, emitted from the
 * background dsh download session (see `core/pluginDownloads.ts`) and surfaced
 * through the global download center's `steps` list. Mirrors `ImportStep`:
 * resolve the version first, then `pnpm add`, then register. */
export type DshInstallStep =
  | { kind: 'version'; state: 'running' | 'ok' | 'error'; version?: string; detail?: string }
  | { kind: 'install'; state: 'running' | 'ok' | 'error'; version?: string; detail?: string }
  | { kind: 'register'; state: 'running' | 'ok' | 'error'; version?: string; detail?: string }

/** One available update track for a managed dsh. */
export interface DshUpdateTrack {
  /** The version to install (a dist-tag value: `latest` or `next`). */
  version: string
  /** Whether this track crosses a major version from the current install
   * (breaking-change warning). */
  majorBump: boolean
}

/** Update availability for a managed dsh, from `dsh:checkUpdate`. `latest` and
 * `next` are the dist-tag tracks that are newer than the current install;
 * either may be absent. At least one is present when non-`null`. */
export interface DshUpdateInfo {
  /** Currently installed version. */
  current: string
  /** Newer stable release (dist-tag `latest`), when available. */
  latest?: DshUpdateTrack
  /** Newer prerelease (dist-tag `next`), when available; distinct from `latest`. */
  next?: DshUpdateTrack
}

/** Result of a completed in-place dsh update. */
export interface DshUpdateResult {
  /** Where the home was backed up before the update. */
  backupDir: string
  /** The version actually installed. */
  version: string
}

// ── dsh data export / migration ─────────────────────────────────────────────

/** Manifest carried inside a DSH data archive (`data-manifest.json`). */
export interface DshDataManifest {
  schemaVersion: 1
  /** The dsh version the data was exported from. */
  dshVersion: string
  /** UTC export timestamp. */
  exportedAt: string
  /** Per KV-storage-domain `version` (best-effort probe; informational for the
   * cross-version warning — the Launcher never rewrites these files). */
  storageVersions: Record<string, number>
}

/** Result of importing / mirroring DSH data. */
export interface DshDataImportResult {
  ok: boolean
  text: string
  /** True when the archive's dsh major differed from the target and was refused
   * (or explicitly acknowledged via `forceDsh`). */
  dshMismatch: boolean
}

// ── npm search ──────────────────────────────────────────────────────────────

/** One hit from the npm registry search. */
export interface NpmSearchHit {
  name: string
  description: string
  version: string
  /** Author name when the registry provides one. */
  author?: string
  /** ISO publish/update timestamp of the matched version. */
  date?: string
  keywords?: string[]
}

/** A package's downloadable versions + dist-tags (for the download picker). */
export interface PackageVersionInfo {
  /** dist-tags, e.g. `{ latest: '1.2.3' }`. */
  distTags: Record<string, string>
  /** Available version strings. */
  versions: string[]
}

// ── profile instance management ─────────────────────────────────────────────

/** List summary for one profile. */
export interface ProfileSummary {
  name: string
  bundles: number
  plugins: number
  patchRows: number
}

/** Result of a profile import — `ok` only means the profile was created. */
export interface ImportProfileResult {
  ok: boolean
  text: string
  dshMismatch: boolean
  /** bundle plugins restored into the store. */
  installed: string[]
  /** bundles that could not be downloaded (local-only, no packaged copy). */
  missing: string[]
}

/** One bundle's install origin, for display. */
export type ImportBundleSource = 'local' | 'reuse' | 'npm'

/** Streamed per-step progress of a profile import, pushed main → renderer
 * (`import:event`) so the dialog can render the steps grouped + with origin and
 * version detail: bundle installs first, then the final `pnpm install`. */
export type ImportStep =
  | { kind: 'create' }
  | {
      kind: 'bundle'
      name: string
      /** How the bundle is being fulfilled: offline pack / store reuse / npm. */
      source: ImportBundleSource
      state: 'running' | 'ok' | 'error'
      /** Resolved version once the bundle is in the store (for display). */
      version?: string
      detail?: string
    }
  | { kind: 'install'; state: 'running' | 'ok' }

// ── composed plugin lists ───────────────────────────────────────────────────

/** One composed plugin row (bundle-built, with effective disabled state). */
export interface ComboPlugin {
  /** Row id as declared by the bundle (the `- id:` value). */
  id: string
  /** Package name the row mounts (when the bundle declares one). */
  name: string
  /** Owning bundle. */
  bundle: string
  /** Effective disabled state (bundle default overridden by the user patch). */
  disabled: boolean
}

/** One store-installed plugin row (`plugins:list`). */
export interface InstalledPlugin {
  name: string
  version: string
}

// ── trash (`<profilesDir>/.trash`) ──────────────────────────────────────────

/** One soft-deleted profile sitting in the trash, for `trash:list`. */
export interface TrashItem {
  name: string
  /** Manifest `dsh.profile.bundles` layer list. */
  bundles: string[]
  /** Manifest `dependencies` names. */
  deps: string[]
  /** `cordis.patch.yml` row count. */
  patchRows: number
  /** On-disk size of the directory tree, in bytes. */
  sizeBytes: number
  /** When the profile was moved to trash (ISO), derived from the dir mtime. */
  deletedAt: string
}

// ── onboarding (first-run wizard) ────────────────────────────────────────────

/** Onboarding state + the effective default directories, for `settings:getOnboardingState`. */
export interface OnboardingState {
  /** True when a fresh install should show the wizard. */
  required: boolean
  /** The current effective defaults the wizard seeds its fields with. */
  defaults: { pluginDir: string; dshVersionDir: string }
}

/** The values the wizard saves on completion, for `settings:completeOnboarding`. */
export interface OnboardingPayload {
  uiLanguage?: string
  pluginDir?: string
  dshVersionDir?: string
  /** Preferred node for launching dsh (`'system'` | `'bundled'`). */
  nodePreference?: 'system' | 'bundled'
}

// ── community market (awesome-dsh-plugin catalog) ────────────────────────────

/**
 * One plugin entry from the curated community catalog (`/plugins.json`),
 * as published by awesome-dsh-plugin and refreshed daily by its CI.
 *
 * The `null`-vs-0 rule is load-bearing: `stars`/`downloads` of `null` mean
 * "the upstream has no value" (a coverage gap), NEVER a popularity of zero —
 * sorting must treat them as unknown, not as bottom-of-the-leaderboard.
 */
export interface MarketPlugin {
  name: string
  owner: string
  /** Canonical identity key — the GitHub repo URL. Stable across renames; the
   * unique field to use when matching installed/installed names. */
  url: string
  category: string
  /** Bilingual description, keyed by locale code (`en`/`zh`…). */
  description: Record<string, string>
  /** Published npm package name, when the repo publishes one (installation
   * prefers this over a raw GitHub download). `null`/absent → GitHub-only. */
  npm?: string | null
  /** Star count as refreshed by upstream CI (not live). `null` = unknown. */
  stars?: number | null
  /** npm downloads in the last 30 days. `null` = unknown (not zero). */
  downloads?: number | null
  /** The one-line install command the catalog prints for this plugin. */
  install: string
  /** ISO date the entry was added to the catalog. */
  added?: string
  /** Catalog-side deprecation flag; when true, `replacement` names the successor. */
  deprecated?: boolean
  /** Catalog name of the suggested replacement plugin, when deprecated. */
  replacement?: string
}

/** The whole curated catalog: categories + the plugin list. */
export interface MarketCatalog {
  /** ISO date the upstream last refreshed the list. */
  updated: string
  count: number
  /** Category id → localized label, e.g. `{ ui: { en: 'UI', zh: 'UI 增强' } }`. */
  categories: Record<string, Record<string, string>>
  plugins: MarketPlugin[]
}

/** Which origin the market catalog is loaded from — a user-chosen pipeline. */
export type MarketSource = 'official' | 'custom'

/** The market's current loading route + any custom URL, for the UI picker. */
export interface MarketSourceState {
  source: MarketSource
  /** Custom `plugins.json` URL, only meaningful when `source === 'custom'`. */
  url: string
}

/** Sort orders for the market list. */
export type MarketSort = 'stars' | 'downloads' | 'newest'

/** One page of the market list, filtered + sorted + sliced in the main process.
 *
 * The market is paginated end-to-end so the first paint never pulls or renders
 * the whole catalog: `market:list` applies the query (q/category/sort), then
 * hands back `pageSize` items + a `total` to drive the pagination control. */
export interface MarketPage {
  /** ISO date the upstream last refreshed the catalog. */
  updated: string
  /** Matched plugins after the filter, BEFORE slicing — the pagination total. */
  total: number
  /** Category id → localized label, re-sent so the filter dropdown survives a reload. */
  categories: Record<string, Record<string, string>>
  /** The rows on this page. */
  items: MarketPlugin[]
  /** 1-based page actually served (clamped into [1, lastPage]). */
  page: number
  pageSize: number
}

/** Query + pagination for `market:list`. Everything except `source` narrows the
 * rows before slicing; `source` selects the loading route. */
export interface MarketListOpts {
  source?: MarketSourceState
  /** Force a network revalidation. When omitted/false, the main process serves
   * the memoized catalog for the route — so pagination, search and sort become
   * instant local slices. Pass true for a manual refresh / on a failed first load. */
  refresh?: boolean
  page?: number
  pageSize?: number
  /** Free-text search across name / owner / npm / descriptions. */
  q?: string
  /** Category id to restrict to; empty/absent = all. */
  category?: string
  sort?: MarketSort
}

// ── MCP servers (dsh `@deepseek-ai/dsh-mcp-client` patch rows) ───────────────

/**
 * Which patch layer an MCP row was found in. dsh composes layers in this order
 * and lets a later layer override an earlier one by row id:
 *   bundles → profile → home → `--patch` overlays
 * so `home` outranks `profile`. Kept explicit (not just a display string) so a
 * toggle writes back into the very file the row came from.
 */
export type McpLayer = 'home' | 'profile'

/** One configured MCP server, read from a dsh patch layer. */
export interface McpServerRow {
  /** Patch row id (the `- id:` value) — the write-back key. */
  id: string
  /** `serverName` from the row config — the model-facing namespace. */
  serverName: string
  /** Mounted plugin package name (normally `@deepseek-ai/dsh-mcp-client`). */
  plugin: string
  transport?: string
  command?: string
  args: string[]
  url?: string
  /** Which layer this row lives in — also where a toggle writes. */
  layer: McpLayer
  /** Profile name when `layer === 'profile'`. */
  profile?: string
  /** Absolute path of the patch file holding this row. */
  file: string
  /** Whether the row is disabled in its own layer. */
  disabled: boolean
  /**
   * Set when ANOTHER block in the SAME file carries this id later, so dsh resolves
   * that one instead and this block's own `disabled` is not what takes effect.
   * Some writers disable a row by appending a fresh one rather than editing it, so
   * the Launcher must not present the first block as the live state nor aim a
   * toggle at it.
   */
  overriddenByLater?: boolean
  /**
   * Set when the HOME layer mounts the same `serverName`, so this profile row is
   * overridden and never takes effect. Two different profiles never shadow each
   * other — only one profile is loaded at a time.
   */
  shadowedBy?: { layer: McpLayer; profile?: string; id: string }
}

/** One patch layer file the scan touched. */
export interface McpLayerFile {
  layer: McpLayer
  profile?: string
  path: string
  exists: boolean
}

/** Result of one MCP scan across the active dsh's layers. */
export interface McpScanResult {
  rows: McpServerRow[]
  /** Patch files that were read, for display. */
  files: McpLayerFile[]
  /** True when the home layer file does not exist yet. */
  homeMissing: boolean
  /** The home layer's patch path — the target of a "create it" action. */
  homePath: string
  /** Profile names that actually have a patch file, for the profile picker. */
  profiles: string[]
  /** The active dsh's name + id, so the UI can label what it is showing. */
  dsh: { id: string; name: string } | null
  /** The profile the user marked as current for this dsh, when it still exists. */
  activeProfile?: string
  /**
   * True when the home path was derived from a fallback (`$DSH_HOME` / `~/.dsh`)
   * rather than a registered dsh. Creating the file there is unstable — picking
   * a dsh later moves the real home — so the UI must not offer to create it.
   */
  homePathProvisional: boolean
}

/** A toggle target: which layer + file + row to flip. */
export interface McpToggleTarget {
  layer: McpLayer
  profile?: string
  id: string
}

/** One MCP server to create, as the add form collects it. */
export interface McpAddInput {
  /** Target layer: the shared (home) layer, or one profile's own layer. */
  layer: McpLayer
  profile?: string
  /** Patch row id (the `- id:` value). Defaults to a slug of `serverName`. */
  id?: string
  serverName: string
  transport: string
  /** stdio only. */
  command?: string
  args?: string[]
  env?: Record<string, string>
  /** http/sse only. */
  url?: string
  /** Create the row disabled instead of enabled. */
  disabled?: boolean
}

/** Result of converting a Claude-format MCP config into dsh rows. */
export interface McpImportPreview {
  /** Rows that could be converted, ready to write. */
  servers: McpAddInput[]
  /** Entries that were skipped, with the reason (e.g. unsupported transport). */
  skipped: { name: string; reason: string }[]
  /** Set when the input could not be parsed at all. */
  error?: string
}

// ── Skills (dsh `@deepseek-ai/dsh-skill-filesystem` roots) ───────────────────

/**
 * A skill discovery root, mirroring dsh's own `dsh-skill-filesystem` ranks.
 * Lower rank wins WITHIN one layer; across layers dsh's "nearest layer wins"
 * rule applies. `preset` is dsh's `custom` source (rank 300), contributed by an
 * agent preset's `customSkillDirs`.
 */
/**
 * Origin bucket for a skill contribution. These are dsh's OWN `Source` ids from
 * `docs/subsystems/skills.md`, spelled the same way so the Launcher's labels
 * match what dsh resolves. `custom` is `Config.customSkillDirs` (rank 300); a
 * preset contributes through it, which is why the row also carries `origin`.
 */
export type SkillSource =
  | 'project-dsh'
  | 'project-agents'
  | 'custom'
  | 'user-dsh'
  | 'user-agents'
  | 'bundled'

/** One discovered skill (a `<name>/SKILL.md` bundle, or a flat `<name>.md`). */
export interface SkillRow {
  name: string
  /** Absolute path of the skill's directory (bundle) or file (flat). */
  path: string
  source: SkillSource
  rank: number
  /** Human-facing description from the frontmatter, when present. */
  description?: string
  /** True when the frontmatter sets `disable-model-invocation: true`. */
  modelInvocable: boolean
  /** Whose directory this came from when the source alone is ambiguous — the
   * preset's name for `preset`, so the UI can say which preset ships it. */
  origin?: string
  /** Set when a nearer layer holds the same name — this row does not take effect. */
  shadowedBy?: { name: string; source: SkillSource; rank: number; path: string; origin?: string }
}

/** One skill root that was scanned, with its rank + how many skills it yielded. */
export interface SkillRootInfo {
  source: SkillSource
  rank: number
  path: string
  exists: boolean
  count: number
  /** The preset (or other owner) this root belongs to, when known. */
  origin?: string
}

/** Result of one skill scan across every root dsh would read. */
export interface SkillScanResult {
  rows: SkillRow[]
  roots: SkillRootInfo[]
  /** Skills whose name is claimed by a nearer layer (not effective). */
  shadowedCount: number
}

/**
 * State of the active dsh's global instruction file (`$DSH_HOME/AGENTS.md`).
 *
 * dsh loads this one fixed filename for every session under the home and
 * prepends it to each project's own instruction chain, so it is the only
 * user-level config the Launcher can edit without a workspace path.
 */
export interface RuleFile {
  path: string
  exists: boolean
  bytes?: number
  /** ISO timestamp of the last write, when the file exists. */
  modified?: string
  /** dsh's per-file cap; a larger file is ignored entirely rather than truncated. */
  sourceLimit: number
  /** The preset default budget. A profile/home row may override it, so this is a
   * reference figure for the usage hint, not a claim about the resolved value. */
  budget: number
}
