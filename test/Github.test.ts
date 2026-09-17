import { describe, expect, it } from "vitest"
import { commentBodyFor, markerFor, partitionNew, targetFromEnv } from "../src/Github.ts"
import { firstAddedLine } from "../src/Review.ts"
import type { Flag } from "../src/Review.ts"

const flag = (overrides?: Partial<Flag>): Flag => ({
  ruleId: "effect/no-throw",
  file: "src/A.ts",
  confidence: 0.9,
  severity: "request-changes",
  detail: "Violates effect/no-throw (noul 0.90)",
  line: 12,
  ...overrides,
})

describe("firstAddedLine", () => {
  it("finds the first added line honoring the hunk header offset", () => {
    const chunk = [
      "diff --git a/src/A.ts b/src/A.ts",
      "@@ -10,4 +20,5 @@",
      " context",
      "- removed",
      "+ added-one",
      "+ added-two",
    ].join("\n")
    expect(firstAddedLine(chunk)).toBe(21)
  })

  it("returns undefined for pure deletions", () => {
    const chunk = ["@@ -10,3 +10,2 @@", " context", "- gone", " more"].join("\n")
    expect(firstAddedLine(chunk)).toBeUndefined()
  })

  it("returns undefined without hunk headers", () => {
    expect(firstAddedLine("+ throw x")).toBeUndefined()
  })
})

describe("comment markers", () => {
  it("embeds a stable marker for dedupe", () => {
    expect(markerFor("effect/no-throw")).toBe("<!-- proof:effect/no-throw -->")
    expect(commentBodyFor(flag())).toContain("<!-- proof:effect/no-throw -->")
    expect(commentBodyFor(flag())).toContain("effect/no-throw")
  })
})

describe("partitionNew", () => {
  it("skips already-commented path+line+rule", () => {
    const { fresh, skipped } = partitionNew(
      [flag(), flag({ ruleId: "other", line: 13 })],
      [{ path: "src/A.ts", line: 12, body: `note\n${markerFor("effect/no-throw")}` }],
    )
    expect(fresh.map((f) => f.ruleId)).toEqual(["other"])
    expect(skipped).toBe(1)
  })

  it("keeps same rule on a different line", () => {
    const { fresh } = partitionNew(
      [flag({ line: 14 })],
      [{ path: "src/A.ts", line: 12, body: markerFor("effect/no-throw") }],
    )
    expect(fresh).toHaveLength(1)
  })
})

describe("targetFromEnv", () => {
  it("parses explicit overrides", () => {
    expect(targetFromEnv({ repo: "Rika-Labs/proof", pr: 7, commit: "abc" })).toEqual({
      owner: "Rika-Labs",
      repo: "proof",
      pull: 7,
      commit: "abc",
    })
  })

  it("returns undefined when incomplete", () => {
    expect(targetFromEnv({ repo: "Rika-Labs/proof" })).toBeUndefined()
  })
})
