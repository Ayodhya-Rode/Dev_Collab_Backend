import type { Response } from "express";

const GITHUB_API = "https://api.github.com";

const NOT_FOUND_MESSAGE =
  "Repository not found. Check the name; only public repositories are supported.";

const UNEXPECTED_MESSAGE = "GitHub sent an unexpected answer.";

export type GithubErrorCode =
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "FORBIDDEN"
  | "UNAVAILABLE"
  | "EMPTY";

export class GithubError extends Error {
  code: GithubErrorCode;

  constructor(code: GithubErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

// GitHub allows about 60 requests per hour per IP without a token.
// After a rate limit answer we stop calling GitHub until the limit resets.
let blockedUntil = 0;

const rateLimitError = () => {
  const minutes = Math.max(1, Math.ceil((blockedUntil - Date.now()) / 60000));

  return new GithubError(
    "RATE_LIMITED",
    `GitHub rate limit reached. Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`,
  );
};

const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

// Accepts "owner/name", "github.com/owner/name" or a full GitHub URL
export const parseRepository = (input: string): { owner: string; name: string } | null => {
  let value = input.trim();
  if (!value) return null;

  if (/^(www\.)?github\.com\//i.test(value)) value = `https://${value}`;

  let parts: string[];

  if (/^https?:\/\//i.test(value)) {
    let url: URL;

    try {
      url = new URL(value);
    } catch {
      return null;
    }

    if (!["github.com", "www.github.com"].includes(url.hostname.toLowerCase())) {
      return null;
    }

    parts = url.pathname.split("/").filter(Boolean);
  } else {
    parts = value.split("/").filter(Boolean);
    if (parts.length !== 2) return null;
  }

  if (parts.length < 2) return null;

  const owner = parts[0];
  const name = parts[1].replace(/\.git$/i, "");

  if (!OWNER_PATTERN.test(owner) || !REPO_PATTERN.test(name)) return null;
  if (name === "." || name === "..") return null;

  return { owner, name };
};

export const githubGet = async (path: string): Promise<unknown> => {
  if (Date.now() < blockedUntil) throw rateLimitError();

  const response = await fetch(`${GITHUB_API}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "DevCollab",
    },
    signal: AbortSignal.timeout(8000),
  }).catch(() => null);

  if (!response) {
    throw new GithubError("UNAVAILABLE", "Could not reach GitHub. Please try again later.");
  }

  if (response.ok) {
    try {
      return await response.json();
    } catch {
      throw new GithubError("UNAVAILABLE", UNEXPECTED_MESSAGE);
    }
  }

  if (response.status === 404) {
    throw new GithubError("NOT_FOUND", NOT_FOUND_MESSAGE);
  }

  // GitHub answers 409 when a repository has no commits yet
  if (response.status === 409) {
    throw new GithubError("EMPTY", "The repository is empty.");
  }

  if (response.status === 403 || response.status === 429) {
    const outOfRequests = response.headers.get("x-ratelimit-remaining") === "0";

    if (outOfRequests || response.status === 429) {
      const reset = Number(response.headers.get("x-ratelimit-reset"));
      const resetAt =
        Number.isFinite(reset) && reset > 0 ? reset * 1000 : Date.now() + 60_000;

      blockedUntil = Math.min(resetAt, Date.now() + 60 * 60 * 1000);
      throw rateLimitError();
    }

    throw new GithubError("FORBIDDEN", "GitHub refused the request. Please try again later.");
  }

  throw new GithubError(
    "UNAVAILABLE",
    "GitHub is not available right now. Please try again later.",
  );
};

const repoPath = (owner: string, name: string) =>
  `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;

export const getRepository = async (owner: string, name: string) => {
  const data = await githubGet(repoPath(owner, name));

  if (typeof data !== "object" || data === null) {
    throw new GithubError("UNAVAILABLE", UNEXPECTED_MESSAGE);
  }

  const repo = data as {
    name?: unknown;
    private?: unknown;
    default_branch?: unknown;
    owner?: { login?: unknown };
  };

  if (
    typeof repo.name !== "string" ||
    typeof repo.default_branch !== "string" ||
    typeof repo.owner?.login !== "string"
  ) {
    throw new GithubError("UNAVAILABLE", UNEXPECTED_MESSAGE);
  }

  if (repo.private === true) {
    throw new GithubError("NOT_FOUND", NOT_FOUND_MESSAGE);
  }

  return {
    owner: repo.owner.login,
    name: repo.name,
    defaultBranch: repo.default_branch,
  };
};

export interface CommitInfo {
  sha: string;
  shortSha: string;
  message: string;
  url: string;
  authorName: string | null;
  authorLogin: string | null;
  authorAvatar: string | null;
  committedAt: string | null;
}

export interface PullRequestInfo {
  number: number;
  title: string;
  url: string;
  draft: boolean;
  authorLogin: string | null;
  authorAvatar: string | null;
  branch: string;
  base: string;
  createdAt: string;
  updatedAt: string;
}

interface RawCommit {
  sha?: unknown;
  html_url?: unknown;
  commit?: {
    message?: unknown;
    author?: { name?: unknown; date?: unknown } | null;
  } | null;
  author?: { login?: unknown; avatar_url?: unknown } | null;
}

interface RawPullRequest {
  number?: unknown;
  title?: unknown;
  html_url?: unknown;
  draft?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  user?: { login?: unknown; avatar_url?: unknown } | null;
  head?: { ref?: unknown } | null;
  base?: { ref?: unknown } | null;
}

const text = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

export const fetchCommits = async (
  owner: string,
  name: string,
  branch: string,
): Promise<CommitInfo[]> => {
  let data: unknown;

  try {
    data = await githubGet(
      `${repoPath(owner, name)}/commits?sha=${encodeURIComponent(branch)}&per_page=10`,
    );
  } catch (err) {
    if (err instanceof GithubError && err.code === "EMPTY") return [];
    throw err;
  }

  if (!Array.isArray(data)) throw new GithubError("UNAVAILABLE", UNEXPECTED_MESSAGE);

  return (data as RawCommit[]).flatMap((c) => {
    const sha = text(c?.sha);
    if (!sha) return [];

    const message = text(c.commit?.message) ?? "";

    return [
      {
        sha,
        shortSha: sha.slice(0, 7),
        message: message.split("\n")[0].slice(0, 200),
        url: text(c.html_url) ?? "",
        authorName: text(c.commit?.author?.name),
        authorLogin: text(c.author?.login),
        authorAvatar: text(c.author?.avatar_url),
        committedAt: text(c.commit?.author?.date),
      },
    ];
  });
};

export const fetchPullRequests = async (
  owner: string,
  name: string,
): Promise<PullRequestInfo[]> => {
  const data = await githubGet(
    `${repoPath(owner, name)}/pulls?state=open&sort=updated&direction=desc&per_page=20`,
  );

  if (!Array.isArray(data)) throw new GithubError("UNAVAILABLE", UNEXPECTED_MESSAGE);

  return (data as RawPullRequest[]).flatMap((p) => {
    if (typeof p?.number !== "number") return [];

    return [
      {
        number: p.number,
        title: (text(p.title) ?? "").slice(0, 300),
        url: text(p.html_url) ?? "",
        draft: p.draft === true,
        authorLogin: text(p.user?.login),
        authorAvatar: text(p.user?.avatar_url),
        branch: text(p.head?.ref) ?? "",
        base: text(p.base?.ref) ?? "",
        createdAt: text(p.created_at) ?? "",
        updatedAt: text(p.updated_at) ?? "",
      },
    ];
  });
};

const STATUS: Record<GithubErrorCode, number> = {
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  FORBIDDEN: 502,
  UNAVAILABLE: 502,
  EMPTY: 502,
};

export const sendGithubError = (res: Response, err: GithubError) => {
  res.status(STATUS[err.code]).json({
    success: false,
    code: `GITHUB_${err.code}`,
    message: err.message,
  });
};