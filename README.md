# proof — plain-english rules for code review, judged by Jev

Linters check syntax. `proof` checks judgment.

Write rules in plain english. `proof` runs them against diffs via [Jev](https://typesafe.ai) (`noul` / `choice` / `score`) and returns flags with calibrated confidence.

Local-first — **bring your own `TYPESAFE_API_KEY`**. No hosted backend, your key never leaves your machine.

Built with Effect v4 (`effect/unstable/ai` MCP toolkit, stdio transport).

## Install

```sh
bun add @rikalabs/proof
# or: npm i @rikalabs/proof
```

Requires [Bun](https://bun.sh) >= 1.2 to run the server, plus a [TypeSafe API key](https://typesafe.ai) in `TYPESAFE_API_KEY`.

## Use as an MCP server

Any MCP client (OpenCode, Claude Code, Cursor). Requires Bun on `PATH`.

```sh
export TYPESAFE_API_KEY=...
bunx --package @rikalabs/proof proof-mcp
```

OpenCode (`~/.config/opencode/opencode.json` or project `opencode.json`):

```json
{
  "mcp": {
    "proof": {
      "type": "local",
      "command": ["bunx", "--package", "@rikalabs/proof", "proof-mcp"],
      "environment": { "TYPESAFE_API_KEY": "{env:TYPESAFE_API_KEY}" }
    }
  }
}
```

Claude Code (`~/.claude.json` or `.mcp.json`):

```json
{
  "mcpServers": {
    "proof": {
      "command": "bunx",
      "args": ["--package", "@rikalabs/proof", "proof-mcp"],
      "env": { "TYPESAFE_API_KEY": "…" }
    }
  }
}
```

From source:

```sh
git clone https://github.com/Rika-Labs/proof.git
cd proof
bun install
export TYPESAFE_API_KEY=...
bun src/server.ts
```

## Tools

- `proof_check { statement, file, diff, threshold? }` — one plain-english rule against one hunk. Returns `{ violates, noul, threshold }`.
- `proof_review_diff { diff, thresholdOverride? }` — the built-in Effect-strict preset against a unified diff. Returns `{ flags[], hunks }`.
- `proof_list_rules {}` — list built-in rule ids, kinds, severities.

Confidence policy: `<0.5` skip, `0.5–0.75` nit, `>=0.75` flag, `>=0.85 + request-changes` block.

## Use in CI / GitHub Actions

Easiest — the composite action (inline comments on by default for PRs):

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

With options:

```yaml
- uses: Rika-Labs/proof@v0.2.0
  with:
    typesafe-api-key: ${{ secrets.TYPESAFE_API_KEY }}
    fail-on: request-changes # or: comment
    min-confidence: "0.85"
    comment: "true" # inline PR comments on flagged lines
    format: annotations # or: json, summary
```

Or call the CLI directly (any pipeline with Bun — GitLab CI, Buildkite, pre-push hooks):

```sh
export TYPESAFE_API_KEY=...
bunx --package @rikalabs/proof proof review \
  --base origin/main --head HEAD \
  --comment --repo owner/repo --pr 123 --commit <head-sha>
```

```sh
proof review --help   # all flags
```

Minimal pre-push hook (`.git/hooks/pre-push`):

```sh
#!/bin/sh
export TYPESAFE_API_KEY=...
bunx --package @rikalabs/proof proof review --base origin/main --head HEAD
```

Notes:

- Add `TYPESAFE_API_KEY` under repo Settings → Secrets → Actions first.
- Inline comments need `permissions: pull-requests: write` (or a token with PR write).
- Reviews only changed lines (diff hunks), never the whole codebase. Comments land on the first added line of each violating hunk, deduped by an HTML marker — re-runs never double-post.
- Fails the job only on flags at `--fail-on` severity with confidence `>= --min-confidence`.
- Tune per rule in code (`threshold`, `severity`) rather than in YAML.
- Jev outages warn instead of failing — gate on the `error` field (CLI prints it, MCP returns it) if you prefer fail-closed.

## Define rules in TypeScript

```ts
import { Proof } from "@rikalabs/proof"

export default Proof.define({
  rules: [
    Proof.noul({
      id: "errors",
      severity: "request-changes",
      threshold: 0.85,
      statement: `Error messages must tell the user what to do next. ...`,
    }),
  ],
})
```

Rule kinds map to Jev primitives: `noul` (violation detectors), `choice` (classifiers, up to 255 options), `score` (gradients over 2–10 ordered levels).

Ships with `Presets.effectStrict`: `no-throw`, `no-async-leak`, `typed-errors`, `no-env-global`, `no-explicit-any`, plus an `idiomatic` score and an `action` router.

## Dev

```sh
bun run check   # typecheck + lint + tests + format:check
bun run test    # vitest
```

Requires `TYPESAFE_API_KEY` only for live Jev calls. Unit + handler tests use a stubbed `Jev` service.
