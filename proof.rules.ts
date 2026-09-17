import { Rule } from "./src/index.ts"

// This repo's own rulebook.
// Used by: bunx --package @rikalabs/proof cli review --rules ./proof.rules.ts
export default Rule.define([
  Rule.noul({
    id: "proof/no-todo-without-issue",
    severity: "comment",
    threshold: 0.75,
    statement: `TODO comments must reference an issue or PR number. Flag bare TODO, FIXME, or HACK with no tracker link.`,
  }),
  Rule.noul({
    id: "proof/errors-helpful",
    severity: "request-changes",
    threshold: 0.85,
    statement: `Error messages must tell the user what to do next. Flag throw new Error("invalid"), empty catches, or errors that swallow the cause.`,
    examples: {
      violate: [`catch (e) { throw new Error("failed") }`],
      clean: [`Effect.catchTag("HttpError", (cause) => new AuthError({ cause }))`],
    },
  }),
])
