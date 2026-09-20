import { expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

it("direct comparisons support first pushes and include differences hidden by merge-base review", () => {
  const root = mkdtempSync(join(tmpdir(), "proof-diff-"))
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: root })
    expect(result.status, result.stderr.toString()).toBe(0)
    return result.stdout.toString().trim()
  }
  const commit = () => {
    git("add", ".")
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "fixture",
    )
    return git("rev-parse", "HEAD")
  }
  const diff = (base: string, head: string, direct: boolean) => {
    const script = `import * as Effect from ${JSON.stringify(import.meta.resolve("effect/Effect"))};
      import { gitDiff } from ${JSON.stringify(new URL("../src/cli.ts", import.meta.url).href)};
      console.log(await Effect.runPromise(gitDiff(${JSON.stringify(base)}, ${JSON.stringify(head)}, ${direct})));`
    const result = spawnSync("bun", ["-e", script], { cwd: root })
    expect(result.status, result.stderr.toString()).toBe(0)
    return result.stdout.toString()
  }
  try {
    git("init", "-q")
    writeFileSync(join(root, "initial.ts"), "export const initial = 1\n")
    const base = commit()
    writeFileSync(join(root, "feature.ts"), "export const feature = 2\n")
    const head = commit()
    git("checkout", "-q", "--detach", base)
    writeFileSync(join(root, "base-only.ts"), "export const later = 3\n")
    const advancedBase = commit()
    expect(diff(advancedBase, head, false)).toContain("+export const feature = 2")
    expect(diff(advancedBase, head, false)).not.toContain("base-only.ts")
    expect(diff(advancedBase, head, true)).toContain("-export const later = 3")
    const empty = git("hash-object", "-w", "-t", "tree", "/dev/null")
    const firstPush = diff(empty, head, true)
    expect(firstPush).toContain("+export const initial = 1")
    expect(firstPush).toContain("+export const feature = 2")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
