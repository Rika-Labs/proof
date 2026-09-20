import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { once } from "node:events"
import { describe, expect, it } from "vitest"

describe("real CLI and MCP outage paths", () => {
  it("lint exits nonzero and never reports none blocking", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(529)
      res.end('{"message":"overloaded"}')
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (typeof address !== "object" || address === null) throw new Error("No fixture port")
    const child = spawn(
      "bun",
      [
        "src/cli.ts",
        "lint",
        "test/fixtures/rules-valid.ts",
        "--rules",
        "test/fixtures/rules-valid.ts",
        "--no-cache",
      ],
      {
        env: {
          ...process.env,
          TYPESAFE_API_KEY: "fixture",
          TYPESAFE_API_URL: `http://127.0.0.1:${address.port}/v1`,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    )
    let output = ""
    child.stdout.on("data", (data) => {
      output += String(data)
    })
    child.stderr.on("data", (data) => {
      output += String(data)
    })
    try {
      const [code] = await once(child, "exit")
      expect(code).not.toBe(0)
      expect(output).toContain("Jev evaluation failed")
      expect(output).not.toContain("none blocking")
      expect(output).not.toContain("skipping review")
    } finally {
      child.kill()
      server.closeAllConnections()
      server.close()
    }
  })

  it("MCP returns isError, not a clean noul value", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(503)
      res.end("unavailable")
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (typeof address !== "object" || address === null) throw new Error("No fixture port")
    const child = spawn("bun", ["src/cli.ts", "mcp"], {
      env: {
        ...process.env,
        TYPESAFE_API_KEY: "fixture",
        TYPESAFE_API_URL: `http://127.0.0.1:${address.port}/v1`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    const pending = new Map<number, (value: Record<string, unknown>) => void>()
    let buffer = ""
    child.stdout.on("data", (chunk) => {
      buffer += String(chunk)
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.trim()) continue
        const message = JSON.parse(line) as Record<string, unknown>
        if (typeof message.id === "number") pending.get(message.id)?.(message)
      }
    })
    const rpc = (id: number, method: string, params: unknown) =>
      new Promise<Record<string, unknown>>((resolve) => {
        pending.set(id, resolve)
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
      })
    try {
      await rpc(1, "initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      })
      child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
      const response = await rpc(2, "tools/call", {
        name: "proof_check",
        arguments: { statement: "Be nice", file: "a.ts", diff: "+x" },
      })
      expect(response.result).toMatchObject({ isError: true })
      expect(JSON.stringify(response)).not.toContain('"violates":false')
      expect(JSON.stringify(response)).toContain("Jev evaluation failed")
    } finally {
      child.kill()
      server.closeAllConnections()
      server.close()
    }
  })
})
