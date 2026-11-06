import { GithubError } from "./github.js";

interface Entry {
  data: unknown;
  fetchedAt: number;
}

const TTL_MS = 2 * 60 * 1000;
const MAX_ENTRIES = 200;

const entries = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();

export interface CachedResult<T> {
  data: T;
  fetchedAt: Date;
  stale: boolean;
  warning: string | null;
}

const store = (key: string, data: unknown) => {
  entries.delete(key);

  // Keep the cache small: drop the oldest entry when it is full
  if (entries.size >= MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }

  entries.set(key, { data, fetchedAt: Date.now() });
};

export const cached = async <T>(
  key: string,
  load: () => Promise<T>,
): Promise<CachedResult<T>> => {
  const hit = entries.get(key);

  if (hit && Date.now() - hit.fetchedAt < TTL_MS) {
    return {
      data: hit.data as T,
      fetchedAt: new Date(hit.fetchedAt),
      stale: false,
      warning: null,
    };
  }

  // Requests that arrive together share one GitHub call
  let pending = inflight.get(key) as Promise<T> | undefined;

  if (!pending) {
    pending = load()
      .then((data) => {
        store(key, data);
        return data;
      })
      .finally(() => inflight.delete(key));

    inflight.set(key, pending);
  }

  try {
    const data = await pending;
    const saved = entries.get(key);

    return {
      data,
      fetchedAt: new Date(saved?.fetchedAt ?? Date.now()),
      stale: false,
      warning: null,
    };
  } catch (err) {
    if (err instanceof GithubError) {
      // The repository is gone or private: old data would be misleading
      if (err.code === "NOT_FOUND") {
        entries.delete(key);
        throw err;
      }

      // GitHub is busy or unreachable: show the last data we have, with a warning
      if (hit) {
        return {
          data: hit.data as T,
          fetchedAt: new Date(hit.fetchedAt),
          stale: true,
          warning: err.message,
        };
      }
    }

    throw err;
  }
};