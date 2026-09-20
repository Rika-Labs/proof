import { describe, expect, it } from "vitest"
import { checkHunkBatched, noulQuestion, reviewDiff, splitDiff } from "../src/Review.ts"
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
    expect(() =>
      choice({ id: "x", instructions: "Pick", options: { only: "one" }, passing: ["only"] }),
    ).toThrow()
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

describe("noulQuestion", () => {
  it("omits criteria without examples", () => {
    const q = noulQuestion(noul({ id: "x", statement: "s" }), {
      file: "a.ts",
      diff: "+1",
      targetLine: 1,
    })
    expect(q.criteria).toBeUndefined()
  })

  it("builds structured criteria with examples", () => {
    const q = noulQuestion(
      noul({
        id: "x",
        statement: "No throw",
        examples: { violate: ["throw x"], clean: ["Effect.fail"] },
      }),
      { file: "a.ts", diff: "+1", targetLine: 1 },
    )
    expect(q.criteria).toMatchObject({
      true: { what: expect.stringContaining("No throw"), examples: ["throw x"] },
      false: { what: expect.any(String), examples: ["Effect.fail"] },
    })
  })
})

describe("checkHunkBatched", () => {
  it("asks one batched call and maps answers to flags", async () => {
    let calls = 0
    const stub = Jev.of({
      askBatch: (_state, questions) => {
        calls += 1
        return Effect.succeed(
          Object.fromEntries(
            Object.entries(questions).map(([id, q]) =>
              q.type === "noul"
                ? [id, { noul: 0.9 }]
                : [id, { choice: "b", confidence: 0.9, probabilities: {} }],
            ),
          ),
        )
      },
      askNoul: () => Effect.succeed({ noul: 0 }),
      askChoice: () => Effect.succeed({ choice: "a", confidence: 0, probabilities: {} }),
      askScore: () => Effect.succeed({ score: 0, confidence: 0, probabilities: {}, legend: {} }),
    })
    const flags = await Effect.runPromise(
      checkHunkBatched(
        [
          noul({ id: "n", statement: "s", threshold: 0.5 }),
          choice({
            id: "c",
            instructions: "pick",
            options: { a: "first", b: "second" },
            passing: ["a"],
            threshold: 0.5,
          }),
        ],
        { file: "a.ts", diff: "+x", targetLine: 3 },
      ).pipe(Effect.provideService(Jev, stub)),
    )
    expect(calls).toBe(1)
    expect(flags.map((f) => f.ruleId).toSorted()).toEqual(["c", "n"])
    expect(flags[0]?.line).toBe(3)
  })
})

describe("reviewDiff with stubbed Jev", () => {
  const stub = Jev.of({
    askBatch: (_state, questions) =>
      Effect.succeed(
        Object.fromEntries(
          Object.entries(questions).map(([id, q]) =>
            q.type === "noul"
              ? [id, { noul: 0.95 }]
              : [id, { choice: "request_changes", confidence: 0.9, probabilities: {} }],
          ),
        ),
      ),
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
