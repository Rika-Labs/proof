import { Presets, Rule } from "../../src/index.ts"

export default [...Presets.effectStrict, Rule.noul({ id: "test/rule", statement: "Be nice" })]
