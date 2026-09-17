import { createHash } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { EmptyDiff, checkHunkBatched, type Flag, type Hunk } from "./Review.ts"
import type { Rule } from "./Rule.ts"
import { matchesFile } from "./Rule.ts"

const IGNORED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".git",
  ".hg",
  ".svn",
  ".turbo",
  ".next",
  "out",
])

const IGNORED_FILE_PATTERNS = [
  /\.lock$/,
  /\.tgz$/,
  /\.(png|jpe?g|gif|ico|woff2?|ttf|eot|wasm|pdf|mp4|mov|zip|sqlite|db)$/,
]

/** Walk roots like a linter: explicit files honoured, directories recursed with standard ignores. */
export const collectFiles = (
  roots: ReadonlyArray<string>,
  rules: ReadonlyArray<Rule>,
): Array<string> => {
  const out: Array<string> = []
  const walk = (path: string, explicit: boolean) => {
    let stat
    try {
      stat = statSync(path)
    } catch {
      return
    }
    if (stat.isFile()) {
      if (
        !IGNORED_FILE_PATTERNS.some((pattern) => pattern.test(path)) &&
        rules.some((rule) => matchesFile(rule, path))
      ) {
        out.push(path)
      }
      return
    }
    if (!stat.isDirectory()) return
    if (
      !explicit &&
      path.split("/").some((segment) => segment.startsWith(".") || IGNORED_DIRS.has(segment))
    ) {
      return
    }
    let entries: Array<string>
    try {
      entries = readdirSync(path)
    } catch {
      return
    }
    for (const entry of entries) walk(join(path, entry), false)
  }
  for (const root of roots) walk(root, true)
  return [...new Set(out)].toSorted()
}

/** Slice file content into fixed windows; flags point at the window start. */
export const chunkFile = (file: string, content: string, size = 50): Array<Hunk> => {
  if (content.includes("\0")) return []
  const lines = content.split("\n")
  const chunks: Array<Hunk> = []
  for (let start = 0; start < lines.length; start += size) {
    const slice = lines.slice(start, start + size)
    if (slice.join("").trim() === "") continue
    chunks.push({ file, diff: slice.join("\n"), targetLine: start + 1 })
  }
  return chunks
}

export const readText = (file: string): string | undefined => {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

export const sha = (content: string): string =>
  createHash("sha256").update(content).digest("hex").slice(0, 16)

export const rulesHash = (rules: ReadonlyArray<Rule>): string => sha(JSON.stringify(rules))

export const cacheKey = (file: string, content: string, rulesDigest: string): string =>
  `${file}:${sha(content)}:${rulesDigest}`

const cachePath = (cwd: string): string => join(cwd, ".proof", "cache.json")

export const loadCache = (cwd: string): Record<string, ReadonlyArray<Flag>> => {
  try {
    const raw = JSON.parse(readFileSync(cachePath(cwd), "utf8")) as unknown
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {}
    return raw as Record<string, ReadonlyArray<Flag>>
  } catch {
    return {}
  }
}

export const saveCache = (cwd: string, entries: Record<string, ReadonlyArray<Flag>>): void => {
  try {
    mkdirSync(join(cwd, ".proof"), { recursive: true })
    const merged = { ...loadCache(cwd), ...entries }
    writeFileSync(cachePath(cwd), `${JSON.stringify(merged)}\n`)
  } catch {
    // cache is best-effort; never fail a review over it
  }
}

/** Lint whole files: chunk, reuse cache hits, judge misses with one batched Jev call per chunk. */
export const lintFiles = (
  rules: ReadonlyArray<Rule>,
  files: ReadonlyArray<string>,
  options?: {
    readonly chunkLines?: number
    /** Parallel Jev calls. Jev is a parallel sampler; 20 is a safe default. */
    readonly concurrency?: number
    /** Directory holding .proof/cache.json. Defaults to cwd. Pass false to disable the cache. */
    readonly cacheDir?: string | false
  },
): Effect.Effect<
  { readonly flags: ReadonlyArray<Flag>; readonly checked: number; readonly cached: number },
  EmptyDiff | import("./Jev.ts").JevError,
  import("./Jev.ts").Jev
> =>
  Effect.gen(function* () {
    const size = options?.chunkLines ?? 50
    const useCache = options?.cacheDir !== false
    const cwd =
      options?.cacheDir === undefined || options?.cacheDir === false
        ? process.cwd()
        : options.cacheDir
    const digest = rulesHash(rules)
    const cache = useCache ? loadCache(cwd) : {}
    const chunks: Array<{ readonly hunk: Hunk; readonly key: string }> = []
    for (const file of files) {
      const content = readText(file)
      if (content === undefined) continue
      for (const hunk of chunkFile(file, content, size)) {
        chunks.push({ hunk, key: cacheKey(file, content, digest) + `#${hunk.targetLine}` })
      }
    }
    if (chunks.length === 0) return yield* new EmptyDiff({ message: "No lintable content" })
    const fresh: typeof chunks = []
    const flags: Array<Flag> = []
    for (const chunk of chunks) {
      const hit = cache[chunk.key]
      if (hit !== undefined) flags.push(...hit)
      else fresh.push(chunk)
    }
    const results = yield* Effect.forEach(fresh, (chunk) => checkHunkBatched(rules, chunk.hunk), {
      concurrency: options?.concurrency ?? 20,
    })
    const entries: Record<string, ReadonlyArray<Flag>> = {}
    fresh.forEach((chunk, i) => {
      const found = results[i] ?? []
      entries[chunk.key] = found
      flags.push(...found)
    })
    if (useCache) saveCache(cwd, entries)
    return { flags, checked: chunks.length, cached: chunks.length - fresh.length }
  })
