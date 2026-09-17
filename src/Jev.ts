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

export interface Service {
  readonly askNoul: (
    state: unknown,
    instructions: string,
    criteria?: { readonly true: string; readonly false: string },
  ) => Effect.Effect<NoulAnswer, JevError>
  readonly askChoice: (
    state: unknown,
    instructions: string,
    criteria: Record<string, string>,
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

    const service: Service = {
      askNoul: (state, instructions, criteria) =>
        Effect.gen(function* () {
          const questions: Record<string, unknown> = {
            q:
              criteria === undefined
                ? { type: "noul", instructions }
                : { type: "noul", instructions, criteria },
          }
          const res = yield* callSystemOne(endpoint, apiKey, model, state, questions)
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
