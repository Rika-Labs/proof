import { Data, Effect } from "effect"
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

const api = (
  token: string,
  path: string,
  init?: { readonly method?: string; readonly body?: unknown },
): Effect.Effect<unknown, GithubError> =>
  Effect.tryPromise({
    try: () =>
      fetch(`https://api.github.com${path}`, {
        method: init?.method ?? "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }).then(async (res): Promise<unknown> => {
        if (res.status === 204) return null
        const json = (await res.json().catch(() => null)) as
          | { readonly message?: string }
          | Array<unknown>
          | null
        if (!res.ok) {
          const message = json !== null && !Array.isArray(json) && typeof json.message === "string"
            ? json.message
            : `GitHub ${res.status}`
          throw new GithubError({ status: res.status, message })
        }
        return json
      }),
    catch: (e) => (e instanceof GithubError ? e : new GithubError({ status: undefined, message: String(e) })),
  })

const listInlineComments = (
  token: string,
  target: PullTarget,
): Effect.Effect<ReadonlyArray<ExistingComment>, GithubError> =>
  Effect.gen(function* () {
    const out: Array<ExistingComment> = []
    let page = 1
    while (true) {
      const json = (yield* api(
        token,
        `/repos/${target.owner}/${target.repo}/pulls/${target.pull}/comments?per_page=100&page=${page}`,
      )) as Array<ExistingComment>
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
          c.path === flag.file && c.line === flag.line &&
          typeof c.body === "string" && c.body.includes(markerFor(flag.ruleId)),
      ),
  )
  return { fresh, skipped: commentable.length - fresh.length }
}

const postOne = (
  token: string,
  target: PullTarget,
  flag: Flag,
): Effect.Effect<void, GithubError> =>
  Effect.gen(function* () {
    if (flag.line === undefined) {
      return yield* new GithubError({ status: undefined, message: `No target line for ${flag.ruleId}` })
    }
    yield* api(token, `/repos/${target.owner}/${target.repo}/pulls/${target.pull}/comments`, {
      method: "POST",
      body: {
        body: commentBodyFor(flag),
        commit_id: target.commit,
        path: flag.file,
        line: flag.line,
        side: "RIGHT",
      },
    })
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
      const result = yield* Effect.exit(postOne(token, target, flag))
      // 422 = line not in diff (stale) or duplicate: count as skipped, keep going
      if (result._tag === "Success") posted += 1
    }
    return { posted, skipped: skipped + (fresh.length - posted), noLine }
  })

/** owner/repo from $GITHUB_REPOSITORY, PR number from $GITHUB_REF (refs/pull/N/merge). */
export const targetFromEnv = (
  overrides?: { readonly repo?: string; readonly pr?: number; readonly commit?: string },
): PullTarget | undefined => {
  const repoRaw = overrides?.repo ?? process.env["GITHUB_REPOSITORY"] ?? ""
  const [owner, repo] = repoRaw.split("/")
  const ref = process.env["GITHUB_REF"] ?? ""
  const prMatch = /refs\/pull\/(\d+)\//.exec(ref)
  const pull = overrides?.pr ?? (prMatch?.[1] !== undefined ? Number(prMatch[1]) : NaN)
  const commit = overrides?.commit ?? process.env["GITHUB_SHA"] ?? ""
  if (owner === undefined || repo === undefined || owner === "" || Number.isNaN(pull) || commit === "") {
    return undefined
  }
  return { owner, repo, pull, commit }
}
