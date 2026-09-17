# proof — plain-english rules for code review, judged by Jev

Linters check syntax. `proof` checks judgment.

Write rules in plain english. `proof` runs them against diffs via [Jev](https://typesafe.ai) (`noul` / `choice` / `score`) and returns flags with calibrated confidence.

Local-first MCP server — **bring your own `TYPESAFE_API_KEY`**. No hosted backend, your key never leaves your machine.

Built with Effect v4 (`effect/unstable/ai` MCP toolkit, stdio transport).

## Install

```sh
cd proof
bun install
```

## Run as MCP server (stdio)

```sh
export TYPESAFE_API_KEY=...
bun src/server.ts
```

Add to OpenCode (`~/.config/opencode/opencode.json`):

```json
{
  "mcp": {
    "proof": {
      "type": "local",
      "command": ["bun", "/Users/dallenpyrah/Projects/rika-labs/proof/src/server.ts"],
      "environment": { "TYPESAFE_API_KEY": "..." }
    }
  }
}
```

## Tools

- `proof_check { statement, file, diff, threshold? }` — one plain-english rule against one hunk. Returns `{ violates, noul, threshold }`.
- `proof_review_diff { diff, thresholdOverride? }` — the built-in Effect-strict preset against a unified diff. Returns `{ flags[], hunks }`.
- `proof_list_rules {}` — list built-in rule ids, kinds, severities.

Confidence policy: `<0.5` skip, `0.5–0.75` nit, `>=0.75` flag, `>=0.85 + request-changes` block.

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
