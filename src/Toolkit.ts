import { Effect, Layer, Schema } from "effect"
import { McpServer, Tool, Toolkit } from "effect/unstable/ai"
import { Jev, layer as JevLive } from "./Jev.ts"
import { effectStrict } from "./presets.ts"
import { reviewDiff, splitDiff } from "./Review.ts"
import { matchesFile, noul } from "./Rule.ts"

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

export const ProofReviewDiff = Tool.make("proof_review_diff", {
  description:
    "Run the built-in Effect-strict rule preset against a unified diff. Returns flags only (ruleId, file, confidence, detail).",
  parameters: Schema.Struct({
    diff: desc(Schema.String, "Full unified diff to review"),
    thresholdOverride: Schema.optional(
      desc(Schema.Number, "If set, overrides every rule threshold"),
    ),
  }),
  success: Schema.Struct({
    flags: Schema.Array(
      Schema.Struct({
        ruleId: Schema.String,
        file: Schema.String,
        confidence: Schema.Number,
        severity: Schema.String,
        detail: Schema.String,
      }),
    ),
    hunks: Schema.Number,
    error: Schema.optional(Schema.String),
  }),
})

export const ProofListRules = Tool.make("proof_list_rules", {
  description: "List the built-in proof rule presets (ids, kind, severity). Takes no arguments.",
  success: Schema.Struct({
    rules: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        kind: Schema.String,
        severity: Schema.String,
      }),
    ),
  }),
})

export const ProofToolkit = Toolkit.make(ProofCheck, ProofReviewDiff, ProofListRules)

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
      `Does this diff violate the following rule? Rule: ${statement}`,
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

export const handleProofReviewDiff = (params: {
  readonly diff: string
  readonly thresholdOverride?: number | undefined
}): Effect.Effect<
  {
    readonly flags: ReadonlyArray<{
      readonly ruleId: string
      readonly file: string
      readonly confidence: number
      readonly severity: string
      readonly detail: string
    }>
    readonly hunks: number
    readonly error?: string
  },
  never,
  Jev
> => {
  const { diff, thresholdOverride } = params
  return Effect.gen(function* () {
    const rules =
      thresholdOverride === undefined
        ? effectStrict
        : effectStrict.map((rule) =>
            rule._tag === "Noul" ? { ...rule, threshold: thresholdOverride } : rule,
          )
    const flags = yield* reviewDiff(rules, diff)
    return {
      flags: flags.map((flag) => ({ ...flag })),
      hunks: splitDiff(diff).length,
    }
  }).pipe(
    Effect.catch((e: unknown) =>
      Effect.succeed({
        flags: [],
        hunks: splitDiff(diff).length,
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
      proof_review_diff: (params: {
        readonly diff: string
        readonly thresholdOverride?: number | undefined
      }) =>
        handleProofReviewDiff(params).pipe(
          Effect.provide(JevLive),
          Effect.catch((e: unknown) =>
            Effect.succeed({ flags: [], hunks: splitDiff(params.diff).length, error: String(e) }),
          ),
        ),
      proof_list_rules: () =>
        Effect.succeed({
          rules: effectStrict.map((rule) => ({
            id: rule.id,
            kind: rule._tag,
            severity: rule.severity,
          })),
        }),
    }),
  ),
)

export const ruleMatchesFile = (ruleId: string, file: string): boolean => {
  const rule = effectStrict.find((candidate) => candidate.id === ruleId)
  if (rule === undefined) return false
  return matchesFile(rule, file)
}

export const adHocNoul = (id: string, statement: string) => noul({ id, statement })
