/**
 * Regression guard for the js-yaml import shape.
 *
 * `js-yaml@5` ships no default export in its ESM build, so `import yaml from
 * 'js-yaml'` yields `undefined` and every `yaml.load(...)` call throws
 * "Cannot read properties of undefined (reading 'load')". That silently broke
 * patch validation (any config was reported as invalid YAML) until the imports
 * were switched to named ones. This test fails if a default import creeps back.
 */
import { describe, expect, it } from 'vitest'
import * as ns from 'js-yaml'

describe('js-yaml import shape', () => {
  it('exposes load as a named export', () => {
    expect(typeof ns.load).toBe('function')
  })

  it('has NO default export (a default import would be undefined)', () => {
    expect('default' in ns).toBe(false)
  })

  it('loads a plain mapping with the named import', () => {
    expect(ns.load('a: 1')).toEqual({ a: 1 })
  })
})
