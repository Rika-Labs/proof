import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { Jev } from "../src/Jev.ts"
import { handleProofCheck, handleProofReviewDiff } from "../src/Toolkit.ts"

const stubViolates = Jev.of({
  askBatch: (_state, questions) =>
    Effect.succeed(
      Object.fromEntries(
        Object.entries(questions).map(([id, q]) =>
          q.type === "noul"
            ? [id, { noul: 0.91 }]
            : [id, { choice: "request_changes", confidence: 0.88, probabilities: {} }],
        ),
      ),
    ),
  askNoul: () => Effect.succeed({ noul: 0.91 }),
  askChoice: () =>
    Effect.succeed({ choice: "request_changes", confidence: 0.88, probabilities: {} }),
  askScore: () => Effect.succeed({ score: 0, confidence: 1, probabilities: {}, legend: {} }),
})

const stubClean = Jev.of({
  askBatch: (_state, questions) =>
    Effect.succeed(
      Object.fromEntries(
        Object.entries(questions).map(([id, q]) =>
          q.type === "noul"
            ? [id, { noul: 0.05 }]
            : [id, { choice: "pass", confidence: 0.95, probabilities: {} }],
        ),
      ),
    ),
  askNoul: () => Effect.succeed({ noul: 0.05 }),
  askChoice: () => Effect.succeed({ choice: "pass", confidence: 0.95, probabilities: {} }),
  askScore: () => Effect.succeed({ score: 2, confidence: 0.9, probabilities: {}, legend: {} }),
})

describe("handleProofCheck", () => {
  it("reports violation above threshold", async () => {
    const res = await Effect.runPromise(
      handleProofCheck({ statement: "No throw", file: "src/A.ts", diff: "+ throw x" }).pipe(
        Effect.provideService(Jev, stubViolates),
      ),
    )
    expect(res.violates).toBe(true)
    expect(res.noul).toBe(0.91)
    expect(res.error).toBeUndefined()
  })

  it("reports pass below threshold", async () => {
    const res = await Effect.runPromise(
      handleProofCheck({
        statement: "No throw",
        file: "src/A.ts",
        diff: "+ Effect.succeed(1)",
      }).pipe(Effect.provideService(Jev, stubClean)),
    )
    expect(res.violates).toBe(false)
  })
})

describe("handleProofReviewDiff", () => {
  it("returns flags with stubbed Jev", async () => {
    const diff = "diff --git a/src/A.ts b/src/A.ts\n+ throw new Error('x')"
    const res = await Effect.runPromise(
      handleProofReviewDiff({ diff }).pipe(Effect.provideService(Jev, stubViolates)),
    )
    expect(res.hunks).toBe(1)
    expect(res.error).toBeUndefined()
    expect(res.flags.length).toBeGreaterThan(0)
    expect(res.flags[0]?.ruleId).toBe("effect/no-throw")
  })

  it("returns empty flags on clean stub", async () => {
    const diff = "diff --git a/src/A.ts b/src/A.ts\n+ Effect.succeed(1)"
    const res = await Effect.runPromise(
      handleProofReviewDiff({ diff }).pipe(Effect.provideService(Jev, stubClean)),
    )
    expect(res.flags).toEqual([])
  })

  it("returns error payload for empty diff instead of failing", async () => {
    const res = await Effect.runPromise(
      handleProofReviewDiff({ diff: "   " }).pipe(Effect.provideService(Jev, stubClean)),
    )
    expect(res.flags).toEqual([])
    expect(res.error).toContain("EmptyDiff")
  })
})
