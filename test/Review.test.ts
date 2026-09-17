import { describe, expect, it } from "vitest"
import { effectStrict } from "../src/presets.ts"
import { reviewDiff, splitDiff } from "../src/Review.ts"
import { Effect } from "effect"
import { Jev } from "../src/Jev.ts"
import { choice, matchesFile, noul, score } from "../src/Rule.ts"

describe("Rule constructors", () => {
  it("noul defaults threshold and severity", () => {
    const rule = noul({ id: "x", statement: "Be nice" })
    expect(rule.threshold).toBe(0.75)
    expect(rule.severity).toBe("comment")
  })

  it("choice rejects fewer than 2 options", () => {
    expect(() => choice({ id: "x", instructions: "Pick", options: { only: "one" } })).toThrow()
  })

  it("score rejects fewer than 2 levels", () => {
    expect(() => score({ id: "x", instructions: "Rate", levels: ["only"] })).toThrow()
  })
})

describe("matchesFile", () => {
  it("matches src glob", () => {
    const rule = noul({ id: "x", statement: "s", include: ["src/**/*.ts"] })
    expect(matchesFile(rule, "src/Foo.ts")).toBe(true)
    expect(matchesFile(rule, "test/Foo.ts")).toBe(false)
  })

  it("matches monorepo nested src dirs with ** prefix", () => {
    const rule = noul({ id: "x", statement: "s", include: ["**/src/**/*.ts"] })
    expect(matchesFile(rule, "packages/e2b/src/E2BClient.ts")).toBe(true)
    expect(matchesFile(rule, "src/Foo.ts")).toBe(true)
    expect(matchesFile(rule, "packages/e2b/test/Foo.ts")).toBe(false)
  })

  it("exclude wins over include", () => {
    const rule = noul({
      id: "x",
      statement: "s",
      include: ["**/src/**/*.ts"],
      exclude: ["**/*.test.ts"],
    })
    expect(matchesFile(rule, "packages/e2b/src/E2BClient.ts")).toBe(true)
    expect(matchesFile(rule, "packages/e2b/src/E2BClient.test.ts")).toBe(false)
  })

  it("matches everything without include", () => {
    const rule = noul({ id: "x", statement: "s" })
    expect(matchesFile(rule, "anything/at/all.md")).toBe(true)
  })
})

describe("splitDiff", () => {
  it("splits per-file hunks", () => {
    const diff = [
      "diff --git a/src/A.ts b/src/A.ts",
      "+ const a = 1",
      "diff --git a/src/B.ts b/src/B.ts",
      "+ const b = 2",
    ].join("\n")
    const hunks = splitDiff(diff)
    expect(hunks).toHaveLength(2)
    expect(hunks[0]?.file).toBe("src/A.ts")
    expect(hunks[1]?.file).toBe("src/B.ts")
  })

  it("returns empty for blank diff", () => {
    expect(splitDiff("   ")).toEqual([])
  })
})

describe("effectStrict preset", () => {
  it("has the expected rule ids", () => {
    const ids = effectStrict.map((rule) => rule.id)
    expect(ids).toContain("effect/no-throw")
    expect(ids).toContain("effect/no-async-leak")
    expect(ids).toContain("effect/typed-errors")
    expect(ids).toContain("effect/no-env-global")
    expect(ids).toContain("effect/idiomatic")
  })
})

describe("reviewDiff with stubbed Jev", () => {
  const stub = Jev.of({
    askNoul: () => Effect.succeed({ noul: 0.95 }),
    askChoice: () =>
      Effect.succeed({ choice: "request_changes", confidence: 0.9, probabilities: {} }),
    askScore: () => Effect.succeed({ score: 0, confidence: 1, probabilities: {}, legend: {} }),
  })

  it("flags violating noul rules", async () => {
    const diff = "diff --git a/src/A.ts b/src/A.ts\n+ throw new Error('x')"
    const flags = await Effect.runPromise(
      reviewDiff([noul({ id: "t", statement: "No throw", threshold: 0.5 })], diff).pipe(
        Effect.provideService(Jev, stub),
      ),
    )
    expect(flags).toHaveLength(1)
    expect(flags[0]?.ruleId).toBe("t")
  })

  it("skips files outside include", async () => {
    const diff = "diff --git a/docs/x.md b/docs/x.md\n+ hello"
    const flags = await Effect.runPromise(
      reviewDiff([noul({ id: "t", statement: "s", include: ["src/**/*.ts"] })], diff).pipe(
        Effect.provideService(Jev, stub),
      ),
    )
    expect(flags).toEqual([])
  })
})
