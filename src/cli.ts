#!/usr/bin/env bun
import {
  NodeChildProcessSpawner,
  NodeFileSystem,
  NodePath,
  NodeRuntime,
  NodeStdio,
  NodeTerminal,
} from "@effect/platform-node"
import { Data, Effect, Layer } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import { resolve } from "node:path"
import { GithubError, postInlineComments, targetFromEnv } from "./Github.ts"
import { layer as JevLive, JevError } from "./Jev.ts"
import { effectStrict } from "./presets.ts"
import { reviewDiff, splitDiff } from "./Review.ts"
import { type Rule } from "./Rule.ts"

export class BlockingFlags extends Data.TaggedError("BlockingFlags")<{
  readonly count: number
}> {}

export class BadArgs extends Data.TaggedError("BadArgs")<{
  readonly message: string
}> {}

export class MissingTarget extends Data.TaggedError("MissingTarget")<{
  readonly message: string
}> {}

const gitDiff = (base: string, head: string): Effect.Effect<string, GithubError> =>
  Effect.try({
    try: () => {
      const proc = Bun.spawnSync(["git", "diff", `${base}...${head}`, "--", "."])
      if (proc.exitCode !== 0)
        throw new Error(`git diff failed: ${proc.stderr.toString().slice(0, 200)}`)
      return proc.stdout.toString()
    },
    catch: (e) =>
      e instanceof GithubError ? e : new GithubError({ status: undefined, message: String(e) }),
  })

const parseConfidence = (raw: string): Effect.Effect<number, BadArgs> => {
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    return Effect.fail(new BadArgs({ message: `--min-confidence must be 0..1, got ${raw}` }))
  }
  return Effect.succeed(value)
}

export const isRuleArray = (value: unknown): value is ReadonlyArray<Rule> =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every(
    (item): item is Rule =>
      typeof item === "object" &&
      item !== null &&
      (item as { _tag?: unknown })._tag !== undefined &&
      ["Noul", "Choice", "Score"].includes((item as { _tag: unknown })._tag as string) &&
      typeof (item as { id?: unknown }).id === "string",
  )

/** Load a rule file (TS module default-exporting a Rule[]) or fall back to the built-in preset. */
export const loadRules = (path: string): Effect.Effect<ReadonlyArray<Rule>, BadArgs> =>
  Effect.gen(function* () {
    if (path === "") return effectStrict
    const mod = (yield* Effect.tryPromise({
      try: () => import(resolve(process.cwd(), path)) as Promise<{ default?: unknown }>,
      catch: (e) =>
        new BadArgs({ message: `--rules: cannot load ${path}: ${String(e).slice(0, 200)}` }),
    })) as { default?: unknown }
    const rules = (mod as { default?: unknown }).default ?? (mod as { rules?: unknown }).rules
    if (!isRuleArray(rules)) {
      return yield* new BadArgs({
        message: `--rules: ${path} must default-export a non-empty Rule[] (see proof.rules.ts example)`,
      })
    }
    return rules
  })

