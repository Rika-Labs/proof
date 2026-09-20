import { describe, expect, it } from "vitest"
import { Effect, Layer, ManagedRuntime, Redacted } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Credentials } from "@rikalabs/distilled-typesafe"
import { configuredLayer, decide, Jev } from "../src/Jev.ts"

const questions = {
  n: { type: "noul", instructions: "Is urgent?" },
  c: { type: "choice", instructions: "Which?", criteria: { bad: "Unsafe", good: "Safe" } },
  s: { type: "score", instructions: "Rate", criteria: ["low", "medium", "high"] },
}
const answers = {
  n: { type: "noul", noul: 0.81 },
  c: { type: "choice", choice: "good", confidence: 0.74, probabilities: { bad: 0.19, good: 0.81 } },
  s: {
    type: "score",
    score: 1.5,
    confidence: 0.66,
    probabilities: { "0": 0.1, "1": 0.3, "2": 0.6 },
  },
}
const live = (body: unknown, status = 200) =>
  configuredLayer("jev-1.13.0").pipe(
    Layer.provide(
      Layer.succeed(Credentials, {
        apiKey: Redacted.make("fixture"),
        apiBaseUrl: "https://fixture.invalid/v1",
      }),
    ),
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((req) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(req, new Response(JSON.stringify(body), { status })),
          ),
        ),
      ),
    ),
  )

describe("native TypeSafe DecisionModel through Distilled", () => {
  it("maps all three primitives and preserves asymmetric usage", async () => {
    const result = await Effect.runPromise(
      decide({ state: { arbitrary: [1, "evidence"] }, questions }).pipe(
        Effect.provide(
          live({ model: "jev-1.13.0", answers, usage: { input_tokens: 31, output_tokens: 7 } }),
        ),
      ),
    )
    expect(result).toMatchObject({
      answers: {
        n: { probability: 0.81 },
        c: { label: "good", confidence: 0.74 },
        s: { rating: 1.5, label: "high", probabilities: { low: 0.1, medium: 0.3, high: 0.6 } },
      },
      usage: { inputTokens: 31, outputTokens: 7 },
    })
  })
  it("retains structured few-shot examples as JSON rubrics without a second HTTP path", async () => {
    const http = HttpClient.make((req) => {
      if (req.body._tag === "Uint8Array") {
        const wire = JSON.parse(new TextDecoder().decode(req.body.body))
        expect(wire.questions.q.criteria.true).toBe('{"what":"violation","examples":["throw"]}')
      } else throw new Error("Expected JSON request")
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          req,
          new Response(
            JSON.stringify({ model: "jev", answers: { q: { type: "noul", noul: 0.9 } } }),
          ),
        ),
      )
    })
    const service = configuredLayer("jev-1.13.0").pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
      Layer.provide(
        Layer.succeed(Credentials, {
          apiKey: Redacted.make("fixture"),
          apiBaseUrl: "https://fixture.invalid/v1",
        }),
      ),
    )
    const result = await Effect.runPromise(
      Effect.flatMap(Jev, (jev) =>
        jev.askNoul("state", "Violation?", {
          true: { what: "violation", examples: ["throw"] },
          false: "clean",
        }),
      ).pipe(Effect.provide(service)),
    )
    expect(result).toEqual({ noul: 0.9 })
  })
  it.each([
    { ...answers, n: undefined },
    {
      ...answers,
      n: { type: "choice", choice: "good", confidence: 0.8, probabilities: { good: 1 } },
    },
    { ...answers, c: { ...answers.c, choice: "invented" } },
    { ...answers, c: { ...answers.c, probabilities: { bad: 0.4, good: 0.9 } } },
    { ...answers, s: { ...answers.s, score: 4 } },
    { ...answers, n: { type: "noul", noul: -0.2 } },
  ])("rejects malformed/missing/mismatched answers", async (invalid) => {
    await expect(
      Effect.runPromise(
        decide({ state: "x", questions }).pipe(
          Effect.provide(live({ model: "jev", answers: invalid })),
        ),
      ),
    ).rejects.toThrow(/evaluation failed/)
  })
  it("does not leak backend bodies or turn an outage into clean", async () => {
    await expect(
      Effect.runPromise(
        decide({ state: "x", questions }).pipe(
          Effect.provide(live({ message: "secret-like-provider-body" }, 529)),
        ),
      ),
    ).rejects.toThrow("Jev evaluation failed (provider unavailable or invalid output)")
  })
  it.each([
    {},
    Object.fromEntries(Array.from({ length: 33 }, (_, i) => [String(i), questions.n])),
    { q: { type: "score", instructions: "x", criteria: ["same", "same"] } },
    { q: { type: "choice", instructions: "x", criteria: { only: "one" } } },
  ])("rejects invalid question bounds before network", async (invalid) => {
    await expect(
      Effect.runPromise(
        decide({ state: "x", questions: invalid }).pipe(Effect.provide(live(null))),
      ),
    ).rejects.toThrow(/questions|levels|options/)
  })
  it("propagates cancellation to the transport and closes runtime work", async () => {
    let interrupted = false
    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    const http = HttpClient.make(() =>
      Effect.gen(function* () {
        started()
        return yield* Effect.never
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            interrupted = true
          }),
        ),
      ),
    )
    const runtime = ManagedRuntime.make(
      configuredLayer("jev").pipe(
        Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
        Layer.provide(
          Layer.succeed(Credentials, {
            apiKey: Redacted.make("fixture"),
            apiBaseUrl: "https://fixture.invalid/v1",
          }),
        ),
      ),
    )
    const controller = new AbortController()
    const result = runtime.runPromise(decide({ state: "x", questions }), {
      signal: controller.signal,
    })
    const rejection = expect(result).rejects.toThrow()
    await ready
    controller.abort()
    await rejection
    expect(interrupted).toBe(true)
    await runtime.dispose()
  })
})
