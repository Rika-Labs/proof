<div align="center">

# proof

_A plain-english rulebook for code review, judged by Jev. If you can say it in review, you can enforce it._

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@rikalabs/proof)](https://www.npmjs.com/package/@rikalabs/proof)

</div>

## Quick Start

```sh
bun add @rikalabs/proof
export TYPESAFE_API_KEY=...
```

One rulebook, every surface. Rules are plain-english statements in TypeScript; the same `Review` layer powers the MCP server, the CLI, and the GitHub Action:

```ts
import { Effect } from "effect"
import { Jev } from "@rikalabs/proof/src/Jev.ts"
import { Presets } from "@rikalabs/proof/src/presets.ts"
import { reviewDiff } from "@rikalabs/proof/src/Review.ts"
import { Rule } from "@rikalabs/proof/src/Rule.ts"

const config = Rule.define({
  rules: [
    ...Presets.effectStrict,
    Rule.noul({
      id: "errors-helpful",
      severity: "request-changes",
      threshold: 0.85,
      statement: `Error messages must tell the user what to do next. Flag throw new Error("invalid"), empty catches, or errors that swallow the cause.`,
    }),
  ],
})

const program = Effect.gen(function* () {
  const flags = yield* reviewDiff(config.rules, process.env["PR_DIFF"]!)
  for (const f of flags) {
    console.log(
      `${f.file}${f.line !== undefined ? `:${f.line}` : ""} [${f.ruleId}] ${f.confidence.toFixed(2)}: ${f.detail}`,
    )
  }
  return flags
})

Effect.runPromise(program.pipe(Effect.provide(Jev.layer))).then(console.log, console.error)
```

Or skip the code — review the current branch from your shell:

```sh
bunx --package @rikalabs/proof cli review --base origin/main --head HEAD
```

**Inline PR comments** land on the exact added line of each violating hunk, deduped by marker so re-runs never double-post:

```sh
bunx --package @rikalabs/proof cli review \
  --base origin/main --head HEAD \
  --comment --repo owner/repo --pr 123 --commit <head-sha>
```

No added lines (pure deletions) and stale lines fall back to annotations/summary instead of failing.

## Why Effect for review?

Judgment calls aren't just about asking a model. It's fanning out across rule × hunk pairs with bounded concurrency, surviving Jev outages without crashing CI, mapping flags back to exact diff lines, and cleaning up secrets — all while keeping the system stable and responsive. Effect provides simple, composable building blocks to model these workflows in a safe, declarative manner.

By using Effect for your review interactions you'll benefit from:

- 🧩 **Surface-agnostic architecture**: write your rules once, and defer choosing the surface (MCP server, CLI, GitHub Action) until the `Layer` is provided
- 🧪 **Fully testable**: Jev is an Effect service, so a stubbed `Jev` stands in for the real backend with no network and no credentials — all 23 tests run offline
- 🧵 **Structured concurrency**: fan out across N rules × M hunks with bounded concurrency; interruption cancels in-flight judgments cleanly
- 🔍 **Observability**: Effect's built-in tracing and logging flow through every Jev call, with per-flag confidence attached
- 🛡️ **Honest failure model**: a Jev outage is not proof the code is clean; failures surface as typed `JevError` / `{ flags: [], error }` envelopes instead of silent passes or exceptions

…and much more!

## Core Concepts

proof is built around the idea of judgment-as-code. Instead of hardcoding regexes or AST visitors, you describe each rule in the language you'd use in review, and Jev judges hunks against it:

- **Rules**: `Rule.noul` for violation detectors ("does this hunk violate X?"), `Rule.choice` for classifiers (up to 255 options), `Rule.score` for gradients over 2–10 ordered levels. Each carries `severity` (`comment` | `request-changes`) and a `threshold`.
- **Hunks**: `splitDiff` turns a unified diff into per-file hunks, each with a `targetLine` — the first added line on the new-file side — so flags map to exact positions for inline comments.
- **Flags**: `{ ruleId, file, line, confidence, severity, detail }`. Confidence policy: `<0.5` skip, `0.5–0.75` nit, `>=0.75` flag, `>=0.85 + request-changes` block.
- **Presets**: `Presets.effectStrict` enforces Effect TS idioms over plain TypeScript out of the box — `no-throw`, `no-async-leak`, `typed-errors`, `no-env-global`, `no-explicit-any`, plus an `idiomatic` score and an `action` router.

Each of these is defined as an Effect service or plain data, meaning rules can be injected, composed (`...Presets.effectStrict`, `Rule.noul({...})`), and tested just like any other dependency in the Effect ecosystem.

This decoupling lets you write your review policy as a pure description of what good looks like, and resolve _how_ it runs later: an MCP tool call, a CLI invocation, or a GitHub Action.

## The model

Three pieces, three lifetimes:

|            | Shape                                            | Lifetime                                                            |
| ---------- | ------------------------------------------------ | ------------------------------------------------------------------- |
| **Rule**   | `Rule.noul({...})` is plain data                 | shareable; holds the english statement, severity, threshold         |
| **Review** | `reviewDiff(rules, diff)` is an `Effect`         | runs N rules × M hunks with bounded concurrency, returns flags      |
| **Report** | annotations, `--format summary`, inline comments | maps flags to positions; deduped by `<!-- proof:ruleId -->` markers |

## What happens when…

**…Jev is down?** It warns instead of failing. The outage surfaces as a typed `JevError` on the error channel, and the MCP/CLI boundary converts it to `{ flags: [], error }` — never a silent clean bill of health. Gate on the `error` field if you prefer fail-closed:

```ts
const flags =
  yield *
  reviewDiff(rules, diff).pipe(
    Effect.catchAll((e) => Effect.succeed([] as const)), // fail-open: warn, don't block
  )
```

**…a flag has no line to comment on?** Pure deletions have no added line, so `targetLine` is absent. Those flags still appear in annotations and summaries; the commenter counts them as `noLine` and skips them instead of posting a 422 to GitHub.

**…the same PR is reviewed twice?** Existing comments carrying the rule's `<!-- proof:ruleId -->` marker on the same path+line are skipped. Re-runs only post genuinely new violations.

**…confidence is below threshold?** The flag is dropped before reporting — the CLI/MCP never sees it. Thresholds live on the rule (`threshold: 0.85`), and `--min-confidence` gates the exit code separately from display.

**…I'm in CI without credentials?** The `Jev` layer requires `TYPESAFE_API_KEY` and fails with a typed `MissingApiKey` — but tests never touch it. Provide a stub (`Layer.succeed(Jev.Jev, stub)`) and the whole `Review` layer runs offline: [test/Toolkit.test.ts](test/Toolkit.test.ts).

## Integrations

Three surfaces, one `Review` layer:

- **MCP server** (`bunx --package @rikalabs/proof mcp`) — `proof_check`, `proof_review_diff`, `proof_list_rules` over stdio. OpenCode:

```json
{
  "mcp": {
    "proof": {
      "type": "local",
      "command": ["bunx", "--package", "@rikalabs/proof", "mcp"],
      "environment": { "TYPESAFE_API_KEY": "{env:TYPESAFE_API_KEY}" }
    }
  }
}
```

Claude Code (`.mcp.json`):

```json
{
  "mcpServers": {
    "proof": {
      "command": "bunx",
      "args": ["--package", "@rikalabs/proof", "mcp"],
      "env": { "TYPESAFE_API_KEY": "…" }
    }
  }
}
```

- **GitHub Actions** — the composite action (inline comments on by default for PRs):

```yaml
# .github/workflows/proof.yml
name: proof
on: [pull_request]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: Rika-Labs/proof@v0.2.0
        with:
          typesafe-api-key: ${{ secrets.TYPESAFE_API_KEY }}
```

```yaml
- uses: Rika-Labs/proof@v0.2.0
  with:
    typesafe-api-key: ${{ secrets.TYPESAFE_API_KEY }}
    fail-on: request-changes # or: comment
    min-confidence: "0.85"
    comment: "true" # inline PR comments on flagged lines
    format: annotations # or: json, summary
```

- **CLI / any pipeline** (GitLab CI, Buildkite, pre-push hooks):

```sh
bunx --package @rikalabs/proof cli review --base origin/main --head HEAD
```

```sh
cli review --help # all flags
```

```sh
#!/bin/sh
# .git/hooks/pre-push
export TYPESAFE_API_KEY=...
bunx --package @rikalabs/proof cli review --base origin/main --head HEAD
```

Add `TYPESAFE_API_KEY` under repo Settings → Secrets → Actions first. Inline comments need `permissions: pull-requests: write`.

## Dev

```sh
bun install --frozen-lockfile
bun run check # typecheck + lint + tests + format:check
bun run test # vitest
```

## Pre-1.0

proof is currently pre-`1.0`. The public API may change between minor releases, and we encourage your feedback to improve it.
