/**
 * Skill discovery: read every root dsh's `dsh-skill-filesystem` provider would
 * scan, and compute which skills are shadowed.
 *
 * The ranks below mirror that provider's own constants, so the list the Launcher
 * shows matches what a running dsh resolves:
 *
 *   rank 100  project-dsh     <项目>/.dsh/skills      — NOT scanned (see below)
 *   rank 200  project-agents  <项目>/.agents/skills   — NOT scanned (see below)
 *   rank 300  preset          an agent preset's `customSkillDirs` / its `skills/`
 *   rank 400  user-dsh        $DSH_HOME/skills
 *   rank 500  user-agents     ~/.agents/skills  (or $DSH_AGENTS_HOME)
 *   rank 600  bundled         $DSH_BUNDLED_SKILL_DIR
 *
 * Two ORTHOGONAL dimensions decide a root, and the UI labels name both (scope
 * first) so the four user/project x dsh/agents cells are not confused for one
 * flat list:
 *   - scope:   project (this workspace only) vs user (every project, this machine)
 *   - system:  `.dsh` (dsh's own config root) vs `.agents` (the SHARED agent config
 *              root — dsh's own field comment calls it exactly that, and the
 *              installer's list of the agents that read it is `lastSelectedAgents`,
 *              covering Claude Code, Cursor, Codex and others). A skill placed in
 *              `~/.agents/skills` is therefore NOT dsh-only.
 * Hence the labels read "用户 · DSH 专属" and "用户 · 多 Agent 共享" — the scope
 * plus who owns the directory, rather than two bare directory names.
 *
 * The two project-level roots need a workspace cwd, which the Launcher has no
 * notion of (it manages configs, not a working directory). They are deliberately
 * NOT emitted rather than guessed at: a wrong guess would report skills that do
 * not apply. The UI states this instead of showing a bogus layer.
 *
 * For rank 300 the provider's `customSkillDirs` usually comes from a `!!js`
 * expression that resolves at mount time; the conventional `skills/` sibling is
 * found structurally instead, which covers the shipped presets.
 *
 * Precedence: across layers the nearest one wins outright; within one layer the
 * lower rank wins. dsh only logs a shadowed skill, so the conflict is computed
 * here from the same rules.
 *
 * dsh has NO skill enable/disable switch — the only thing it honours is the
 * frontmatter `disable-model-invocation`, and that merely stops the model from
 * invoking a skill automatically. So this module is read-only by design.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import os from 'node:os'
import { load as loadYaml } from 'js-yaml'
import { dshHome, installAnchor } from './home.ts'
import { child } from './logger.ts'
import type { SkillRootInfo, SkillRow, SkillScanResult, SkillSource } from '../../shared/types.ts'

/** Domain-tagged logger for skill scanning. */
const slog = child('skill')

/** Rank of each source, mirroring `dsh-skill-filesystem`. */
const RANKS: Record<SkillSource, number> = {
  'project-dsh': 100,
  'project-agents': 200,
  custom: 300,
  'user-dsh': 400,
  'user-agents': 500,
  bundled: 600,
}

/** One root to scan: where it is, which source/rank it carries. */
interface Root {
  source: SkillSource
  rank: number
  path: string
  /** `user-dsh` skips a `.system` entry, mirroring the provider. */
  skipSystem?: boolean
  /** Whose directory this is, when that is more specific than the source alone
   * (a preset's name, so "Preset 自带" can say WHICH preset). Shown in the UI. */
  origin?: string
}

/** The `~/.agents` root (or `$DSH_AGENTS_HOME`). */
function agentsHome(): string {
  const env = process.env.DSH_AGENTS_HOME
  return env !== undefined && env.trim() !== '' ? env : join(os.homedir(), '.agents')
}

/**
 * Every root dsh would scan for the ACTIVE dsh home.
 *
 * The two project-level roots are NOT emitted: they need a workspace cwd, which
 * the Launcher has no notion of, and a guessed path would report skills that do
 * not apply. The UI explains their absence instead.
 */
function skillRoots(): Root[] {
  const home = dshHome()
  const roots: Root[] = [
    { source: 'user-dsh', rank: RANKS['user-dsh'], path: join(home, 'skills'), skipSystem: true },
    { source: 'user-agents', rank: RANKS['user-agents'], path: join(agentsHome(), 'skills') },
  ]
  const bundled = process.env.DSH_BUNDLED_SKILL_DIR
  if (bundled !== undefined && bundled.trim() !== '') {
    roots.push({ source: 'bundled', rank: RANKS.bundled, path: bundled })
  }
  // A preset contributes skills through `customSkillDirs` (dsh's `custom`
  // source, rank 300): the user's own presets under `<home>/.agent-presets`,
  // plus the ones shipped inside `dsh-agent-presets/presets`.
  roots.push(...presetRoots(home, installAnchor()))
  return roots.sort((a, b) => a.rank - b.rank)
}

