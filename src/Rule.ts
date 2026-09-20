import { Data, Schema } from "effect"

export type Severity = "comment" | "request-changes"

export const SeveritySchema = Schema.Union([
  Schema.Literal("comment"),
  Schema.Literal("request-changes"),
])

/** Few-shot boundary examples, sent to Jev as structured criteria. */
export interface RuleExamples {
  /** Diff snippets that violate the rule. */
  readonly violate: ReadonlyArray<string>
  /** Diff snippets that look similar but are clean. */
  readonly clean: ReadonlyArray<string>
}

export interface NoulRule {
  readonly _tag: "Noul"
  readonly id: string
  readonly statement: string
  readonly severity: Severity
  readonly threshold: number
  readonly include: ReadonlyArray<string> | undefined
  readonly exclude: ReadonlyArray<string> | undefined
  readonly examples: RuleExamples | undefined
}

export interface ChoiceRule {
  readonly _tag: "Choice"
  readonly id: string
  readonly instructions: string
  readonly options: Record<string, string>
  readonly passing: ReadonlyArray<string>
  readonly severity: Severity
  readonly threshold: number
  readonly include: ReadonlyArray<string> | undefined
  readonly exclude: ReadonlyArray<string> | undefined
}

export interface ScoreRule {
  readonly _tag: "Score"
  readonly id: string
  readonly instructions: string
  readonly levels: ReadonlyArray<string>
  readonly severity: Severity
  readonly include: ReadonlyArray<string> | undefined
  readonly exclude: ReadonlyArray<string> | undefined
}

export type Rule = NoulRule | ChoiceRule | ScoreRule

export class InvalidRule extends Data.TaggedError("InvalidRule")<{
  readonly reason: string
}> {}

const Threshold = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
const checkThreshold = Schema.is(Threshold)
const common = {
  id: Schema.String.check(Schema.isMinLength(1)),
  severity: SeveritySchema,
  include: Schema.optional(Schema.Array(Schema.String)),
  exclude: Schema.optional(Schema.Array(Schema.String)),
}
export const RuleSchema = Schema.Union([
  Schema.Struct({
    ...common,
    _tag: Schema.Literal("Noul"),
    statement: Schema.String,
    threshold: Threshold,
    examples: Schema.optional(
      Schema.Struct({ violate: Schema.Array(Schema.String), clean: Schema.Array(Schema.String) }),
    ),
  }),
  Schema.Struct({
    ...common,
    _tag: Schema.Literal("Choice"),
    instructions: Schema.String,
    threshold: Threshold,
    options: Schema.Record(Schema.String, Schema.String),
    passing: Schema.Array(Schema.String),
  }).check(
    Schema.makeFilter(
      (rule) =>
        Object.keys(rule.options).length >= 2 &&
        Object.keys(rule.options).length <= 255 &&
        rule.passing.length > 0 &&
        rule.passing.every((key) => Object.hasOwn(rule.options, key)),
    ),
  ),
  Schema.Struct({
    ...common,
    _tag: Schema.Literal("Score"),
    instructions: Schema.String,
    levels: Schema.Array(Schema.String).check(Schema.isMinLength(2), Schema.isMaxLength(10)),
  }),
])
export const RulesSchema = Schema.Array(RuleSchema).check(
  Schema.makeFilter((rules) => new Set(rules.map((rule) => rule.id)).size === rules.length),
)

export const noul = (args: {
  readonly id: string
  readonly statement: string
  readonly severity?: Severity
  readonly threshold?: number
  readonly include?: ReadonlyArray<string>
  readonly exclude?: ReadonlyArray<string>
  readonly examples?: RuleExamples
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
    exclude: args.exclude,
    examples: args.examples,
  }
}

