import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { isRuleArray, loadRules } from "../src/cli.ts"
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

describe("loadRules", () => {
  it("loads a rule file, falling back to preset when empty", async () => {
    const fromFile = await Effect.runPromise(loadRules("test/fixtures/rules-valid.ts"))
    expect(fromFile.map((r) => r.id)).toContain("test/rule")
    const preset = await Effect.runPromise(loadRules(""))
    expect(preset.map((r) => r.id)).toContain("effect/no-throw")
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
