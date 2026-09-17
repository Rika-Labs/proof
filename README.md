<div align="center">

# proof

_A plain-english rulebook for code review, judged by Jev. If you can say it in review, you can enforce it._

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@rikalabs/proof)](https://www.npmjs.com/package/@rikalabs/proof)

</div>

Local-first — **bring your own `TYPESAFE_API_KEY`**. No hosted backend, your key never leaves your machine. Requires [Bun](https://bun.sh) >= 1.2.

```sh
bun add @rikalabs/proof
export TYPESAFE_API_KEY=...
```

## 1. Rule files

A rule file is a TypeScript module default-exporting a `Rule[]`. Each rule is a plain-english statement Jev judges hunks against — the kind of thing no linter can encode:

```ts
// proof.rules.ts
import { Presets, Rule } from "@rikalabs/proof"

export default Rule.define({
  rules: [
    ...Presets.effectStrict,
    Rule.noul({
      id: "errors-helpful",
      severity: "request-changes",
      threshold: 0.85,
      statement: `Error messages must tell the user what to do next. Flag throw new Error("invalid"), empty catches, or errors that swallow the cause.`,
    }),
  ],
}).rules
```

Three rule kinds, one per Jev primitive:

- `Rule.noul` — violation detectors ("does this hunk violate X?"). Most rules.
- `Rule.choice` — classifiers over up to 255 options (`pass | comment | request-changes`).
- `Rule.score` — gradients over 2–10 ordered levels (readability, risk).

Every rule carries `severity` (`comment` | `request-changes`) and a `threshold`. Confidence policy: `<0.5` skip, `0.5–0.75` nit, `>=0.75` flag, `>=0.85 + request-changes` block.

`Presets.effectStrict` ships the shared Effect TS baseline (`no-throw`, `no-async-leak`, `typed-errors`, `no-env-global`, `no-explicit-any`, plus an `idiomatic` score and an `action` router) — extend it, don't rewrite it.

## 2. Enforce it

One lint command, locally or in CI. Reviews only changed lines, never the whole codebase:

```sh
# lint the current branch against your rule file
bunx --package @rikalabs/proof cli review --base origin/main --head HEAD --rules ./proof.rules.ts

# omit --rules to use the built-in Effect preset
bunx --package @rikalabs/proof cli review --base origin/main --head HEAD
```

```sh
cli review --help # --fail-on, --min-confidence, --format annotations|json|summary, --dry-run
```

Pre-push hook (`.git/hooks/pre-push`):

```sh
#!/bin/sh
export TYPESAFE_API_KEY=...
bunx --package @rikalabs/proof cli review --base origin/main --head HEAD --rules ./proof.rules.ts
```

GitHub Actions — the composite action (inline comments on by default for PRs):

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
          rules: ./proof.rules.ts
```

```yaml
- uses: Rika-Labs/proof@v0.2.0
  with:
    typesafe-api-key: ${{ secrets.TYPESAFE_API_KEY }}
    rules: ./proof.rules.ts # omit for the built-in Effect preset
    fail-on: request-changes # or: comment
    min-confidence: "0.85"
    comment: "true" # inline PR comments on flagged lines
    format: annotations # or: json, summary
```

Comments land on the first added line of each violating hunk and are deduped by an HTML marker — re-runs never double-post. Pure deletions (no added line) fall back to annotations. The job fails only on flags at `--fail-on` severity with confidence `>= --min-confidence`. Add `TYPESAFE_API_KEY` under repo Settings → Secrets → Actions first.

Jev outages warn instead of failing (`{ flags: [], error }`) — gate on the error if you prefer fail-closed.

## 3. MCP

The same engine as a stdio MCP server — `proof_check` for one-off rules, `proof_review_diff` for the preset, `proof_list_rules` for discovery:

```sh
bunx --package @rikalabs/proof mcp
```

OpenCode (`opencode.json`):

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

Ad-hoc rule checks without a rule file go through `proof_check` — pass the english `statement` inline with the hunk. Repo policy belongs in `proof.rules.ts` + the CLI/action above.

## Dev

```sh
bun install --frozen-lockfile
bun run check # typecheck + lint + tests + format:check
bun run test # vitest (Jev is stubbed — no network, no credentials)
```

## Pre-1.0

proof is currently pre-`1.0`. The public API may change between minor releases, and we encourage your feedback to improve it.
