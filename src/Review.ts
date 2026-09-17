import { Data, Effect } from "effect"
import { Jev, JevError } from "./Jev.ts"
import { matchesFile, type ChoiceRule, type NoulRule, type Rule, type ScoreRule } from "./Rule.ts"

export interface Hunk {
  readonly file: string
  readonly diff: string
  readonly content?: string
}

export interface Flag {
  readonly ruleId: string
  readonly file: string
  readonly confidence: number
  readonly severity: Rule["severity"]
  readonly detail: string
}

export class EmptyDiff extends Data.TaggedError("EmptyDiff")<{
  readonly message: string
}> {}

/** Split a unified diff into per-file hunks. Falls back to one hunk per file header. */
export const splitDiff = (diff: string): ReadonlyArray<Hunk> => {
  const files: Array<Hunk> = []
  const headerRe = /^diff --git a\/(.+?) b\/(.+?)$/gm
  const headers = [...diff.matchAll(headerRe)]
  if (headers.length === 0) {
    const trimmed = diff.trim()
    if (trimmed.length === 0) return []
    return [{ file: "unknown", diff: trimmed }]
  }
  for (let i = 0; i < headers.length; i++) {
    const match = headers[i]
    if (match?.index === undefined) continue
    const next = headers[i + 1]
    const chunk = diff.slice(match.index, next?.index).trim()
    const file = match[2] ?? match[1] ?? "unknown"
    if (chunk.length > 0) files.push({ file, diff: chunk })
  }
  return files
}

type CheckError = JevError

const checkNoul = (rule: NoulRule, hunk: Hunk): Effect.Effect<Flag | null, CheckError, Jev> =>
  Effect.gen(function* () {
    const jev = yield* Jev
    const ans = yield* jev.askNoul(
      { file: hunk.file, diff: hunk.diff, content: hunk.content ?? null },
      `Does this diff violate the following rule? Rule: ${rule.statement}`,
    )
    if (ans.noul >= rule.threshold) {
      return {
        ruleId: rule.id,
        file: hunk.file,
        confidence: ans.noul,
        severity: rule.severity,
        detail: `Violates ${rule.id} (noul ${ans.noul.toFixed(2)})`,
      } satisfies Flag
    }
    return null
  })

const checkChoice = (rule: ChoiceRule, hunk: Hunk): Effect.Effect<Flag | null, CheckError, Jev> =>
  Effect.gen(function* () {
    const jev = yield* Jev
    const ans = yield* jev.askChoice(
      { file: hunk.file, diff: hunk.diff, content: hunk.content ?? null },
      rule.instructions,
      rule.options,
    )
    const first = Object.keys(rule.options)[0]
    if (ans.choice !== first && ans.confidence >= rule.threshold) {
      return {
        ruleId: rule.id,
        file: hunk.file,
        confidence: ans.confidence,
        severity: rule.severity,
        detail: `${rule.id}: chose ${ans.choice} (conf ${ans.confidence.toFixed(2)})`,
      } satisfies Flag
    }
    return null
  })

export const checkHunk = (rule: Rule, hunk: Hunk): Effect.Effect<Flag | null, CheckError, Jev> => {
  if (!matchesFile(rule, hunk.file)) return Effect.succeed(null)
  switch (rule._tag) {
    case "Noul":
      return checkNoul(rule, hunk)
    case "Choice":
      return checkChoice(rule, hunk)
    case "Score":
      return Effect.succeed(null)
  }
}

export const reviewDiff = (
  rules: ReadonlyArray<Rule>,
  diff: string,
  options?: { readonly concurrency?: number },
): Effect.Effect<ReadonlyArray<Flag>, EmptyDiff | CheckError, Jev> =>
  Effect.gen(function* () {
    const hunks = splitDiff(diff)
    if (hunks.length === 0) return yield* new EmptyDiff({ message: "No hunks in diff" })
    const pairs: Array<{ readonly rule: Rule; readonly hunk: Hunk }> = []
    for (const hunk of hunks) {
      for (const rule of rules) pairs.push({ rule, hunk })
    }
    const results = yield* Effect.forEach(pairs, ({ rule, hunk }) => checkHunk(rule, hunk), {
      concurrency: options?.concurrency ?? 5,
    })
    return results.filter((flag): flag is Flag => flag !== null)
  })

/** Score-only helper: returns the raw idiomatic score for ranking. */
export const scoreHunk = (rule: ScoreRule, hunk: Hunk): Effect.Effect<number, CheckError, Jev> =>
  Effect.gen(function* () {
    const jev = yield* Jev
    const ans = yield* jev.askScore(
      { file: hunk.file, diff: hunk.diff },
      rule.instructions,
      rule.levels,
    )
    return ans.score
  })