export const choice = (args: {
  readonly id: string
  readonly instructions: string
  readonly options: Record<string, string>
  readonly passing: ReadonlyArray<string>
  readonly severity?: Severity
  readonly threshold?: number
  readonly include?: ReadonlyArray<string>
  readonly exclude?: ReadonlyArray<string>
}): ChoiceRule => {
  const threshold = args.threshold ?? 0.75
  if (!checkThreshold(threshold)) {
    throw new InvalidRule({ reason: `threshold must be 0..1, got ${threshold}` })
  }
  const keys = Object.keys(args.options)
  if (keys.length < 2) throw new InvalidRule({ reason: "choice needs >= 2 options" })
  if (keys.length > 255) throw new InvalidRule({ reason: "choice supports max 255 options" })
  if (
    !Array.isArray(args.passing) ||
    args.passing.length === 0 ||
    args.passing.some((key) => !keys.includes(key))
  ) {
    throw new InvalidRule({ reason: "choice needs explicit passing option keys" })
  }
  return {
    _tag: "Choice",
    id: args.id,
    instructions: args.instructions,
    options: args.options,
    passing: args.passing,
    severity: args.severity ?? "comment",
    threshold,
    include: args.include,
    exclude: args.exclude,
  }
}

export const score = (args: {
  readonly id: string
  readonly instructions: string
  readonly levels: ReadonlyArray<string>
  readonly severity?: Severity
  readonly include?: ReadonlyArray<string>
  readonly exclude?: ReadonlyArray<string>
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
    exclude: args.exclude,
  }
}

export const define = (rules: ReadonlyArray<Rule>): ReadonlyArray<Rule> => {
  if (!Schema.is(RulesSchema)(rules))
    throw new InvalidRule({ reason: "Invalid rules or duplicate ids" })
  return rules
}

export const matchesFile = (rule: Rule, file: string): boolean => {
  const patterns = rule.include
  if (
    patterns !== undefined &&
    patterns.length > 0 &&
    !patterns.some((pattern) => globMatch(pattern, file))
  ) {
    return false
  }
  const excluded = rule.exclude
  if (excluded !== undefined && excluded.some((pattern) => globMatch(pattern, file))) return false
  return true
}

export type FileRole = "test" | "config" | "docs" | "source"

/** Classify a path so judgments can weigh what kind of file they're looking at. */
export const roleForFile = (file: string): FileRole => {
  if (
    file.endsWith(".test.ts") ||
    file.endsWith(".test.js") ||
    file.endsWith(".spec.ts") ||
    file.includes("/test/") ||
    file.includes("/tests/") ||
    file.includes("__tests__")
  ) {
    return "test"
  }
  if (/\.(yml|yaml|toml|ini|json|jsonc)$/.test(file) || file.includes(".github/")) return "config"
  if (file.endsWith(".md") || file.includes("/docs/")) return "docs"
  return "source"
}

const roleGuidance: Record<FileRole, string | undefined> = {
  test: "This is a test file: environment-variable gating, async test callbacks, and console output for debugging failures are normal and acceptable. Judge business-logic rules leniently here.",
  config:
    "This is a config file: judge it against the rule only if the rule clearly applies to configuration.",
  docs: "This is documentation: code-style rules do not apply unless the rule says so.",
  source: undefined,
}

/** Append file-role context so Jev weighs the path, not just the diff text. */
export const withFileContext = (instructions: string, file: string): string => {
  const guidance = roleGuidance[roleForFile(file)]
  if (guidance === undefined) return `${instructions} File under review: ${file}.`
  return `${instructions} File under review: ${file} (${roleForFile(file)} file). ${guidance}`
}

/** Minimal glob: double-star crosses directories, star stays within a segment, ? is one char. */
export const globMatch = (pattern: string, file: string): boolean => {
  let out = "^"
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i]
    if (c === "*" && pattern[i + 1] === "*") {
      out += pattern[i + 2] === "/" ? "(.*/)?" : ".*"
      i += pattern[i + 2] === "/" ? 3 : 2
    } else if (c === "*") {
      out += "[^/]*"
      i += 1
    } else if (c === "?") {
      out += "[^/]"
      i += 1
    } else if (c === undefined) {
      i += 1
    } else if ("+^${}()|[]\\".includes(c) || c === ".") {
      out += `\\${c}`
      i += 1
    } else {
      out += c
      i += 1
    }
  }
  return new RegExp(`${out}$`).test(file)
}
