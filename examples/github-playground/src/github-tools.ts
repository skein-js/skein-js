import { tool } from "@langchain/core/tools";
import { z } from "zod";

const login = z
  .string()
  .trim()
  .max(100)
  .regex(/^[a-z\d][a-z\d-]*(?:\[bot\])?$/i);

const repo = z
  .string()
  .trim()
  .max(100)
  .regex(/^[a-z\d._-]+$/i)
  .refine((name) => name !== "." && name !== "..");

const profile = z.object({
  login: z.string(),
  name: z.string().nullable(),
  followers: z.number().nonnegative(),
  public_repos: z.number().nonnegative(),
});

const repository = z.object({
  full_name: z.string(),
  description: z.string().nullable(),
  language: z.string().nullable(),
  stargazers_count: z.number().nonnegative(),
  forks_count: z.number().nonnegative(),
  default_branch: z.string(),
  pushed_at: z.string().nullable(),
});

const repositoryList = z.array(repository).transform((repositories) => repositories.slice(0, 6));

/** Only the fixed public API paths below reach fetch. Zod strips unused response fields. */
async function readGitHub<Result>(
  path: string,
  schema: z.ZodType<Result>,
  signal?: AbortSignal,
): Promise<Result | { error: string }> {
  const timeout = AbortSignal.timeout(8_000);

  try {
    const response = await fetch(new URL(path, "https://api.github.com"), {
      headers: { accept: "application/vnd.github+json", "user-agent": "skein-ui-playground" },
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (response.status === 404) return { error: "GitHub could not find that public resource." };
    if (
      response.status === 429 ||
      (response.status === 403 &&
        (response.headers.get("x-ratelimit-remaining") === "0" ||
          response.headers.has("retry-after")))
    )
      return { error: "GitHub's public API rate limit was reached. Try again later." };
    if (!response.ok) return { error: "GitHub could not complete the lookup." };

    const result = schema.safeParse(await response.json());
    return result.success ? result.data : { error: "GitHub returned an unexpected response." };
  } catch {
    signal?.throwIfAborted();
    return {
      error: timeout.aborted
        ? "The GitHub lookup timed out."
        : "GitHub is temporarily unavailable.",
    };
  }
}

export const githubTools = [
  tool(
    ({ username }, { signal }) =>
      readGitHub("/users/" + encodeURIComponent(username), profile, signal),
    {
      name: "get_github_profile",
      description: "Read a public GitHub profile by username, including follower and repo counts.",
      schema: z.object({ username: login }),
    },
  ),
  tool(
    ({ username }, { signal }) =>
      readGitHub(
        "/users/" +
          encodeURIComponent(username) +
          "/repos?type=owner&sort=pushed&direction=desc&per_page=6",
        repositoryList,
        signal,
      ),
    {
      name: "list_github_repositories",
      description:
        "List up to six of a GitHub user's public repositories, most recently pushed first.",
      schema: z.object({ username: login }),
    },
  ),
  tool(
    ({ owner, name }, { signal }) =>
      readGitHub(
        "/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(name),
        repository,
        signal,
      ),
    {
      name: "get_github_repository",
      description:
        "Read metadata and metrics for a public GitHub repository identified by owner/name.",
      schema: z.object({ owner: login, name: repo }),
    },
  ),
];
