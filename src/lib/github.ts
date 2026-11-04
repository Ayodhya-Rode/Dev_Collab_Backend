import type { Response } from "express";

const GITHUB_API = "https://api.github.com";

const NOT_FOUND_MESSAGE =
  "Repository not found. Check the name; only public repositories are supported.";

export type GithubErrorCode =
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "FORBIDDEN"
  | "UNAVAILABLE";

export class GithubError extends Error {
  code: GithubErrorCode;

  constructor(code: GithubErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

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
      throw new GithubError("UNAVAILABLE", "GitHub sent an unexpected answer.");
    }
  }

  if (response.status === 404) {
    throw new GithubError("NOT_FOUND", NOT_FOUND_MESSAGE);
  }

  if (response.status === 403 || response.status === 429) {
    const outOfRequests = response.headers.get("x-ratelimit-remaining") === "0";

    if (outOfRequests || response.status === 429) {
      const reset = Number(response.headers.get("x-ratelimit-reset"));
      const minutes =
        Number.isFinite(reset) && reset > 0
          ? Math.max(1, Math.ceil((reset * 1000 - Date.now()) / 60000))
          : null;

      throw new GithubError(
        "RATE_LIMITED",
        minutes
          ? `GitHub rate limit reached. Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`
          : "GitHub rate limit reached. Please try again later.",
      );
    }

    throw new GithubError("FORBIDDEN", "GitHub refused the request.");
  }

  throw new GithubError("UNAVAILABLE", "GitHub is not available right now. Please try again later.");
};

export const getRepository = async (owner: string, name: string) => {
  const data = await githubGet(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
  );

  if (typeof data !== "object" || data === null) {
    throw new GithubError("UNAVAILABLE", "GitHub sent an unexpected answer.");
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
    throw new GithubError("UNAVAILABLE", "GitHub sent an unexpected answer.");
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

const STATUS: Record<GithubErrorCode, number> = {
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  FORBIDDEN: 502,
  UNAVAILABLE: 502,
};

export const sendGithubError = (res: Response, err: GithubError) => {
  res.status(STATUS[err.code]).json({
    success: false,
    code: `GITHUB_${err.code}`,
    message: err.message,
  });
};