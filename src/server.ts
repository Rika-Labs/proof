#!/usr/bin/env bun
import { NodeRuntime, NodeStdio } from "@effect/platform-node"
import { Layer, Logger } from "effect"
import { McpProtocol, McpServer } from "effect/unstable/ai"
import { ProofToolkitLive } from "./Toolkit.ts"

const ServerLive = ProofToolkitLive.pipe(
  Layer.provide(
    McpServer.layerStdio({
      name: "proof",
      version: "0.3.0",
      protocols: [McpProtocol.v2025_11_25, McpProtocol.v2025_06_18, McpProtocol.v2025_03_26],
    }),
  ),
  Layer.provide(NodeStdio.layer),
  Layer.provide(Logger.layer([Logger.consolePretty()])),
  Layer.provideMerge(Layer.succeed(Logger.LogToStderr, true)),
)

Layer.launch(ServerLive).pipe(NodeRuntime.runMain)