/**
 * Preset-contributed skill dirs.
 *
 * Two kinds of preset carry skills, and both resolve through `presetRoots`:
 *   - the user's own presets under `<home>/.agent-presets/<name>/`;
 *   - the ones SHIPPED inside `@deepseek-ai/dsh-agent-presets/presets/<name>/`,
 *     which is where the built-in `cordis` preset keeps its two skills.
 *
 * Missing the shipped ones was a real gap: `DSH_BUNDLED_SKILL_DIR` is unset in
 * a normal install (nothing in dsh sets it), so those skills appeared in NO
 * layer at all even though a running dsh loads them.
 */
function presetRoots(home: string, anchor: string | undefined): Root[] {
  const bases = [join(home, '.agent-presets')]
  for (const shipped of shippedPresetDirs(anchor)) bases.push(shipped)
  const roots: Root[] = []
  for (const base of bases) {
    if (!existsSync(base)) continue
    for (const entry of safeReaddir(base)) {
      if (!entry.isDirectory()) continue
      const dir = join(base, entry.name)
      // The conventional location: a preset ships its skills beside its composition.
      const local = join(dir, 'skills')
      if (existsSync(local)) {
        roots.push({ source: 'custom', rank: RANKS.custom, path: local, origin: entry.name })
      }
      // Explicit customSkillDirs declared on the composition row.
      for (const declared of declaredSkillDirs(join(dir, 'agent.cordis.yml'))) {
        if (declared !== local) roots.push({ source: 'custom', rank: RANKS.custom, path: declared, origin: entry.name })
      }
    }
  }
  return roots
}

/**
 * The shipped presets directory, resolved from the active dsh's install anchor.
 *
 * The package sits in the pnpm virtual store rather than at a fixed top-level
 * path, so it is found by walking up from the anchor into each `node_modules`
 * and looking for `@deepseek-ai/dsh-agent-presets/presets`.
 */
function shippedPresetDirs(anchor: string | undefined): string[] {
  if (anchor === undefined) return []
  const rel = join('@deepseek-ai', 'dsh-agent-presets', 'presets')
  let cur = anchor
  for (let i = 0; i < 8; i++) {
    const direct = join(cur, 'node_modules', rel)
    if (existsSync(direct)) return [direct]
    // pnpm hoists the real package under `<store>/node_modules/`.
    const viaPnpm = join(cur, 'node_modules', '.pnpm', 'node_modules', rel)
    if (existsSync(viaPnpm)) return [viaPnpm]
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return []
}

/** Read `customSkillDirs` off a preset composition.
 *
 * Deliberately NOT a YAML parse: a preset composition legitimately carries
 * cordis `!!js` expression tags, which js-yaml rejects without cordis's own
 * custom schema. The conventional `skills/` sibling is found structurally
 * instead, and this only picks up plain-string dir entries. */
function declaredSkillDirs(file: string): string[] {
  if (!existsSync(file)) return []
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const out: string[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*customSkillDirs\s*:/.test(lines[i])) continue
    const baseIndent = /^(\s*)/.exec(lines[i])?.[1].length ?? 0
    // A flow list on the key line: customSkillDirs: ["a", "b"]
    const inline = /customSkillDirs\s*:\s*\[(.*)\]\s*$/.exec(lines[i])
    if (inline !== null) {
      for (const m of inline[1].matchAll(/["']([^"']+)["']/g)) out.push(m[1])
      continue
    }
    // A block list: each `- <path>` deeper than the key.
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]
      if (line.trim() === '' || line.trim().startsWith('#')) continue
      const indent = /^(\s*)/.exec(line)?.[1].length ?? 0
      if (indent <= baseIndent) break
      const item = /^\s*-\s+(.+?)\s*$/.exec(line)
      if (item === null) continue
      // Strip quotes; skip a `!!js` expression (resolved at mount, not a path).
      const value = item[1].replace(/^["']|["']$/g, '').trim()
      if (value === '' || value.startsWith('!!') || value.startsWith('!')) continue
      out.push(value)
    }
  }
  return out
}

