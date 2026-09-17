import { Data, Schema } from "effect"

export type Severity = "comment" | "request-changes"

export const SeveritySchema = Schema.Union([
  Schema.Literal("comment"),
  Schema.Literal("request-changes"),
])

export interface NoulRule {
  readonly _tag: "Noul"
  readonly id: string
  readonly statement: string
  readonly severity: Severity
  readonly threshold: number
  readonly include: ReadonlyArray<string> | undefined
}

export interface ChoiceRule {
  readonly _tag: "Choice"
  readonly id: string
  readonly instructions: string
  readonly options: Record<string, string>
  readonly severity: Severity
  readonly threshold: number
  readonly include: ReadonlyArray<string> | undefined
}

export interface ScoreRule {
  readonly _tag: "Score"
  readonly id: string
  readonly instructions: string
  readonly levels: ReadonlyArray<string>
  readonly severity: Severity
  readonly include: ReadonlyArray<string> | undefined
}

export type Rule = NoulRule | ChoiceRule | ScoreRule

export class InvalidRule extends Data.TaggedError("InvalidRule")<{
  readonly reason: string
}> {}

const checkThreshold = (threshold: number): boolean => threshold >= 0 && threshold <= 1

export const noul = (args: {
  readonly id: string
  readonly statement: string
  readonly severity?: Severity
  readonly threshold?: number
  readonly include?: ReadonlyArray<string>
}): NoulRule => {
  const threshold = args.threshold ?? 0.75
  if (!checkThreshold(threshold)) {
    throw new InvalidRule({ reason: `threshold must be 0..1, got ${threshold}` })
  }
  return {
    _tag: "Noul",
    id: args.id,
    statement: args.statement,
    severity: args.severity ?? "comment",
    threshold,
    include: args.include,
  }
}

export const choice = (args: {
  readonly id: string
  readonly instructions: string
  readonly options: Record<string, string>
  readonly severity?: Severity
  readonly threshold?: number
  readonly include?: ReadonlyArray<string>
}): ChoiceRule => {
  const threshold = args.threshold ?? 0.75
  const keys = Object.keys(args.options)
  if (keys.length < 2) throw new InvalidRule({ reason: "choice needs >= 2 options" })
  if (keys.length > 255) throw new InvalidRule({ reason: "choice supports max 255 options" })
  return {
    _tag: "Choice",
    id: args.id,
    instructions: args.instructions,
    options: args.options,
    severity: args.severity ?? "comment",
    threshold,
    include: args.include,
  }
}

export const score = (args: {
  readonly id: string
  readonly instructions: string
  readonly levels: ReadonlyArray<string>
  readonly severity?: Severity
  readonly include?: ReadonlyArray<string>
}): ScoreRule => {
  if (args.levels.length < 2) throw new InvalidRule({ reason: "score needs >= 2 levels" })
  if (args.levels.length > 10) throw new InvalidRule({ reason: "score supports max 10 levels" })
  return {
    _tag: "Score",
    id: args.id,
    instructions: args.instructions,
    levels: args.levels,
    severity: args.severity ?? "comment",
    include: args.include,
  }
}

export const define = (args: { readonly rules: ReadonlyArray<Rule> }) => args

export const matchesFile = (rule: Rule, file: string): boolean => {
  const patterns = rule.include
  if (patterns === undefined || patterns.length === 0) return true
  return patterns.some((pattern) => {
    if (pattern.endsWith("/**/*.ts")) {
      const prefix = pattern.slice(0, -"/**/*.ts".length)
      return file.startsWith(prefix) && file.endsWith(".ts")
    }
    if (pattern.endsWith("/**")) {
      return file.startsWith(pattern.slice(0, -"/**"))
    }
    return file === pattern
  })
}
