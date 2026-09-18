/** Tests for skill scanning: root ranks, bundle vs flat discovery, frontmatter
 * gating, and the shadowing computation dsh itself only logs.
 *
 * Roots are driven by env vars dsh also honours (`DSH_AGENTS_HOME`,
 * `DSH_BUNDLED_SKILL_DIR`) plus the active dsh home, so a temp home + a temp
 * agents dir fully isolate the scan from the real machine. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, saveSettings } from './settings.ts'
import { readSkillBody, scanSkills } from './skill.ts'
import type { DshEntry } from '../../shared/types.ts'

let root: string
let home: string
let agents: string
let bundled: string
let profiles: string

const ENTRY: DshEntry = {
  id: 'dsh-a', name: 'dsh@a', execPath: join('C:', 'x', 'dsh.cmd'), version: '1.0.0',
  home: '', managed: true,
}

/** Write a directory-bundle skill (`<name>/SKILL.md`). */
function writeSkill(base: string, name: string, frontmatter: string, body = '# Body'): void {
  const dir = join(base, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}\n`)
}

/** Write a flat skill (`<name>.md`). */
function writeFlatSkill(base: string, name: string, frontmatter: string): void {
  mkdirSync(base, { recursive: true })
  writeFileSync(join(base, `${name}.md`), `---\n${frontmatter}\n---\n\n# Body\n`)
}

const prevAgents = process.env.DSH_AGENTS_HOME
const prevBundled = process.env.DSH_BUNDLED_SKILL_DIR

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pm-skill-'))
  home = join(root, 'home')
  agents = join(root, 'agents')
  bundled = join(root, 'bundled')
  profiles = join(home, 'profiles')
  mkdirSync(profiles, { recursive: true })
  await openDatabase(join(root, 'app.sqlite'))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  if (prevAgents === undefined) delete process.env.DSH_AGENTS_HOME
  else process.env.DSH_AGENTS_HOME = prevAgents
  if (prevBundled === undefined) delete process.env.DSH_BUNDLED_SKILL_DIR
  else process.env.DSH_BUNDLED_SKILL_DIR = prevBundled
})

beforeEach(() => {
  for (const dir of [join(home, 'skills'), join(agents, 'skills'), bundled, join(home, '.agent-presets')]) {
    rmSync(dir, { recursive: true, force: true })
  }
  process.env.DSH_AGENTS_HOME = agents
  delete process.env.DSH_BUNDLED_SKILL_DIR
  saveSettings({ dshes: [{ ...ENTRY, home }], activeDshId: 'dsh-a' })
})

afterEach(() => { delete process.env.DSH_BUNDLED_SKILL_DIR })

