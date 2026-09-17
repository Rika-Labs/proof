import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Effect } from "effect"
import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { Jev } from "../src/Jev.ts"
import {
  cacheKey,
  chunkFile,
  collectFiles,
  lintFiles,
  loadCache,
  rulesHash,
  saveCache,
  sha,
} from "../src/Lint.ts"
import { noul } from "../src/Rule.ts"

describe("chunkFile", () => {
  it("windows content with absolute offsets", () => {
    const content = Array.from({ length: 120 }, (_, i) => `line ${i + 1}`).join("\n")
    const chunks = chunkFile("a.ts", content, 50)
    expect(chunks).toHaveLength(3)
    expect(chunks[0]?.targetLine).toBe(1)
    expect(chunks[1]?.targetLine).toBe(51)
    expect(chunks[2]?.targetLine).toBe(101)
  })

  it("skips blank windows and binary content", () => {
    expect(chunkFile("a.ts", "\n\n   \n", 50)).toEqual([])
    expect(chunkFile("a.bin", "ab\0cd", 50)).toEqual([])
  })
})

describe("sha and cache keys", () => {
  it("is deterministic and content-sensitive", () => {
    expect(sha("x")).toBe(sha("x"))
    expect(sha("x")).not.toBe(sha("y"))
    expect(rulesHash([noul({ id: "a", statement: "s" })])).toBe(
      rulesHash([noul({ id: "a", statement: "s" })]),
    )
  })

  it("loadCache tolerates missing files", () => {
    expect(loadCache(join(tmpdir(), "proof-no-such-dir"))).toEqual({})
  })

  it("saveCache round-trips", () => {
    const dir = join(tmpdir(), `proof-cache-${process.pid}`)
    mkdirSync(dir, { recursive: true })
    try {
      saveCache(dir, { k: [] })
      expect(loadCache(dir)).toEqual({ k: [] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("cacheKey binds file, content, and rules", () => {
    const a = cacheKey("f.ts", "x", "r1")
    expect(a).toBe(cacheKey("f.ts", "x", "r1"))
    expect(a).not.toBe(cacheKey("f.ts", "y", "r1"))
    expect(a).not.toBe(cacheKey("f.ts", "x", "r2"))
  })
})

describe("collectFiles", () => {
  const root = join(tmpdir(), `proof-walk-${process.pid}`)
  beforeEach(() => {
    rmSync(root, { recursive: true, force: true })
    mkdirSync(join(root, "src"), { recursive: true })
    mkdirSync(join(root, "node_modules", "dep"), { recursive: true })
    mkdirSync(join(root, ".git"), { recursive: true })
    writeFileSync(join(root, "src", "a.ts"), "const a = 1\n")
    writeFileSync(join(root, "src", "b.test.ts"), "const b = 1\n")
    writeFileSync(join(root, "node_modules", "dep", "c.ts"), "const c = 1\n")
    writeFileSync(join(root, ".git", "d.ts"), "const d = 1\n")
    writeFileSync(join(root, "bun.lock"), "lock\n")
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it("walks sources, skipping ignored dirs and lockfiles", () => {
    const rules = [noul({ id: "x", statement: "s", include: ["**/*.ts"] })]
    const files = collectFiles([root], rules)
    expect(files).toContain(join(root, "src", "a.ts"))
    expect(files).toContain(join(root, "src", "b.test.ts"))
    expect(files.some((f) => f.includes("node_modules"))).toBe(false)
    expect(files.some((f) => f.includes(".git"))).toBe(false)
    expect(files.some((f) => f.endsWith(".lock"))).toBe(false)
  })

  it("applies rule include and exclude", () => {
    const rules = [
      noul({ id: "x", statement: "s", include: ["**/src/**/*.ts"], exclude: ["**/*.test.ts"] }),
    ]
    const files = collectFiles([root], rules)
    expect(files).toEqual([join(root, "src", "a.ts")])
  })
})

describe("lintFiles", () => {
  const stub = Jev.of({
    askBatch: (_state, questions) =>
      Effect.succeed(Object.fromEntries(Object.keys(questions).map((id) => [id, { noul: 0.9 }]))),
    askNoul: () => Effect.succeed({ noul: 0 }),
    askChoice: () => Effect.succeed({ choice: "a", confidence: 0, probabilities: {} }),
    askScore: () => Effect.succeed({ score: 0, confidence: 0, probabilities: {}, legend: {} }),
  })
  const root = join(tmpdir(), `proof-lint-${process.pid}`)

  beforeEach(() => {
    rmSync(root, { recursive: true, force: true })
    mkdirSync(join(root, "src"), { recursive: true })
    writeFileSync(join(root, "src", "a.ts"), `${"const a = 1\n".repeat(60)}`)
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it("judges misses then serves cache hits without Jev", async () => {
    const rules = [noul({ id: "x", statement: "s", threshold: 0.5 })]
    const files = [`${root}/src/a.ts`]
    const first = await Effect.runPromise(
      lintFiles(rules, files, { chunkLines: 50, cacheDir: root }).pipe(
        Effect.provideService(Jev, stub),
      ),
    )
    expect(first.checked).toBe(2)
    expect(first.cached).toBe(0)
    expect(first.flags).toHaveLength(2)

    const exploding = Jev.of({
      askBatch: () => Effect.die("must not call Jev on cache hit"),
      askNoul: () => Effect.die("must not call Jev on cache hit"),
      askChoice: () => Effect.die("must not call Jev on cache hit"),
      askScore: () => Effect.die("must not call Jev on cache hit"),
    })
    const second = await Effect.runPromise(
      lintFiles(rules, files, { chunkLines: 50, cacheDir: root }).pipe(
        Effect.provideService(Jev, exploding),
      ),
    )
    expect(second.cached).toBe(2)
    expect(second.flags).toHaveLength(2)
  })
})
