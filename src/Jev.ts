import { Config, Context, Data, Effect, Layer, Schema } from "effect"
import { Decision, DecisionModel, AiError } from "effect/unstable/ai"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { TypeSafeClient, TypeSafeDecisionModel } from "@effect/ai-typesafe"
import * as Distilled from "@rikalabs/distilled-typesafe"

export class JevError extends Data.TaggedError("JevError")<{
  readonly status: number | undefined
  readonly message: string
}> {}

export interface NoulAnswer {
  readonly noul: number
}
export interface ChoiceAnswer {
  readonly choice: string
  readonly confidence: number
  readonly probabilities: Readonly<Record<string, number>>
}
export interface ScoreAnswer {
  readonly score: number
  readonly confidence: number
  readonly probabilities: Readonly<Record<string, number>>
  readonly legend: Readonly<Record<string, string>>
}
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer
export type BatchQuestion =
  | {
      readonly type: "noul"
      readonly instructions: string
      readonly criteria?: { readonly true: unknown; readonly false: unknown }
    }
  | {
      readonly type: "choice"
      readonly instructions: string
      readonly criteria: Record<string, unknown>
    }
  | {
      readonly type: "score"
      readonly instructions: string
      readonly criteria: ReadonlyArray<unknown>
    }

export interface CacheIdentity {
  readonly provider: string
  readonly model: string
  readonly evaluator: string
  /** Caller-owned immutable model/rubric/account revision. Omit identity to disable persistent reuse. */
  readonly revision: string
}
export interface Service {
  readonly cacheIdentity?: CacheIdentity
  readonly askBatch: (
    state: unknown,
    questions: Record<string, BatchQuestion>,
  ) => Effect.Effect<Record<string, Answer>, JevError>
  readonly askNoul: (
    state: unknown,
    instructions: string,
    criteria?: { readonly true: unknown; readonly false: unknown },
  ) => Effect.Effect<NoulAnswer, JevError>
  readonly askChoice: (
    state: unknown,
    instructions: string,
    criteria: Record<string, unknown>,
  ) => Effect.Effect<ChoiceAnswer, JevError>
  readonly askScore: (
    state: unknown,
    instructions: string,
    levels: ReadonlyArray<string>,
  ) => Effect.Effect<ScoreAnswer, JevError>
}
export class Jev extends Context.Service<Jev, Service>()("proof/Jev") {}

const failure = (message: string) => new JevError({ status: undefined, message })
const rubric = (value: unknown): string =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? "")

/** Untrusted tool inputs: JSON state, 1..32 questions, bounded rubrics. Never an authorization decision. */
export const Request = Schema.Struct({
  state: Schema.Json,
  questions: Schema.Record(
    Schema.String,
    Schema.Union([
      Schema.Struct({
        type: Schema.Literal("noul"),
        instructions: Schema.String,
        criteria: Schema.optional(Schema.Struct({ true: Schema.Json, false: Schema.Json })),
      }),
      Schema.Struct({
        type: Schema.Literal("choice"),
        instructions: Schema.String,
        criteria: Schema.Record(Schema.String, Schema.Json),
      }),
      Schema.Struct({
        type: Schema.Literal("score"),
        instructions: Schema.String,
        criteria: Schema.Array(Schema.Json),
      }),
    ]),
  ),
})

export const decide = Effect.fnUntraced(function* (input: unknown) {
  const request = yield* Schema.decodeUnknownEffect(Request)(input).pipe(
    Effect.mapError(() => failure("Invalid Jev request: expected JSON state and typed questions")),
  )
  const entries = Object.entries(request.questions)
  if (entries.length < 1 || entries.length > 32 || JSON.stringify(request).length > 262144) {
    return yield* failure("Jev accepts 1..32 questions and at most 262144 JSON characters")
  }
  const decisions: Record<string, Decision.Any> = Object.create(null)
  for (const [id, q] of entries) {
    if (!id || id.length > 128 || !q.instructions.trim() || q.instructions.length > 8192) {
      return yield* failure("Question ids must be 1..128 and instructions 1..8192 characters")
    }
    switch (q.type) {
      case "noul":
        decisions[id] = Decision.probability({
          instructions: q.instructions,
          criteria:
            q.criteria === undefined
              ? { true: "Yes", false: "No" }
              : { true: rubric(q.criteria.true), false: rubric(q.criteria.false) },
        })
        break
      case "choice": {
        const criteria = Object.fromEntries(
          Object.entries(q.criteria).map(([key, value]) => [key, rubric(value)]),
        )
        if (Object.keys(criteria).length < 2 || Object.keys(criteria).length > 255)
          return yield* failure("Choice needs 2..255 options")
        decisions[id] = Decision.classify({ instructions: q.instructions, criteria })
        break
      }
      case "score": {
        const criteria = q.criteria.map(rubric)
        if (
          criteria.length < 2 ||
          criteria.length > 10 ||
          new Set(criteria).size !== criteria.length
        )
          return yield* failure("Score needs 2..10 distinct levels")
        decisions[id] = Decision.rate({ instructions: q.instructions, criteria })
      }
    }
  }
  return yield* DecisionModel.decide(Decision.make({ input: Schema.Json, decisions }), {
    input: request.state,
  }).pipe(
    Effect.mapError(() =>
      failure("Jev evaluation failed (provider unavailable or invalid output)"),
    ),
  )
})

