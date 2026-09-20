#!/usr/bin/env bun
import {
  NodeChildProcessSpawner,
  NodeFileSystem,
  NodePath,
  NodeRuntime,
  NodeStdio,
  NodeTerminal,
} from "@effect/platform-node"
import { Data, Effect, Layer, Logger, Schema } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { McpProtocol, McpServer } from "effect/unstable/ai"
import pkg from "../package.json" with { type: "json" }
import { GithubError, postInlineComments, targetFromEnv } from "./Github.ts"
import { layer as JevLive } from "./Jev.ts"
import { collectFiles, lintFiles } from "./Lint.ts"
import { EmptyDiff, reviewDiff, splitDiff, type Flag as ProofFlag } from "./Review.ts"
import { ProofToolkitLive } from "./Toolkit.ts"
import { RulesSchema, type Rule } from "./Rule.ts"

const version: string = pkg.version

export class BlockingFlags extends Data.TaggedError("BlockingFlags")<{
  readonly count: number
}> {}

export class BadArgs extends Data.TaggedError("BadArgs")<{
  readonly message: string
}> {}

export class MissingTarget extends Data.TaggedError("MissingTarget")<{
  readonly message: string
}> {}

export const gitDiff = (
  base: string,
  head: string,
  direct = false,
): Effect.Effect<string, GithubError> =>
  Effect.try({
    try: () => {
      const refs = direct ? [base, head] : [`${base}...${head}`]
      const proc = Bun.spawnSync(["git", "diff", "--no-ext-diff", ...refs, "--", "."])
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

type ReportFormat = "annotations" | "json" | "summary"

const parseFormat = (raw: string): Effect.Effect<ReportFormat, BadArgs> => {
  if (raw === "annotations" || raw === "json" || raw === "summary") return Effect.succeed(raw)
  return Effect.fail(new BadArgs({ message: `--format must be annotations, json, or summary` }))
}

const parseFailOn = (raw: string): Effect.Effect<"comment" | "request-changes", BadArgs> => {
  if (raw === "comment" || raw === "request-changes") return Effect.succeed(raw)
  return Effect.fail(new BadArgs({ message: `--fail-on must be comment or request-changes` }))
}

const reportFlags = (flags: ReadonlyArray<ProofFlag>, format: ReportFormat): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (format === "json") {
      console.log(JSON.stringify({ flags }))
    } else if (format === "summary") {
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
  })

const gateFlags = (
  flags: ReadonlyArray<ProofFlag>,
  failOn: "comment" | "request-changes",
  minConf: number,
): Effect.Effect<void, BlockingFlags> =>
  Effect.gen(function* () {
    const blocking = flags.filter((f) => f.severity === failOn && f.confidence >= minConf)
    if (blocking.length > 0) return yield* new BlockingFlags({ count: blocking.length })
    console.log(`proof: ${flags.length} flag(s), none blocking`)
  })

export const reviewOutcome = <R>(
  self: Effect.Effect<
    ReadonlyArray<ProofFlag>,
    EmptyDiff | { readonly _tag: "JevError"; readonly message: string },
    R
  >,
): Effect.Effect<
  ReadonlyArray<ProofFlag>,
  { readonly _tag: "JevError"; readonly message: string },
  R
> => self.pipe(Effect.catchTag("EmptyDiff", () => Effect.succeed([] as const)))

export const isRuleArray = (value: unknown): value is ReadonlyArray<Rule> =>
  Schema.is(RulesSchema)(value) && value.length > 0

export const RULES_FILENAME = "proof.rules.ts"

/** Find the nearest proof.rules.ts walking up from startDir toward the filesystem root. */
export const findRulesFile = (startDir: string): string | undefined => {
  let dir = resolve(startDir)
  while (true) {
    const candidate = join(dir, RULES_FILENAME)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** Load a rule file (TS module default-exporting a Rule[]); empty path discovers proof.rules.ts upward. */
export const loadRules = (path: string): Effect.Effect<ReadonlyArray<Rule>, BadArgs> =>
  Effect.gen(function* () {
    let file = path
    if (file === "") {
      const discovered = findRulesFile(process.cwd())
      if (discovered === undefined) {
        return yield* new BadArgs({
          message: `No rule file: pass --rules <path> or create ${RULES_FILENAME} in this directory or a parent`,
        })
      }
      file = discovered
    }
    const mod = (yield* Effect.tryPromise({
      try: () => import(resolve(process.cwd(), file)) as Promise<{ default?: unknown }>,
      catch: (e) =>
        new BadArgs({ message: `--rules: cannot load ${file}: ${String(e).slice(0, 200)}` }),
    })) as { default?: unknown }
    const rules = (mod as { default?: unknown }).default ?? (mod as { rules?: unknown }).rules
    if (!isRuleArray(rules)) {
      return yield* new BadArgs({
        message: `--rules: ${file} must default-export a non-empty Rule[] (see proof.rules.ts example)`,
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
    direct: Flag.Boolean("direct").pipe(
      Flag.withDescription(
        "Compare base and head trees directly instead of their merge base (for pre-push and empty-tree bases)",
      ),
      Flag.withDefault(false),
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
        "Path to a rule file (TS module default-exporting Rule[]). Default: nearest proof.rules.ts walking up from cwd",
      ),
      Flag.withDefault(""),
    ),
  },
  (config) =>
    Effect.gen(function* () {
      const minConf = yield* parseConfidence(config.minConfidence)
      const failOn = yield* parseFailOn(config.failOn)
      const format = yield* parseFormat(config.format)
      const rules = yield* loadRules(config.rules)
      const diff = yield* gitDiff(config.base, config.head, config.direct)
      if (splitDiff(diff).length === 0) {
        console.log("proof: no hunks, skipping")
        return
      }
      const flags = yield* reviewOutcome(reviewDiff(rules, diff))
      yield* reportFlags(flags, format)

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

      yield* gateFlags(flags, failOn, minConf)
    }).pipe(Effect.provide(JevLive)),
).pipe(Command.withDescription("Review a git diff with plain-english rules judged by Jev"))

const lint = Command.make(
  "lint",
  {
    paths: Argument.String("paths").pipe(
      Argument.variadic,
      Argument.withDescription("Files or directories to lint (default: current directory)"),
    ),
    rules: Flag.String("rules").pipe(
      Flag.withDescription(
        "Path to a rule file (TS module default-exporting Rule[]). Default: nearest proof.rules.ts walking up from cwd",
      ),
      Flag.withDefault(""),
    ),
    concurrency: Flag.String("concurrency").pipe(
      Flag.withDescription("Parallel Jev calls (default 20)"),
      Flag.withDefault("20"),
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
    chunkLines: Flag.String("chunk-lines").pipe(
      Flag.withDescription("Lines per file window sent to Jev"),
      Flag.withDefault("50"),
    ),
    noCache: Flag.Boolean("no-cache").pipe(
      Flag.withDescription("Ignore .proof/cache.json and re-judge everything"),
      Flag.withDefault(false),
    ),
  },
  (config) =>
    Effect.gen(function* () {
      const minConf = yield* parseConfidence(config.minConfidence)
      const failOn = yield* parseFailOn(config.failOn)
      const format = yield* parseFormat(config.format)
      const chunkLines = Number(config.chunkLines)
      if (!Number.isInteger(chunkLines) || chunkLines < 10) {
        return yield* new BadArgs({ message: `--chunk-lines must be an integer >= 10` })
      }
      const concurrency = Number(config.concurrency)
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 100) {
        return yield* new BadArgs({ message: `--concurrency must be an integer 1..100` })
      }
      const rules = yield* loadRules(config.rules)
      const roots =
        (config.paths as ReadonlyArray<string>).length > 0
          ? [...(config.paths as ReadonlyArray<string>)]
          : ["."]
      const files = collectFiles(roots, rules)
      if (files.length === 0) {
        console.log("proof: no files match the rules, skipping")
        return
      }
      const outcome = yield* lintFiles(rules, files, {
        chunkLines,
        concurrency,
        cacheDir: config.noCache ? false : process.cwd(),
      }).pipe(
        Effect.catchTag("EmptyDiff", () =>
          Effect.succeed({ flags: [], checked: 0, cached: 0 } as const),
        ),
      )
      const flags = outcome.flags
      yield* reportFlags(flags, format)
      console.log(
        `proof: ${flags.length} flag(s) across ${files.length} file(s), ${outcome.checked} window(s), ${outcome.cached} cached`,
      )
      yield* gateFlags(flags, failOn, minConf)
    }).pipe(Effect.provide(JevLive)),
).pipe(Command.withDescription("Lint whole files with plain-english rules judged by Jev"))

const mcp = Command.make("mcp", {}, () =>
  Effect.gen(function* () {
    const server = ProofToolkitLive.pipe(
      Layer.provide(
        McpServer.layerStdio({
          name: "proof",
          version,
          protocols: [McpProtocol.v2025_11_25, McpProtocol.v2025_06_18, McpProtocol.v2025_03_26],
        }),
      ),
      Layer.provide(NodeStdio.layer),
      Layer.provide(Logger.layer([Logger.consolePretty()])),
      Layer.provideMerge(Layer.succeed(Logger.LogToStderr, true)),
    )
    yield* Layer.launch(server)
  }),
).pipe(Command.withDescription("Run the proof MCP server over stdio"))

const cli = Command.make("proof").pipe(
  Command.withSubcommands([review, lint, mcp]),
  Command.withDescription("Plain-english code review judged by Jev"),
)

const CliLive = Layer.mergeAll(
  NodeTerminal.layer,
  NodeStdio.layer,
  NodeChildProcessSpawner.layer,
).pipe(Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)))

if (import.meta.main)
  Command.run(cli, { version }).pipe(Effect.provide(CliLive), NodeRuntime.runMain)
