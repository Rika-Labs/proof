import { Rule } from "../../src/index.ts"

export default Rule.define([
  Rule.noul({ id: "test/rule", statement: "Be nice" }),
  Rule.noul({ id: "test/other", statement: "Be kind" }),
])
