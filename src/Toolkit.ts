import { Effect, Layer, Schema } from "effect"
import { McpServer, Tool, Toolkit } from "effect/unstable/ai"
import { Jev, layer as JevLive } from "./Jev.ts"
import { withFileContext } from "./Rule.ts"

const desc = <S extends Schema.Top>(self: S, description: string): S =>
  self.pipe(Schema.annotate({ description })) as S

export const ProofCheck = Tool.make("proof_check", {
  description:
    "Check one diff hunk against one plain-english rule (Noul). Returns whether it violates the rule with Jev probability.",
  parameters: Schema.Struct({
    statement: desc(
      Schema.String,
      "Plain-english rule, e.g. 'Error messages must say what to do next'",
    ),
    file: desc(Schema.String, "File path the hunk belongs to"),
    diff: desc(Schema.String, "Unified diff hunk to judge"),
    threshold: Schema.optional(desc(Schema.Number, "Violation threshold 0..1, default 0.75")),
  }),
  success: Schema.Struct({
    violates: Schema.Boolean,
    noul: Schema.Number,
    threshold: Schema.Number,
    error: Schema.optional(Schema.String),
  }),
})

export const ProofToolkit = Toolkit.make(ProofCheck)

export const handleProofCheck = (params: {
  readonly statement: string
  readonly file: string
  readonly diff: string
  readonly threshold?: number | undefined
}): Effect.Effect<
  {
    readonly violates: boolean
    readonly noul: number
    readonly threshold: number
    readonly error?: string
  },
  never,
  Jev
> => {
  const { statement, file, diff, threshold } = params
  return Effect.gen(function* () {
    const jev = yield* Jev
    const t = threshold ?? 0.75
    const ans = yield* jev.askNoul(
      { file, diff },
      withFileContext(`Does this diff violate the following rule? Rule: ${statement}`, file),
    )
    return ans.noul >= t
      ? { violates: true as const, noul: ans.noul, threshold: t }
      : { violates: false as const, noul: ans.noul, threshold: t }
  }).pipe(
    Effect.catch((e: unknown) =>
      Effect.succeed({
        violates: false,
        noul: 0,
        threshold: threshold ?? 0.75,
        error: String(e),
      }),
    ),
  )
}

export const ProofToolkitLive = McpServer.toolkit(ProofToolkit).pipe(
  Layer.provideMerge(
    ProofToolkit.toLayer({
      proof_check: (params: {
        readonly statement: string
        readonly file: string
        readonly diff: string
        readonly threshold?: number | undefined
      }) =>
        handleProofCheck(params).pipe(
          Effect.provide(JevLive),
          Effect.catch((e: unknown) =>
            Effect.succeed({
              violates: false,
              noul: 0,
              threshold: params.threshold ?? 0.75,
              error: String(e),
            }),
          ),
        ),
    }),
  ),
)
