import { Data, Effect } from "effect"
import { Jev, JevError } from "./Jev.ts"
import {
  matchesFile,
  withFileContext,
  type ChoiceRule,
  type NoulRule,
  type Rule,
  type ScoreRule,
} from "./Rule.ts"

export interface Hunk {
  readonly file: string
  readonly diff: string
  readonly content?: string
  /** First added line number in the new file, for inline review comments. Absent for pure deletions. */
  readonly targetLine: number | undefined
}

export interface Flag {
  readonly ruleId: string
  readonly file: string
  readonly confidence: number
  readonly severity: Rule["severity"]
  readonly detail: string
  readonly line: number | undefined
}

export class EmptyDiff extends Data.TaggedError("EmptyDiff")<{
  readonly message: string
}> {}

/** First added line number (new-file side) in a unified diff chunk. */
export const firstAddedLine = (chunk: string): number | undefined => {
  const lines = chunk.split("\n")
  let newLine = 0
  let inHunk = false
  for (const line of lines) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (header?.[1] !== undefined) {
      newLine = Number(header[1])
      inHunk = true
      continue
    }
    if (!inHunk) continue
    if (line.startsWith("+") && !line.startsWith("+++")) return newLine
    if (line.startsWith(" ")) newLine += 1
    else if (line.startsWith("-") && !line.startsWith("---")) {
      // deletion: new-file line number unchanged
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file": ignore
    } else if (line.trim() === "") {
      // tolerant: blank line counts as context only inside a hunk body
      newLine += 1
    }
  }
  return undefined
}

/** Split a unified diff into per-file hunks. Falls back to one hunk per file header. */
export const splitDiff = (diff: string): ReadonlyArray<Hunk> => {
  const files: Array<Hunk> = []
  const headerRe = /^diff --git a\/(.+?) b\/(.+?)$/gm
  const headers = [...diff.matchAll(headerRe)]
  if (headers.length === 0) {
    const trimmed = diff.trim()
    if (trimmed.length === 0) return []
    return [{ file: "unknown", diff: trimmed, targetLine: firstAddedLine(trimmed) }]
  }
  for (let i = 0; i < headers.length; i++) {
    const match = headers[i]
    if (match?.index === undefined) continue
    const next = headers[i + 1]
    const chunk = diff.slice(match.index, next?.index).trim()
    const file = match[2] ?? match[1] ?? "unknown"
    if (chunk.length > 0) files.push({ file, diff: chunk, targetLine: firstAddedLine(chunk) })
  }
  return files
}

type CheckError = JevError

/** Build the Jev question for a Noul rule, with few-shot boundary examples when present. */
export const noulQuestion = (
  rule: NoulRule,
  hunk: Hunk,
): { readonly instructions: string; readonly criteria: { readonly true: unknown; readonly false: unknown } | undefined } => {
  const instructions = withFileContext(
    `Does this diff violate the following rule? Rule: ${rule.statement}`,
    hunk.file,
  )
  if (rule.examples === undefined) return { instructions, criteria: undefined }
  return {
    instructions,
    criteria: {
      true: { what: `Violates the rule: ${rule.statement}`, examples: [...rule.examples.violate] },
      false: { what: "Does not violate the rule", examples: [...rule.examples.clean] },
    },
  }
}

const interpretNoul = (rule: NoulRule, hunk: Hunk, noul: number): Flag | null => {
  if (noul < rule.threshold) return null
  return {
    ruleId: rule.id,
    file: hunk.file,
    confidence: noul,
    severity: rule.severity,
    detail: `Violates ${rule.id} (noul ${noul.toFixed(2)})`,
    line: hunk.targetLine,
  }
}

const interpretChoice = (
  rule: ChoiceRule,
  hunk: Hunk,
  choice: string,
  confidence: number,
): Flag | null => {
  const first = Object.keys(rule.options)[0]
  if (choice === first || confidence < rule.threshold) return null
  return {
    ruleId: rule.id,
    file: hunk.file,
    confidence,
    severity: rule.severity,
    detail: `${rule.id}: chose ${choice} (conf ${confidence.toFixed(2)})`,
    line: hunk.targetLine,
  }
}

export const checkHunk = (rule: Rule, hunk: Hunk): Effect.Effect<Flag | null, CheckError, Jev> =>
  Effect.gen(function* () {
    if (!matchesFile(rule, hunk.file)) return null
    const jev = yield* Jev
    const state = { file: hunk.file, diff: hunk.diff, content: hunk.content ?? null }
    switch (rule._tag) {
      case "Noul": {
        const q = noulQuestion(rule, hunk)
        const ans = yield* jev.askNoul(state, q.instructions, q.criteria)
        return interpretNoul(rule, hunk, ans.noul)
      }
      case "Choice": {
        const ans = yield* jev.askChoice(
          state,
          withFileContext(rule.instructions, hunk.file),
          rule.options,
        )
        return interpretChoice(rule, hunk, ans.choice, ans.confidence)
      }
      case "Score":
        return null
    }
  })

/** Review one hunk with a single batched Jev call: one question per applicable rule. */
export const checkHunkBatched = (
  rules: ReadonlyArray<Rule>,
  hunk: Hunk,
): Effect.Effect<ReadonlyArray<Flag>, CheckError, Jev> =>
  Effect.gen(function* () {
    const applicable = rules.filter((rule) => matchesFile(rule, hunk.file))
    const judged = applicable.filter((rule) => rule._tag === "Noul" || rule._tag === "Choice")
    if (judged.length === 0) return []
    const jev = yield* Jev
    const state = { file: hunk.file, diff: hunk.diff, content: hunk.content ?? null }
    const questions: Record<string, import("./Jev.ts").BatchQuestion> = {}
    for (const rule of judged) {
      if (rule._tag === "Noul") {
        const q = noulQuestion(rule, hunk)
        questions[rule.id] = q.criteria === undefined
          ? { type: "noul", instructions: q.instructions }
          : { type: "noul", instructions: q.instructions, criteria: q.criteria }
      } else if (rule._tag === "Choice") {
        questions[rule.id] = {
          type: "choice",
          instructions: withFileContext(rule.instructions, hunk.file),
          criteria: rule.options,
        }
      }
    }
    const answers = yield* jev.askBatch(state, questions)
    const flags: Array<Flag> = []
    for (const rule of judged) {
      const ans = answers[rule.id]
      if (ans === undefined) continue
      if (rule._tag === "Noul" && "noul" in ans) {
        const flag = interpretNoul(rule, hunk, ans.noul)
        if (flag !== null) flags.push(flag)
      } else if (rule._tag === "Choice" && "choice" in ans && "confidence" in ans) {
        const flag = interpretChoice(rule, hunk, ans.choice, ans.confidence)
        if (flag !== null) flags.push(flag)
      }
    }
    return flags
  })

export const reviewDiff = (
  rules: ReadonlyArray<Rule>,
  diff: string,
  options?: { readonly concurrency?: number },
): Effect.Effect<ReadonlyArray<Flag>, EmptyDiff | CheckError, Jev> =>
  Effect.gen(function* () {
    const hunks = splitDiff(diff)
    if (hunks.length === 0) return yield* new EmptyDiff({ message: "No hunks in diff" })
    const nested = yield* Effect.forEach(hunks, (hunk) => checkHunkBatched(rules, hunk), {
      concurrency: options?.concurrency ?? 5,
    })
    return nested.flat()
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
