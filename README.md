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
bunx @rikalabs/proof
```

OpenCode (`~/.config/opencode/opencode.json` or project `opencode.json`):

```json
{
  "mcp": {
    "proof": {
      "type": "local",
      "command": ["bunx", "@rikalabs/proof"],
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
      "args": ["@rikalabs/proof"],
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

No action to install — call the MCP tools from any job with Bun. Fails the build only on `request-changes` flags at confidence `>= 0.85`:

```yaml
# .github/workflows/proof.yml
name: proof
on: [pull_request]

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: oven-sh/setup-bun@v2
      - run: bun add @rikalabs/proof
        env:
          TYPESAFE_API_KEY: ${{ secrets.TYPESAFE_API_KEY }}
      - name: Review PR diff
        env:
          TYPESAFE_API_KEY: ${{ secrets.TYPESAFE_API_KEY }}
          BASE_REF: ${{ github.event.pull_request.base.sha }}
          HEAD_REF: ${{ github.event.pull_request.head.sha }}
        run: |
          bun -e '
            import { Effect } from "effect"
            import { layer as JevLive } from "@rikalabs/proof/src/Jev.ts"
            import { effectStrict } from "@rikalabs/proof/src/presets.ts"
            import { reviewDiff, splitDiff } from "@rikalabs/proof/src/Review.ts"
            import { $ } from "bun"

            const diff = await $`git diff ${process.env.BASE_REF} ${process.env.HEAD_REF}`.text()
            if (splitDiff(diff).length === 0) {
              console.log("proof: no hunks, skipping")
              process.exit(0)
            }
            const flags = await Effect.runPromise(
              reviewDiff(effectStrict, diff).pipe(Effect.provide(JevLive)),
            )
            for (const f of flags) {
              console.log(`::${f.severity === "request-changes" ? "error" : "warning"} file=${f.file}::proof ${f.ruleId} (${f.confidence.toFixed(2)}): ${f.detail}`)
            }
            const blocking = flags.filter((f) => f.severity === "request-changes" && f.confidence >= 0.85)
            if (blocking.length > 0) {
              console.log(`proof: ${blocking.length} blocking flag(s)`)
              process.exit(1)
            }
            console.log(`proof: ${flags.length} flag(s), none blocking`)
          '
```

Notes:

- Add `TYPESAFE_API_KEY` under repo Settings → Secrets → Actions first.
- Reviews only changed lines (diff hunks), never the whole codebase.
- Tune per rule in code (`threshold`, `severity`) rather than in YAML.
- Jev outages surface as `{ flags: [], error }` and warn instead of failing — the workflow above treats an empty flag set as pass; gate on `error` too if you prefer fail-closed.

## Use in any pipeline

The same script works anywhere Bun runs (GitLab CI, Buildkite, pre-push hooks). Minimal pre-push hook (`.git/hooks/pre-push`):

```sh
#!/bin/sh
export TYPESAFE_API_KEY=...
diff=$(git diff origin/main...HEAD)
bun -e '/* same review snippet as above, threshold as you like */'
```

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
