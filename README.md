<div align="center">

# proof

_A plain-english rulebook for code review, judged by Jev. If you can say it in review, you can enforce it._

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@rikalabs/proof)](https://www.npmjs.com/package/@rikalabs/proof)

</div>

Local-first — **bring your own `TYPESAFE_API_KEY`**. Proof sends evidence and the key to TypeSafe through Distilled; do not submit secrets as evidence. Requires [Bun](https://bun.sh) >= 1.2.

**Release dependency:** Proof 0.5.2 requires `@rikalabs/distilled-typesafe@1.0.0-rc.7`
from npm. The development lockfile still references the sibling Distilled tarball;
regenerate it once that provider version is available from the registry.
Transport tests and live Jev inference have passed; live Judge inference is unverified.

```sh
bun add @rikalabs/proof
export TYPESAFE_API_KEY=...
```

## 1. Rule files

A rule file is a TypeScript module default-exporting a `Rule[]`. Each rule is a plain-english statement Jev judges hunks against — the kind of thing no linter can encode:

```ts
// proof.rules.ts
import { Rule } from "@rikalabs/proof"

export default Rule.define([
  Rule.noul({
    id: "errors-helpful",
    severity: "request-changes",
    threshold: 0.85,
    statement: `Error messages must tell the user what to do next. Flag throw new Error("invalid"), empty catches, or errors that swallow the cause.`,
    examples: {
      violate: [`catch (e) { throw new Error("failed") }`],
      clean: [`Effect.catchTag("HttpError", (cause) => new AuthError({ cause }))`],
    },
  }),
])
```

Three rule kinds, one per Jev primitive:

- `Rule.noul` — violation detectors ("does this hunk violate X?"). Most rules. Add `examples: { violate[], clean[] }` to pin the boundary with few-shots.
- `Rule.choice` — classifiers over up to 255 options (`pass | comment | request-changes`). Requires explicit `passing: ["pass"]`; option insertion order has no policy meaning.
- `Rule.score` — gradients over 2–10 ordered levels (readability, risk).

Rules carry `severity` (`comment` | `request-changes`) and optional `include` / `exclude` globs. Noul and Choice thresholds must be finite numbers in 0..1 (default 0.75); equality flags. Choice flags non-passing options only. Score is a ranking helper and does not gate reviews. These probabilistic findings never authorize actions.

## 2. Enforce it

One lint command, locally or in CI. Reviews only changed lines, never the whole codebase:

```sh
# lint the current branch; rules auto-discovered from the nearest proof.rules.ts
bunx @rikalabs/proof review --base origin/main --head HEAD
```

```sh
cli review --help # --fail-on, --min-confidence, --format annotations|json|summary, --dry-run
```

Whole-repo lint walks files like oxlint and judges 50-line windows with 20 parallel Jev calls. Persistent cache reuse is disabled by default, including for rolling model aliases. An embedding host may supply an explicit `Jev.CacheIdentity` (provider/endpoint, immutable model, evaluator, and revision binding account/context) to `Jev.configuredLayer`. Cache keys bind that identity, all rules and thresholds, chunk size, file contents/path, cwd, and the interpretation/context-policy versions. Changing any of those invalidates reuse; `.proof/cache.json` is best-effort local storage, not an authorization record.

```sh
bunx @rikalabs/proof lint
bunx @rikalabs/proof lint packages src
```

```sh
cli lint --help # --concurrency, --chunk-lines, --no-cache, --fail-on, --min-confidence, --format
```

Omit `--rules` anywhere and proof finds the nearest `proof.rules.ts` walking up from the current directory — root of a monorepo covers every package beneath it.

Pre-push hook (`.git/hooks/pre-push`):

```sh
#!/bin/sh
export TYPESAFE_API_KEY=...
bunx @rikalabs/proof review --base origin/main --head HEAD --rules ./proof.rules.ts
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
      - uses: Rika-Labs/proof@v0.5.0
        with:
          typesafe-api-key: ${{ secrets.TYPESAFE_API_KEY }}
          # rules: ./proof.rules.ts # optional: defaults to nearest proof.rules.ts in the checkout
```

```yaml
- uses: Rika-Labs/proof@v0.5.0
  with:
    typesafe-api-key: ${{ secrets.TYPESAFE_API_KEY }}
    fail-on: request-changes # or: comment
    min-confidence: "0.85"
    comment: "true" # inline PR comments on flagged lines
    format: annotations # or: json, summary
    # rules: ./proof.rules.ts # optional: defaults to nearest proof.rules.ts in the checkout
```

Comments land on the first added line of each violating hunk and are deduped by an HTML marker — re-runs never double-post. Pure deletions (no added line) fall back to annotations. The job fails only on flags at `--fail-on` severity with confidence `>= --min-confidence`. Add `TYPESAFE_API_KEY` under repo Settings → Secrets → Actions first.

Jev outages, malformed answers, and invalid rules fail the CLI. MCP reports a tool error, never a clean zero probability. No automatic provider fallback or evaluation retry occurs.

## 3. MCP

The same engine as a stdio MCP server — `proof_check` checks one hunk against one plain-english rule, no rule file needed:

```sh
bunx @rikalabs/proof mcp
```

OpenCode (`opencode.json`):

```json
{
  "mcp": {
    "proof": {
      "type": "local",
      "command": ["bunx", "@rikalabs/proof", "mcp"],
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
      "args": ["@rikalabs/proof", "mcp"],
      "env": { "TYPESAFE_API_KEY": "…" }
    }
  }
}
```

Ad-hoc rule checks without a rule file go through `proof_check` — pass the english `statement` inline with the hunk. Repo policy belongs in `proof.rules.ts` + the CLI/action above.

## Dev

Effect and `@effect/ai-typesafe` are pinned to `4.0.0-rc.116`. The provider chain is
`Decision` → native `TypeSafeDecisionModel` → injected `TypeSafeClient` →
`@rikalabs/distilled-typesafe` → Effect HttpClient. The native TypeSafe HTTP layer
is never used. GitHub comments use `@distilled.cloud/github@1.0.0-rc.12` with
write retries disabled. Only 422 comment rejections are skipped; other failures
surface. No publication or deployment is implied by these operations.

Environment: `TYPESAFE_API_KEY`, `TYPESAFE_MODEL` (default `jev-latest`), and
`TYPESAFE_API_URL` (default `https://api.typesafe.ai/v1`). The old full-endpoint
`TYPESAFE_ENDPOINT` variable is no longer supported; use the base URL above.

First pack the sibling provider using the commands in
`../distilled/packages/typesafe/README.md`. Proof installs that local tarball,
not a source symlink: Effect's Redacted registry requires one physical Effect
instance. Both checkouts can otherwise install and test independently. The
provider depends only on published `@rikalabs/distilled-core@1.0.0-rc.7` and an
exact Effect peer; no other unpublished Distilled workspace package is required.

```sh
npx --yes bun@1.4.2 install --frozen-lockfile
npx --yes bun@1.4.2 run check # typecheck + lint + tests + format:check
```

## Amp plugin

The directory plugin `.amp/plugins/proof` registers `jev`, `judge`, and the bundled
`proof:jev` skill. Both tools are visible without a skill gate; their descriptions
direct agents to the skill's usage guidance. `src/Amp.ts` exports `register(amp, services?)` for embedding; one
ManagedRuntime is owned by each plugin instance and disposed on unload.

`jev` accepts arbitrary JSON state and 1–32 bounded noul/choice/score questions.
`Jev.decide` returns native typed Decision answers and token usage; the Amp tool
serializes those unchanged, with `status: "evaluated"`. Unknown usage stays absent.
Structured criteria are JSON-encoded into native Effect's string rubric slots.

Judge is a custom agent created with the current `amp.createAgent` API, not an
inherited Oracle. Its explicit tools are `Read`, `web_search`, `read_web_page`,
`skill`, and `plugin__proof__jev`; it has no shell, edit, Oracle, or delegation
tools. Judge inference is provided by Amp itself. Its instructions require Jev,
source citations, counterexamples, and visible unavailable/inconclusive outcomes.

Jev tool calls have a 30-second deadline. Effect interruption and runtime disposal
cancel transport work. Amp's current `PluginToolContext` exposes no AbortSignal,
so this adapter cannot forward individual UI cancellation of Jev. Amp forwards
tool aborts to `judge.run`; its 10-minute wait timeout alone does not stop a child
turn. A live Judge inference run has not been exercised. No index/search lifecycle
or broader automatic review hooks are implemented here.

## Pre-1.0

proof is currently pre-`1.0`. The public API may change between minor releases, and we encourage your feedback to improve it.