describe('scanSkills', () => {
  it('discovers a directory-bundle skill from the user-agents root (rank 500)', () => {
    writeSkill(join(agents, 'skills'), 'brainstorming', 'name: brainstorming\ndescription: A skill')
    const { rows } = scanSkills()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ name: 'brainstorming', source: 'user-agents', rank: 500, description: 'A skill', modelInvocable: true })
  })

  it('discovers a flat <name>.md skill', () => {
    writeFlatSkill(join(agents, 'skills'), 'flat-one', 'name: flat-one\ndescription: flat')
    expect(scanSkills().rows.map(r => r.name)).toEqual(['flat-one'])
  })

  it('reads the user-dsh root (rank 400) and skips its .system entry', () => {
    writeSkill(join(home, 'skills'), 'local-a', 'name: local-a')
    writeSkill(join(home, 'skills', '.system'), 'hidden', 'name: hidden')
    const { rows } = scanSkills()
    expect(rows.map(r => r.name)).toEqual(['local-a'])
    expect(rows[0].source).toBe('user-dsh')
  })

  it('honours DSH_BUNDLED_SKILL_DIR (rank 600)', () => {
    process.env.DSH_BUNDLED_SKILL_DIR = bundled
    writeSkill(bundled, 'shipped-a', 'name: shipped-a')
    const rows = scanSkills().rows
    expect(rows.map(r => `${r.source}:${r.rank}`)).toEqual(['bundled:600'])
  })

  it('finds a preset-local skills/ directory (rank 300)', () => {
    const preset = join(home, '.agent-presets', 'my-preset')
    writeSkill(join(preset, 'skills'), 'preset-a', 'name: preset-a')
    writeFileSync(join(preset, 'agent.cordis.yml'), ['- id: p', '  name: x', ''].join('\n'))
    const rows = scanSkills().rows
    expect(rows.map(r => `${r.source}:${r.name}`)).toEqual(['custom:preset-a'])
  })

  it('names WHICH preset contributed a skill, on the row and the root', () => {
    // "Preset 自带" alone cannot tell two presets apart, so the owning preset
    // travels with the row and the root for the UI to show.
    const preset = join(home, '.agent-presets', 'named-preset')
    writeSkill(join(preset, 'skills'), 'from-named', 'name: from-named')
    const { rows, roots } = scanSkills()
    expect(rows[0].origin).toBe('named-preset')
    expect(roots.find(r => r.source === 'custom')?.origin).toBe('named-preset')
  })

  it('leaves origin unset for roots that are not preset-owned', () => {
    writeSkill(join(agents, 'skills'), 'plain', 'name: plain')
    expect(scanSkills().rows[0].origin).toBeUndefined()
  })

  it('reads customSkillDirs off a preset composition, skipping a !!js entry', () => {
    const preset = join(home, '.agent-presets', 'p2')
    mkdirSync(preset, { recursive: true })
    const extra = join(root, 'extra-skills')
    writeSkill(extra, 'extra-a', 'name: extra-a')
    writeFileSync(join(preset, 'agent.cordis.yml'), [
      '- id: skill-filesystem',
      '  name: "@deepseek-ai/dsh-skill-filesystem"',
      '  config:',
      '    customSkillDirs:',
      `      - ${extra.replace(/\\/g, '/')}`,
      '      - !!js someExpression',
      '',
    ].join('\n'))
    const names = scanSkills().rows.map(r => r.name)
    expect(names).toEqual(['extra-a'])
  })

  it('ignores a directory with no SKILL.md and a non-md file', () => {
    mkdirSync(join(agents, 'skills', 'empty-dir'), { recursive: true })
    mkdirSync(join(agents, 'skills'), { recursive: true })
    writeFileSync(join(agents, 'skills', 'notes.txt'), 'not a skill')
    expect(scanSkills().rows).toHaveLength(0)
  })

  it('ignores a SKILL.md with no frontmatter block', () => {
    const dir = join(agents, 'skills', 'no-fm')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '# Just a heading\n')
    expect(scanSkills().rows).toHaveLength(0)
  })

  it('ignores frontmatter without a name', () => {
    writeSkill(join(agents, 'skills'), 'nameless', 'description: no name here')
    expect(scanSkills().rows).toHaveLength(0)
  })

  it('marks modelInvocable false when disable-model-invocation is true', () => {
    writeSkill(join(agents, 'skills'), 'manual-only', 'name: manual-only\ndisable-model-invocation: true')
    expect(scanSkills().rows[0].modelInvocable).toBe(false)
  })

  it('shadows a farther skill with the same name (nearest layer wins)', () => {
    writeSkill(join(home, 'skills'), 'dup', 'name: dup\ndescription: nearer')
    writeSkill(join(agents, 'skills'), 'dup', 'name: dup\ndescription: farther')
    const { rows, shadowedCount } = scanSkills()
    expect(rows).toHaveLength(2)
    expect(shadowedCount).toBe(1)
    const near = rows.find(r => r.source === 'user-dsh')!
    const far = rows.find(r => r.source === 'user-agents')!
    expect(near.shadowedBy).toBeUndefined()
    expect(far.shadowedBy).toMatchObject({ source: 'user-dsh', rank: 400 })
  })

  it('does not shadow across different names', () => {
    writeSkill(join(home, 'skills'), 'a', 'name: a')
    writeSkill(join(agents, 'skills'), 'b', 'name: b')
    expect(scanSkills().shadowedCount).toBe(0)
  })

  it('reports every root with its rank and existence', () => {
    writeSkill(join(agents, 'skills'), 'one', 'name: one')
    const { roots } = scanSkills()
    const bySource = new Map(roots.map(r => [r.source, r]))
    expect(bySource.get('user-agents')).toMatchObject({ rank: 500, exists: true, count: 1 })
    expect(bySource.get('user-dsh')).toMatchObject({ rank: 400, exists: false, count: 0 })
    // ranks ascend — composition order
    expect(roots.map(r => r.rank)).toEqual([...roots.map(r => r.rank)].sort((a, b) => a - b))
  })

  it('scans the SHIPPED presets inside the dsh install, not just the user\'s own', () => {
    // The built-in `cordis` preset keeps its skills in the package that travels
    // with dsh. `DSH_BUNDLED_SKILL_DIR` is unset in a normal install, so before
    // this the shipped skills appeared in NO layer at all.
    const install = join(root, 'fakeinstall')
    const anchorPkg = join(install, 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(anchorPkg, { recursive: true })
    writeFileSync(join(anchorPkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' }))
    const shipped = join(
      install, 'node_modules', '.pnpm', 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets',
    )
    writeSkill(join(shipped, 'cordis', 'skills'), 'shipped-skill', 'name: shipped-skill')
    saveSettings({
      dshes: [{ ...ENTRY, home, execPath: join(anchorPkg, 'lib', 'bin.js') }],
      activeDshId: 'dsh-a',
    })

    const rows = scanSkills().rows
    expect(rows.map(r => `${r.source}:${r.name}`)).toEqual(['custom:shipped-skill'])
  })

  it('ignores a shipped preset with no skills/ directory', () => {
    const install = join(root, 'fakeinstall2')
    const anchorPkg = join(install, 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(anchorPkg, { recursive: true })
    writeFileSync(join(anchorPkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' }))
    const shipped = join(
      install, 'node_modules', '.pnpm', 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets',
    )
    // `minimal` ships a composition but no skills — it must contribute nothing.
    mkdirSync(join(shipped, 'minimal'), { recursive: true })
    writeFileSync(join(shipped, 'minimal', 'agent.cordis.yml'), '- id: p\n  name: x\n')
    saveSettings({
      dshes: [{ ...ENTRY, home, execPath: join(anchorPkg, 'lib', 'bin.js') }],
      activeDshId: 'dsh-a',
    })
    expect(scanSkills().rows).toHaveLength(0)
  })
})

describe('readSkillBody', () => {
  it('strips the frontmatter and returns the body', () => {
    writeSkill(join(agents, 'skills'), 'body-a', 'name: body-a', '# Heading\n\ntext here')
    const row = scanSkills().rows[0]
    const { content, file } = readSkillBody(row.path)
    expect(file.endsWith('SKILL.md')).toBe(true)
    expect(content).toContain('# Heading')
    expect(content).toContain('text here')
    expect(content).not.toContain('name: body-a')
  })
})