/** Preserve native DecisionModel answers and token usage in the raw tool API. */
export type RawResult = Effect.Success<ReturnType<typeof decide>>

export const make = (cacheIdentity?: CacheIdentity) =>
  Effect.gen(function* () {
    const model = yield* DecisionModel.DecisionModel
    const ask = (state: unknown, questions: Record<string, BatchQuestion>) =>
      decide({ state, questions }).pipe(Effect.provideService(DecisionModel.DecisionModel, model))
    const service: Service = {
      ...(cacheIdentity === undefined ? {} : { cacheIdentity }),
      askBatch: (state, questions) =>
        ask(state, questions).pipe(
          Effect.map(({ answers }) =>
            Object.fromEntries(
              Object.entries(answers).map(([id, answer]): [string, Answer] => {
                if ("probability" in answer) return [id, { noul: answer.probability }]
                if ("rating" in answer) {
                  const q = questions[id]
                  const levels = q?.type === "score" ? q.criteria.map(rubric) : []
                  return [
                    id,
                    {
                      score: answer.rating,
                      confidence: answer.confidence ?? 0,
                      probabilities: Object.fromEntries(
                        levels.map((level, i) => [String(i), answer.probabilities[level] ?? 0]),
                      ),
                      legend: Object.fromEntries(levels.map((level, i) => [String(i), level])),
                    },
                  ]
                }
                return [
                  id,
                  {
                    choice: answer.label,
                    confidence: answer.confidence ?? 0,
                    probabilities: answer.probabilities,
                  },
                ]
              }),
            ),
          ),
        ),
      askNoul: (state, instructions, criteria) =>
        service
          .askBatch(state, {
            q: { type: "noul", instructions, ...(criteria === undefined ? {} : { criteria }) },
          })
          .pipe(Effect.map((answers) => answers["q"] as NoulAnswer)),
      askChoice: (state, instructions, criteria) =>
        service
          .askBatch(state, { q: { type: "choice", instructions, criteria } })
          .pipe(Effect.map((answers) => answers["q"] as ChoiceAnswer)),
      askScore: (state, instructions, criteria) =>
        service
          .askBatch(state, { q: { type: "score", instructions, criteria } })
          .pipe(Effect.map((answers) => answers["q"] as ScoreAnswer)),
    }
    return service
  })

/** Supply the native TypeSafe client contract exclusively through Distilled operations. */
export const distilledClientLayer = Layer.effect(
  TypeSafeClient.TypeSafeClient,
  Effect.gen(function* () {
    const credentials = yield* Distilled.Credentials
    const client = yield* HttpClient.HttpClient
    const bind = <A>(
      operation: Effect.Effect<A, Distilled.TypeSafeError, Distilled.TypeSafeContext>,
    ) =>
      operation.pipe(
        Effect.provideService(Distilled.Credentials, credentials),
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.mapError(() =>
          AiError.make({
            module: "DistilledTypeSafe",
            method: "request",
            reason: new AiError.InvalidOutputError({ description: "TypeSafe transport failed" }),
          }),
        ),
      )
    return TypeSafeClient.TypeSafeClient.of({
      client,
      systemOne: (request) => bind(Distilled.systemOne(request)),
      listModels: () => bind(Distilled.listModels()),
    })
  }),
)

/** Injectable layer for tests and hosts; no native TypeSafe HTTP fallback. */
export const modelLayer = (model: string) =>
  TypeSafeDecisionModel.layer({ model }).pipe(Layer.provide(distilledClientLayer))
export const configuredLayer = (model: string, cacheIdentity?: CacheIdentity) =>
  Layer.effect(Jev, make(cacheIdentity)).pipe(Layer.provideMerge(modelLayer(model)))

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const model = yield* Config.String("TYPESAFE_MODEL").pipe(Config.withDefault("jev-latest"))
    // Rolling aliases are intentionally uncached. Hosts can opt in with an explicit revision through configuredLayer.
    return configuredLayer(model).pipe(
      Layer.provide(Distilled.CredentialsFromEnv),
      Layer.provide(FetchHttpClient.layer),
    )
  }),
)
