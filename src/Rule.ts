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
  readonly exclude: ReadonlyArray<string> | undefined
}

export interface ChoiceRule {
  readonly _tag: "Choice"
  readonly id: string
  readonly instructions: string
  readonly options: Record<string, string>
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

const checkThreshold = (threshold: number): boolean => threshold >= 0 && threshold <= 1

export const noul = (args: {
  readonly id: string
  readonly statement: string
  readonly severity?: Severity
  readonly threshold?: number
  readonly include?: ReadonlyArray<string>
  readonly exclude?: ReadonlyArray<string>
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
  }
}

export const choice = (args: {
  readonly id: string
  readonly instructions: string
  readonly options: Record<string, string>
  readonly severity?: Severity
  readonly threshold?: number
  readonly include?: ReadonlyArray<string>
  readonly exclude?: ReadonlyArray<string>
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

export const define = (args: { readonly rules: ReadonlyArray<Rule> }) => args

export const matchesFile = (rule: Rule, file: string): boolean => {
  const patterns = rule.include
  if (patterns !== undefined && patterns.length > 0 && !patterns.some((pattern) => globMatch(pattern, file))) {
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
    file.endsWith(".test.ts") || file.endsWith(".test.js") || file.endsWith(".spec.ts") ||
    file.includes("/test/") || file.includes("/tests/") || file.includes("__tests__")
  ) {
    return "test"
  }
  if (/\.(yml|yaml|toml|ini|json|jsonc)$/.test(file) || file.includes(".github/")) return "config"
  if (file.endsWith(".md") || file.includes("/docs/")) return "docs"
  return "source"
}

const roleGuidance: Record<FileRole, string | undefined> = {
  test:
    "This is a test file: environment-variable gating, async test callbacks, and console output for debugging failures are normal and acceptable. Judge business-logic rules leniently here.",
  config: "This is a config file: judge it against the rule only if the rule clearly applies to configuration.",
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
