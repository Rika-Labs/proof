import { Config, Context, Data, Effect, Layer, Redacted } from "effect"

export class MissingApiKey extends Data.TaggedError("MissingApiKey")<{
  readonly message: string
}> {}

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
  readonly probabilities: Record<string, number>
}

export interface ScoreAnswer {
  readonly score: number
  readonly confidence: number
  readonly probabilities: Record<string, number>
  readonly legend: Record<string, string>
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer

/** One Jev question in a batched request. Criteria values may be strings or structured objects with examples. */
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

export interface Service {
  /** Ask several questions about one state in a single request. Keyed by caller-chosen ids. */
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

interface SystemOneAnswer {
  readonly type: string
  readonly choice?: string
  readonly confidence?: number
  readonly probabilities?: Record<string, number>
  readonly noul?: number
  readonly score?: number
  readonly legend?: Record<string, string>
}

interface SystemOneResponse {
  readonly model: string
  readonly answers: Record<string, SystemOneAnswer | undefined>
  readonly usage?: unknown
}

const callSystemOne = (
  endpoint: string,
  apiKey: Redacted.Redacted<string>,
  model: string,
  state: unknown,
  questions: Record<string, unknown>,
): Effect.Effect<SystemOneResponse, JevError> =>
  Effect.tryPromise({
    try: () =>
      fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${Redacted.value(apiKey)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ state, model, questions }),
      }).then(async (res): Promise<SystemOneResponse> => {
        if (!res.ok) {
          const text = await res.text().catch(() => "")
          throw new JevError({
            status: res.status,
            message: `TypeSafe ${res.status}: ${text.slice(0, 300)}`,
          })
        }
        return (await res.json()) as SystemOneResponse
      }),
    catch: (e) =>
      e instanceof JevError ? e : new JevError({ status: undefined, message: String(e) }),
  })

export const layer = Layer.effect(
  Jev,
  Effect.gen(function* () {
    const apiKey = yield* Config.Redacted("TYPESAFE_API_KEY").pipe(
      Effect.mapError(() => new MissingApiKey({ message: "TYPESAFE_API_KEY is not set" })),
    )
    const endpoint = yield* Config.String("TYPESAFE_ENDPOINT").pipe(
      Config.withDefault("https://api.typesafe.ai/v1/systemone"),
    )
    const model = yield* Config.String("TYPESAFE_MODEL").pipe(Config.withDefault("jev-latest"))

    const decodeAnswer = (id: string, res: SystemOneResponse): Effect.Effect<Answer, JevError> =>
      Effect.gen(function* () {
        const ans = res.answers[id]
        if (ans === undefined) {
          return yield* new JevError({ status: undefined, message: `Missing answer for ${id}` })
        }
        if (typeof ans.noul === "number") return { noul: ans.noul } as const
        if (
          typeof ans.choice === "string" &&
          typeof ans.confidence === "number" &&
          typeof ans.probabilities === "object" &&
          ans.probabilities !== null
        ) {
          return {
            choice: ans.choice,
            confidence: ans.confidence,
            probabilities: ans.probabilities,
          } as const
        }
        if (
          typeof ans.score === "number" &&
          typeof ans.confidence === "number" &&
          typeof ans.probabilities === "object" &&
          ans.probabilities !== null
        ) {
          return {
            score: ans.score,
            confidence: ans.confidence,
            probabilities: ans.probabilities,
            legend: ans.legend ?? {},
          } as const
        }
        return yield* new JevError({
          status: undefined,
          message: `Unexpected answer for ${id}: ${JSON.stringify(res).slice(0, 300)}`,
        })
      })

    const service: Service = {
      askBatch: (state, questions) =>
        Effect.gen(function* () {
          const wire: Record<string, unknown> = {}
          for (const [id, q] of Object.entries(questions)) {
            wire[id] =
              q.type === "noul" && q.criteria === undefined
                ? { type: "noul", instructions: q.instructions }
                : { type: q.type, instructions: q.instructions, criteria: q.criteria }
          }
          const res = yield* callSystemOne(endpoint, apiKey, model, state, wire)
          const out: Record<string, Answer> = {}
          for (const id of Object.keys(questions)) out[id] = yield* decodeAnswer(id, res)
          return out
        }),
      askNoul: (state, instructions, criteria) =>
        Effect.gen(function* () {
          const res = yield* callSystemOne(endpoint, apiKey, model, state, {
            q:
              criteria === undefined
                ? { type: "noul", instructions }
                : { type: "noul", instructions, criteria },
          })
          const ans = res.answers["q"]
          if (ans === undefined || typeof ans.noul !== "number") {
            return yield* new JevError({
              status: undefined,
              message: `Unexpected noul response: ${JSON.stringify(res).slice(0, 300)}`,
            })
          }
          return { noul: ans.noul }
        }),
      askChoice: (state, instructions, criteria) =>
        Effect.gen(function* () {
          const res = yield* callSystemOne(endpoint, apiKey, model, state, {
            q: { type: "choice", instructions, criteria },
          })
          const ans = res.answers["q"]
          if (
            ans === undefined ||
            typeof ans.choice !== "string" ||
            typeof ans.confidence !== "number" ||
            typeof ans.probabilities !== "object" ||
            ans.probabilities === null
          ) {
            return yield* new JevError({
              status: undefined,
              message: `Unexpected choice response: ${JSON.stringify(res).slice(0, 300)}`,
            })
          }
          return {
            choice: ans.choice,
            confidence: ans.confidence,
            probabilities: ans.probabilities,
          }
        }),
      askScore: (state, instructions, levels) =>
        Effect.gen(function* () {
          const res = yield* callSystemOne(endpoint, apiKey, model, state, {
            q: { type: "score", instructions, criteria: [...levels] },
          })
          const ans = res.answers["q"]
          if (
            ans === undefined ||
            typeof ans.score !== "number" ||
            typeof ans.confidence !== "number" ||
            typeof ans.probabilities !== "object" ||
            ans.probabilities === null
          ) {
            return yield* new JevError({
              status: undefined,
              message: `Unexpected score response: ${JSON.stringify(res).slice(0, 300)}`,
            })
          }
          return {
            score: ans.score,
            confidence: ans.confidence,
            probabilities: ans.probabilities,
            legend: ans.legend ?? {},
          }
        }),
    }
    return service
  }),
)
