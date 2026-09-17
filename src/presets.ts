import { choice, noul, score } from "./Rule.ts"

/** Generic preset enforcing Effect TS idioms over plain TypeScript. */
export const effectStrict = [
  noul({
    id: "effect/no-throw",
    severity: "request-changes",
    threshold: 0.8,
    include: ["**/src/**/*.ts"],
    statement: `Do not throw exceptions in Effect code. Flag throw, Promise.reject, or catch blocks that rethrow as Error. Pass Effect.fail for expected errors with Data.TaggedError, Effect.die only for defects, Effect.catchAll or catchTag for handling. try/catch is only allowed at the outer runMain boundary.`,
    examples: {
      violate: [`catch (e) { throw new Error("failed") }`],
      clean: [`Effect.catchTag("HttpError", (cause) => new AuthError({ cause }))`],
    },
  }),
  noul({
    id: "effect/no-async-leak",
    severity: "request-changes",
    threshold: 0.8,
    exclude: ["**/*.test.ts", "**/*.spec.ts"],
    statement: `Do not leak Promise or async-await into Effect graphs. Flag async functions returning Promise, await inside Effect.gen, or new Promise. Pass Effect.tryPromise, Effect.promise, Effect.sleep instead of setTimeout, and HttpClient instead of raw fetch.`,
    examples: {
      violate: [
        `export async function login(e: string) { const res = await fetch("/x"); return res.json() }`,
      ],
      clean: [`Effect.tryPromise(() => fetch("/x"))`],
    },
  }),
  noul({
    id: "effect/typed-errors",
    severity: "comment",
    threshold: 0.75,
    statement: `Effect errors must be typed. Flag Effect.fail with a plain string, any or unknown in the error channel, or catches that swallow the cause. Pass Data.TaggedError classes and Schema validation at boundaries.`,
    examples: {
      violate: [`Effect.fail("oops")`],
      clean: [`Effect.fail(new DbError({ reason: "timeout" }))`],
    },
  }),
  noul({
    id: "effect/no-env-global",
    severity: "comment",
    threshold: 0.75,
    exclude: ["**/*.test.ts", "**/*.spec.ts"],
    statement: `No process.env, console.log, Date.now, or Math.random directly in business logic. Pass Config with ConfigProvider, Effect.log or Logger, Clock and Random from Effect, and Layer with Context.Tag for dependencies instead of singletons or imported globals.`,
    examples: {
      violate: [`if (!process.env.STRIPE_KEY) throw new Error("missing key")`],
      clean: [`const key = yield* Config.string("STRIPE_KEY")`],
    },
  }),
  noul({
    id: "effect/no-explicit-any",
    severity: "comment",
    threshold: 0.75,
    statement: `No explicit any, unsafe casts with as unknown as, or never casts to hide missing capabilities. Flag any type that escapes into a public signature. Pass Schema.decode, Schema.encode, or precise types.`,
    examples: {
      violate: [`(response as any).data.users`],
      clean: [`Schema.decodeUnknown(User)(response)`],
    },
  }),
  score({
    id: "effect/idiomatic",
    instructions: "How idiomatic is this Effect code?",
    levels: [
      "Non-Effect: classes with mutable let, manual try/finally resource handling",
      "Mixed: Effect wrapped but Promise-style control flow",
      "Idiomatic: gen/pipe, Schema, Layer, Ref, Schedule for retries, acquireRelease for resources",
    ],
  }),
  choice({
    id: "effect/action",
    instructions: "Given the violations found in this diff, what should the reviewer do?",
    options: {
      pass: "No Effect violations, or only stylistic nits",
      comment: "Has Effect style issues worth an inline comment",
      request_changes: "Has throwing, async leaks, or untyped errors that must be fixed",
    },
  }),
]
