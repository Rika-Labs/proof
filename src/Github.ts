import { Data, Effect } from "effect"
import { credentials, type Credentials } from "@distilled.cloud/github/Credentials"
import { none as noRetry } from "@distilled.cloud/github/Retry"
import { createReviewComment, listReviewComments } from "@distilled.cloud/github/pulls"
import { FetchHttpClient, type HttpClient } from "effect/unstable/http"
import type { Flag } from "./Review.ts"

export interface PullTarget {
  readonly owner: string
  readonly repo: string
  readonly pull: number
  /** Head SHA of the PR (not the merge commit). */
  readonly commit: string
}

export class GithubError extends Data.TaggedError("GithubError")<{
  readonly status: number | undefined
  readonly message: string
}> {}

export interface CommentResult {
  readonly posted: number
  readonly skipped: number
  readonly noLine: number
}

export const markerFor = (ruleId: string): string => `<!-- proof:${ruleId} -->`

export const commentBodyFor = (flag: Flag): string =>
  `**proof \`${flag.ruleId}\` (${flag.confidence.toFixed(2)}, ${flag.severity})**\n\n${flag.detail}\n\n${markerFor(flag.ruleId)}`

interface ExistingComment {
  readonly path?: string
  readonly line?: number | null
  readonly body?: string
}

const api = <A, E extends { readonly _tag: string }>(
  token: string,
  operation: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
) =>
  operation.pipe(
    noRetry,
    Effect.provide(credentials({ token })),
    Effect.provide(FetchHttpClient.layer),
    Effect.mapError(
      (error) =>
        new GithubError({
          status: error._tag === "UnprocessableEntity" ? 422 : undefined,
          message: `GitHub request failed (${error._tag})`,
        }),
    ),
  )

const listInlineComments = (
  token: string,
  target: PullTarget,
): Effect.Effect<ReadonlyArray<ExistingComment>, GithubError> =>
  Effect.gen(function* () {
    const out: Array<ExistingComment> = []
    let page = 1
    while (true) {
      const json = yield* api(
        token,
        listReviewComments({
          owner: target.owner,
          repo: target.repo,
          pull_number: target.pull,
          per_page: 100,
          page,
        }),
      )
      out.push(...json)
      if (json.length < 100) return out
      page += 1
    }
  })

/** Flags that already have a proof comment on the same path+line are skipped. */
export const partitionNew = (
  flags: ReadonlyArray<Flag>,
  existing: ReadonlyArray<ExistingComment>,
): { readonly fresh: ReadonlyArray<Flag>; readonly skipped: number } => {
  const commentable = flags.filter((f) => f.line !== undefined)
  const fresh = commentable.filter(
    (flag) =>
      !existing.some(
        (c) =>
          c.path === flag.file &&
          c.line === flag.line &&
          typeof c.body === "string" &&
          c.body.includes(markerFor(flag.ruleId)),
      ),
  )
  return { fresh, skipped: commentable.length - fresh.length }
}

const postOne = (token: string, target: PullTarget, flag: Flag): Effect.Effect<void, GithubError> =>
  Effect.gen(function* () {
    if (flag.line === undefined) {
      return yield* new GithubError({
        status: undefined,
        message: `No target line for ${flag.ruleId}`,
      })
    }
    yield* api(
      token,
      createReviewComment({
        owner: target.owner,
        repo: target.repo,
        pull_number: target.pull,
        body: commentBodyFor(flag),
        commit_id: target.commit,
        path: flag.file,
        line: flag.line,
        side: "RIGHT",
      }),
    )
  })

export const postInlineComments = (
  token: string,
  target: PullTarget,
  flags: ReadonlyArray<Flag>,
): Effect.Effect<CommentResult, GithubError> =>
  Effect.gen(function* () {
    const commentable = flags.filter((f) => f.line !== undefined)
    const noLine = flags.length - commentable.length
    const existing = yield* listInlineComments(token, target)
    const { fresh, skipped } = partitionNew(commentable, existing)
    let posted = 0
    for (const flag of fresh) {
      const accepted = yield* postOne(token, target, flag).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          error.status === 422 ? Effect.succeed(false) : Effect.fail(error),
        ),
      )
      if (accepted) posted += 1
    }
    return { posted, skipped: skipped + (fresh.length - posted), noLine }
  })

/** owner/repo from $GITHUB_REPOSITORY, PR number from $GITHUB_REF (refs/pull/N/merge). */
export const targetFromEnv = (overrides?: {
  readonly repo?: string
  readonly pr?: number
  readonly commit?: string
}): PullTarget | undefined => {
  const repoRaw = overrides?.repo ?? process.env["GITHUB_REPOSITORY"] ?? ""
  const [owner, repo] = repoRaw.split("/")
  const ref = process.env["GITHUB_REF"] ?? ""
  const prMatch = /refs\/pull\/(\d+)\//.exec(ref)
  const pull = overrides?.pr ?? (prMatch?.[1] !== undefined ? Number(prMatch[1]) : NaN)
  const commit = overrides?.commit ?? process.env["GITHUB_SHA"] ?? ""
  if (
    owner === undefined ||
    repo === undefined ||
    owner === "" ||
    Number.isNaN(pull) ||
    commit === ""
  ) {
    return undefined
  }
  return { owner, repo, pull, commit }
}
