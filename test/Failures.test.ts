import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { Jev, JevError, type Answer } from "../src/Jev.ts"
import { checkHunk, checkHunkBatched } from "../src/Review.ts"
import { choice, noul } from "../src/Rule.ts"
import { handleProofCheck } from "../src/Toolkit.ts"
import { isRuleArray, reviewOutcome } from "../src/cli.ts"

const hunk = { file: "src/a.ts", diff: "+throw x", targetLine: 7 }
const stub = (answer: Answer | undefined) =>
  Jev.of({
    askBatch: () => Effect.succeed(answer === undefined ? {} : { q: answer }),
    askNoul: () => Effect.fail(new JevError({ status: 503, message: "outage" })),
    askChoice: () => Effect.die("unused"),
    askScore: () => Effect.die("unused"),
  })

describe("fail-closed boundaries", () => {
  it.each([NaN, Infinity, -0.1, 1.01])(
    "rejects invalid thresholds %s in constructors, loader, and MCP",
    async (threshold) => {
      expect(() => noul({ id: "q", statement: "s", threshold })).toThrow()
      expect(() =>
        choice({
          id: "q",
          instructions: "i",
          options: { bad: "bad", good: "good" },
          passing: ["good"],
          threshold,
        }),
      ).toThrow()
      expect(isRuleArray([{ ...noul({ id: "q", statement: "s" }), threshold }])).toBe(false)
      await expect(
        Effect.runPromise(
          handleProofCheck({ statement: "s", file: "a", diff: "+x", threshold }).pipe(
            Effect.provideService(Jev, stub(undefined)),
          ),
        ),
      ).rejects.toThrow(/threshold/)
    },
  )
  it("rejects missing explicit Choice passing keys and duplicate rule ids", () => {
    const rule = choice({
      id: "q",
      instructions: "i",
      options: { bad: "bad", good: "good" },
      passing: ["good"],
    })
    expect(isRuleArray([{ ...rule, passing: undefined }])).toBe(false)
    expect(isRuleArray([{ ...rule, passing: ["invented"] }])).toBe(false)
    expect(isRuleArray([rule, rule])).toBe(false)
  })
  it.each([
    ["bad", 0.8, true],
    ["good", 0.99, false],
    ["bad", 0.799, false],
  ] as const)(
    "Choice %s at %s flags=%s regardless of insertion order",
    async (label, confidence, flags) => {
      const rule = choice({
        id: "q",
        instructions: "i",
        options: { bad: "first is NOT passing", good: "passing" },
        passing: ["good"],
        threshold: 0.8,
      })
      const result = await Effect.runPromise(
        checkHunk(rule, hunk).pipe(
          Effect.provideService(Jev, stub({ choice: label, confidence, probabilities: {} })),
        ),
      )
      expect(result !== null).toBe(flags)
    },
  )
  it.each([
    undefined,
    { noul: NaN },
    { noul: 1.1 },
    { choice: "bad", confidence: 0.9, probabilities: {} },
  ])("incomplete or wrong-kind noul result is not clean", async (answer) => {
    await expect(
      Effect.runPromise(
        checkHunkBatched([noul({ id: "q", statement: "s" })], hunk).pipe(
          Effect.provideService(Jev, stub(answer)),
        ),
      ),
    ).rejects.toThrow(/answer/)
  })
  it("MCP and CLI preserve outages as failures", async () => {
    await expect(
      Effect.runPromise(
        handleProofCheck({ statement: "s", file: "a", diff: "+x" }).pipe(
          Effect.provideService(Jev, stub(undefined)),
        ),
      ),
    ).rejects.toThrow("outage")
    await expect(
      Effect.runPromise(
        reviewOutcome(Effect.fail(new JevError({ status: 529, message: "outage" }))),
      ),
    ).rejects.toThrow("outage")
  })
})
