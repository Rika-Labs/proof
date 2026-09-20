import type { PluginAPI } from "@ampcode/plugin"
import { register } from "../../../src/Amp.ts"

export const description = "Jev typed evaluation and a read-only Judge investigator."
export default (amp: PluginAPI) => register(amp)
