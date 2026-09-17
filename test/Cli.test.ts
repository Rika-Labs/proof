import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { describe, expect, it, afterEach } from "vitest"
import { findRulesFile, isRuleArray, loadRules, RULES_FILENAME } from "../src/cli.ts"
import { noul } from "../src/Rule.ts"

describe("isRuleArray", () => {
  it("accepts rule arrays", () => {
    expect(isRuleArray([noul({ id: "x", statement: "s" })])).toBe(true)
  })

  it("rejects empty arrays and junk", () => {
    expect(isRuleArray([])).toBe(false)
    expect(isRuleArray({ not: "rules" })).toBe(false)
    expect(isRuleArray([{ id: "x" }])).toBe(false)
    expect(isRuleArray("nope")).toBe(false)
  })
})

describe("findRulesFile", () => {
  const root = join(tmpdir(), "proof-find-rules")
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it("finds the file in the start directory", () => {
    mkdirSync(join(root, "a"), { recursive: true })
    writeFileSync(join(root, "a", RULES_FILENAME), "export default []\n")
    expect(findRulesFile(join(root, "a"))).toBe(join(root, "a", RULES_FILENAME))
  })

  it("walks up to parent directories", () => {
    mkdirSync(join(root, "b", "nested", "deeper"), { recursive: true })
    writeFileSync(join(root, "b", RULES_FILENAME), "export default []\n")
    expect(findRulesFile(join(root, "b", "nested", "deeper"))).toBe(join(root, "b", RULES_FILENAME))
  })

  it("returns undefined when none exists on the path", () => {
    mkdirSync(join(root, "c"), { recursive: true })
    expect(findRulesFile(join(root, "c"))).toBeUndefined()
  })
})

describe("loadRules", () => {
  it("loads an explicit rule file", async () => {
    const fromFile = await Effect.runPromise(loadRules("test/fixtures/rules-valid.ts"))
    expect(fromFile.map((r) => r.id)).toContain("test/rule")
  })

  it("discovers ./proof.rules.ts from the repo root when path is empty", async () => {
    // vitest runs with cwd = repo root, where proof.rules.ts exists
    const discovered = await Effect.runPromise(loadRules(""))
    expect(discovered.length).toBeGreaterThan(0)
  })

  it("fails on invalid rule files and missing paths", async () => {
    await expect(Effect.runPromise(loadRules("test/fixtures/rules-invalid.ts"))).rejects.toThrow(
      /must default-export/,
    )
    await expect(Effect.runPromise(loadRules("test/fixtures/does-not-exist.ts"))).rejects.toThrow(
      /cannot load/,
    )
  })
})