/** `readdirSync` that yields [] instead of throwing on a missing/unreadable dir. */
function safeReaddir(dir: string): { name: string; isDirectory: () => boolean; isFile: () => boolean }[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** Frontmatter fields this module reads. */
interface Frontmatter {
  name: string
  description?: string
  modelInvocable: boolean
}

/**
 * Parse a `SKILL.md` frontmatter block the way dsh does: the file must open
 * with a `---` line and close with another; the block must parse to a mapping
 * carrying `name`. Returns undefined for anything dsh itself would ignore.
 */
function readFrontmatter(file: string): Frontmatter | undefined {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return undefined
  if (raw.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') return undefined
  let lineStart = firstLineEnd + 1
  let closeStart = -1
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    if (raw.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') { closeStart = lineStart; break }
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
  if (closeStart < 0) return undefined
  let parsed: unknown
  try {
    parsed = loadYaml(raw.slice(firstLineEnd + 1, closeStart))
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const data = parsed as Record<string, unknown>
  const name = typeof data.name === 'string' ? data.name.trim() : ''
  if (name === '') return undefined
  return {
    name,
    ...(typeof data.description === 'string' && data.description !== '' ? { description: data.description } : {}),
    // dsh: modelInvocable is false only when `disable-model-invocation` is true.
    modelInvocable: data['disable-model-invocation'] !== true,
  }
}

/** Discover every skill under one root, mirroring the provider's entry rules. */
function discoverRoot(root: Root): SkillRow[] {
  const rows: SkillRow[] = []
  for (const entry of safeReaddir(root.path).sort((a, b) => a.name.localeCompare(b.name))) {
    if (root.skipSystem === true && entry.name === '.system') continue
    // A directory skill is `<dir>/SKILL.md`; a flat skill is `<name>.md`.
    const isBundle = entry.isDirectory()
    if (!isBundle && !(entry.isFile() && entry.name.endsWith('.md'))) continue
    const file = isBundle ? join(root.path, entry.name, 'SKILL.md') : join(root.path, entry.name)
    if (!existsSync(file)) continue
    const fm = readFrontmatter(file)
    if (fm === undefined) continue
    rows.push({
      name: fm.name,
      path: isBundle ? join(root.path, entry.name) : file,
      source: root.source,
      rank: root.rank,
      ...(fm.description !== undefined ? { description: fm.description } : {}),
      modelInvocable: fm.modelInvocable,
      ...(root.origin !== undefined ? { origin: root.origin } : {}),
    })
  }
  return rows
}

/**
 * Scan every skill root and mark the shadowed rows.
 *
 * A row is shadowed when a NEARER layer (lower rank) claims the same name — dsh
 * merges nearest-layer-first and lets that entry win outright, so the farther
 * row never takes effect.
 */
export function scanSkills(): SkillScanResult {
  const roots = skillRoots()
  const rootInfos: SkillRootInfo[] = []
  const all: SkillRow[] = []
  for (const root of roots) {
    const exists = existsSync(root.path)
    let count = 0
    if (exists) {
      try {
        const found = discoverRoot(root)
        all.push(...found)
        count = found.length
      } catch (error) {
        slog.warn(`skill root ${root.path}: scan failed (${error instanceof Error ? error.message : String(error)})`)
      }
    }
    rootInfos.push({
      source: root.source, rank: root.rank, path: root.path, exists, count,
      ...(root.origin !== undefined ? { origin: root.origin } : {}),
    })
  }

  // Winner per name = the lowest rank. Ties (same rank) keep the first seen.
  const winner = new Map<string, SkillRow>()
  for (const row of all) {
    const current = winner.get(row.name)
    if (current === undefined || row.rank < current.rank) winner.set(row.name, row)
  }
  const rows = all.map(row => {
    const best = winner.get(row.name)
    if (best === undefined || best === row) return row
    return {
      ...row,
      shadowedBy: {
        name: best.name, source: best.source, rank: best.rank, path: best.path,
        ...(best.origin !== undefined ? { origin: best.origin } : {}),
      },
    }
  }).sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))

  return {
    rows,
    roots: rootInfos,
    shadowedCount: rows.filter(r => r.shadowedBy !== undefined).length,
  }
}

/** Read one skill's `SKILL.md` body (frontmatter stripped) for the detail view. */
export function readSkillBody(path: string): { content: string; file: string } {
  const file = statSync(path).isDirectory() ? join(path, 'SKILL.md') : path
  const raw = readFileSync(file, 'utf8')
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd >= 0 && raw.slice(0, firstLineEnd).replace(/\r$/, '') === '---') {
    let lineStart = firstLineEnd + 1
    while (lineStart <= raw.length) {
      const nextNewline = raw.indexOf('\n', lineStart)
      const lineEnd = nextNewline < 0 ? raw.length : nextNewline
      if (raw.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') {
        return { content: raw.slice(nextNewline < 0 ? raw.length : nextNewline + 1), file }
      }
      if (nextNewline < 0) break
      lineStart = nextNewline + 1
    }
  }
  return { content: raw, file }
}
