import { Presets, Rule } from "./src/index.ts"

// This repo's own rulebook: the shared Effect preset plus one repo-specific rule.
// Used by: bunx --package @rikalabs/proof cli review --rules ./proof.rules.ts
export default Rule.define({
  rules: [
    ...Presets.effectStrict,
    Rule.noul({
      id: "proof/no-todo-without-issue",
      severity: "comment",
      threshold: 0.75,
      statement: `TODO comments must reference an issue or PR number. Flag bare TODO, FIXME, or HACK with no tracker link.`,
    }),
  ],
}).rules