const review = Command.make(
  "review",
  {
    base: Flag.String("base").pipe(
      Flag.withDescription("Git base ref for the diff (default: origin/main)"),
      Flag.withDefault("origin/main"),
    ),
    head: Flag.String("head").pipe(
      Flag.withDescription("Git head ref for the diff (default: HEAD)"),
      Flag.withDefault("HEAD"),
    ),
    failOn: Flag.String("fail-on").pipe(
      Flag.withDescription("Severity that fails the command: comment or request-changes"),
      Flag.withDefault("request-changes"),
    ),
    minConfidence: Flag.String("min-confidence").pipe(
      Flag.withDescription("Minimum confidence (0..1) for a flag to fail the command"),
      Flag.withDefault("0.85"),
    ),
    format: Flag.String("format").pipe(
      Flag.withDescription("Output format: annotations (GitHub), json, or summary"),
      Flag.withDefault("annotations"),
    ),
    comment: Flag.Boolean("comment").pipe(
      Flag.withDescription(
        "Post inline PR comments on flagged lines (needs --repo/--pr/--commit or GITHUB_* env + GITHUB_TOKEN)",
      ),
      Flag.withDefault(false),
    ),
    repo: Flag.String("repo").pipe(
      Flag.withDescription("owner/repo for inline comments (default: $GITHUB_REPOSITORY)"),
      Flag.withDefault(""),
    ),
    pr: Flag.String("pr").pipe(
      Flag.withDescription("PR number for inline comments (default: parsed from $GITHUB_REF)"),
      Flag.withDefault(""),
    ),
    commit: Flag.String("commit").pipe(
      Flag.withDescription("PR head SHA for inline comments (default: $GITHUB_SHA)"),
      Flag.withDefault(""),
    ),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription("Print what would be commented without calling GitHub"),
      Flag.withDefault(false),
    ),
    rules: Flag.String("rules").pipe(
      Flag.withDescription(
        "Path to a rule file (TS module default-exporting Rule[]). Default: built-in Effect preset",
      ),
      Flag.withDefault(""),
    ),
  },
  (config) =>
    Effect.gen(function* () {
      const minConf = yield* parseConfidence(config.minConfidence)
      if (config.failOn !== "comment" && config.failOn !== "request-changes") {
        return yield* new BadArgs({ message: `--fail-on must be comment or request-changes` })
      }
      if (
        config.format !== "annotations" &&
        config.format !== "json" &&
        config.format !== "summary"
      ) {
        return yield* new BadArgs({ message: `--format must be annotations, json, or summary` })
      }
      const rules = yield* loadRules(config.rules)
      const diff = yield* gitDiff(config.base, config.head)
      if (splitDiff(diff).length === 0) {
        console.log("proof: no hunks, skipping")
        return
      }
      const flags = yield* reviewDiff(rules, diff).pipe(
        Effect.catchTag("EmptyDiff", () => Effect.succeed([] as const)),
        Effect.catchTag("JevError", (e) =>
          Effect.sync(() => {
            console.log(`::warning::proof backend unavailable (${e.message.slice(0, 120)}); skipping review`)
            return [] as const
          })
        ),
      )
      if (config.format === "json") {
        console.log(JSON.stringify({ flags }))
      } else if (config.format === "summary") {
        const rows = flags.map(
          (f) =>
            `| \`${f.ruleId}\` | \`${f.file}${f.line !== undefined ? `:${f.line}` : ""}\` | ${f.confidence.toFixed(2)} | ${f.severity} |`,
        )
        const body = `### proof review\n\n| rule | location | conf | severity |\n|---|---|---|---|\n${rows.join("\n") || "| — | no flags | — | — |"}`
        const summaryFile = process.env["GITHUB_STEP_SUMMARY"]
        if (summaryFile !== undefined && summaryFile !== "") {
          yield* Effect.promise(() =>
            Bun.write(Bun.file(summaryFile, { type: "text/markdown" }), `${body}\n`),
          )
        } else {
          console.log(body)
        }
      } else {
        for (const f of flags) {
          const level = f.severity === "request-changes" ? "error" : "warning"
          console.log(
            `::${level} file=${f.file}${f.line !== undefined ? `,line=${f.line}` : ""}::proof ${f.ruleId} (${f.confidence.toFixed(2)}): ${f.detail}`,
          )
        }
      }

      if (config.comment || config.dryRun) {
        const target = targetFromEnv({
          ...(config.repo === "" ? {} : { repo: config.repo }),
          ...(config.pr === "" ? {} : { pr: Number(config.pr) }),
          ...(config.commit === "" ? {} : { commit: config.commit }),
        })
        if (target === undefined) {
          return yield* new MissingTarget({
            message:
              "Inline comments need --repo owner/repo, --pr N, --commit SHA (or GITHUB_REPOSITORY / GITHUB_REF / GITHUB_SHA)",
          })
        }
        if (config.dryRun) {
          const lined = flags.filter((f) => f.line !== undefined)
          for (const flag of lined) {
            console.log(
              `would comment ${target.owner}/${target.repo}#${target.pull} ${flag.file}:${flag.line} [${flag.ruleId}]`,
            )
          }
          console.log(
            `would skip ${flags.filter((f) => f.line === undefined).length} flag(s) without a target line`,
          )
        } else {
          const token = process.env["GITHUB_TOKEN"] ?? ""
          if (token === "") {
            return yield* new MissingTarget({ message: "Inline comments need GITHUB_TOKEN" })
          }
          const result = yield* postInlineComments(token, target, flags)
          console.log(
            `proof: posted ${result.posted}, skipped ${result.skipped} (already commented), ${result.noLine} without a target line`,
          )
        }
      }

      const blocking = flags.filter((f) => f.severity === config.failOn && f.confidence >= minConf)
      if (blocking.length > 0) {
        return yield* new BlockingFlags({ count: blocking.length })
      }
      console.log(`proof: ${flags.length} flag(s), none blocking`)
    }).pipe(Effect.provide(JevLive)),
).pipe(Command.withDescription("Review a git diff with plain-english rules judged by Jev"))

const cli = Command.make("proof").pipe(
  Command.withSubcommands([review]),
  Command.withDescription("Plain-english code review judged by Jev"),
)

const CliLive = Layer.mergeAll(
  NodeTerminal.layer,
  NodeStdio.layer,
  NodeChildProcessSpawner.layer,
).pipe(Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)))

Command.run(cli, { version: "0.2.0" }).pipe(Effect.provide(CliLive), NodeRuntime.runMain)
