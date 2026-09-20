import { readFileSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"
import type {
  CreateAgentConfig,
  PluginAPI,
  PluginToolDefinition,
  PluginToolContext,
} from "@ampcode/plugin"
import { Effect, Layer } from "effect"
import { DecisionModel } from "effect/unstable/ai"
import { register } from "../src/Amp.ts"

describe("Amp Proof adapter", () => {
  it("registers ungated tools, restricts Judge, reuses and disposes one runtime", async () => {
    const tools: Record<string, PluginToolDefinition> = {}
    let dispose!: () => void | Promise<void>
    let definition!: CreateAgentConfig
    const run = vi.fn(async () => ({ text: "investigated", threadID: "T-test" }))
    const registerSkill = vi.fn(async () => ({ unsubscribe() {} }))
    const amp = {
      onDispose: (fn: () => void | Promise<void>) => {
        dispose = fn
      },
      registerSkill,
      registerTool: (tool: PluginToolDefinition) => {
        tools[tool.name] = tool
      },
      createAgent: (config: CreateAgentConfig) => {
        definition = config
        return { run }
      },
    } as unknown as PluginAPI
    let acquired = 0
    let released = 0
    const services = Layer.effect(
      DecisionModel.DecisionModel,
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            acquired++
          }),
          () =>
            Effect.sync(() => {
              released++
            }),
        )
        return yield* DecisionModel.make({
          decide: () =>
            Effect.succeed({
              answers: { q: { _tag: "Probability", probability: 0.23 } },
              usage: { inputTokens: 12, outputTokens: 2 },
            }),
        })
      }),
    )
    await register(amp, services)
    expect(registerSkill).toHaveBeenCalledWith({ path: "skills/jev" })
    const skill = readFileSync(".amp/plugins/proof/skills/jev/SKILL.md", "utf8")
    expect(skill).not.toContain("builtin-tools:")
    expect(tools.jev?.description).not.toContain("authorization")
    expect(tools.judge?.description).not.toContain("authorization")
    expect(definition.extends).toBeUndefined()
    expect(definition.tools).toEqual([
      "Read",
      "web_search",
      "read_web_page",
      "skill",
      "plugin__proof__jev",
    ])
    const context = { thread: { id: "T-test" } } as unknown as PluginToolContext
    const input = {
      state: { arbitrary: true },
      questions: { q: { type: "noul", instructions: "Urgent?" } },
    }
    try {
      expect(tools.jev?.description).toContain("Load proof:jev")
      const result = JSON.parse(String(await tools.jev!.execute(input, context)))
      expect(result).toEqual({
        status: "evaluated",
        answers: { q: { probability: 0.23 } },
        usage: { inputTokens: 12, outputTokens: 2 },
      })
      await tools.jev!.execute(input, context)
      expect(acquired).toBe(1)
      expect(await tools.judge!.execute({ request: "Investigate a.ts" }, context)).toBe(
        "investigated",
      )
      expect(run).toHaveBeenCalledWith("Investigate a.ts", {
        parentThreadID: "T-test",
        timeoutMs: 600000,
      })
      await expect(tools.jev!.execute({ state: "x", questions: {} }, context)).rejects.toThrow()
    } finally {
      await dispose()
    }
    expect(released).toBe(1)
  })
})
