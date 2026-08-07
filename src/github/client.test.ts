import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import nock from "nock";
import nodeFetch from "node-fetch";

// Isolated in-memory DB before the cache/db singleton is imported.
process.env.DB_PATH = ":memory:";
process.env.GITHUB_TOKEN = "test-token";
process.env.GITHUB_USERNAME = "octocat";

type ClientMod = typeof import("./client.js");
type DbClientMod = typeof import("../db/client.js");

let createGithubClient: ClientMod["createGithubClient"];
let db: DbClientMod["db"];

const API = "https://api.github.com";
// node-fetch is HTTP-layer based, so nock can intercept it (unlike undici).
const injectedFetch = nodeFetch as unknown as typeof fetch;

function newClient() {
  return createGithubClient({ token: "test-token", fetch: injectedFetch });
}

beforeAll(async () => {
  createGithubClient = (await import("./client.js")).createGithubClient;
  db = (await import("../db/client.js")).db;
  nock.disableNetConnect();
});

afterAll(() => {
  nock.enableNetConnect();
});

beforeEach(() => {
  db.exec("DELETE FROM http_cache;");
});

afterEach(() => {
  nock.cleanAll();
});

const RL_HEADERS = {
  "x-ratelimit-remaining": "4999",
  "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
  "x-ratelimit-limit": "5000",
};

describe("cachedRequest caching", () => {
  it("serves the second identical call from cache with zero HTTP requests", async () => {
    const body = { id: 1, full_name: "octocat/hello", stargazers_count: 7 };

    // Exactly one interceptor: a second network call would have no mock and,
    // with net connect disabled, would throw.
    const scope = nock(API)
      .get("/repos/octocat/hello")
      .reply(200, body, { etag: '"v1"', ...RL_HEADERS });

    const client = newClient();

    const first = await client.cachedRequest<typeof body>(
      "GET /repos/{owner}/{repo}",
      { owner: "octocat", repo: "hello" },
      { ttlSeconds: 600 },
    );
    expect(first.data.full_name).toBe("octocat/hello");
    expect(first.fromCache).toBeUndefined();
    expect(scope.isDone()).toBe(true); // the single mock was consumed

    // No new interceptor exists; if this hit the network it would throw.
    const second = await client.cachedRequest<typeof body>(
      "GET /repos/{owner}/{repo}",
      { owner: "octocat", repo: "hello" },
      { ttlSeconds: 600 },
    );
    expect(second.fromCache).toBe(true);
    expect(second.data).toEqual(body);
    expect(nock.pendingMocks()).toHaveLength(0);
  });

  it("treats a 304 response as a cache hit", async () => {
    const body = { id: 2, full_name: "octocat/again", stargazers_count: 3 };

    // ttl 0 => the stored row expires immediately, forcing revalidation.
    nock(API)
      .get("/repos/octocat/again")
      .reply(200, body, { etag: '"abc"', ...RL_HEADERS });

    const client = newClient();
    const first = await client.cachedRequest<typeof body>(
      "GET /repos/{owner}/{repo}",
      { owner: "octocat", repo: "again" },
      { ttlSeconds: 0 },
    );
    expect(first.data).toEqual(body);

    // Second call must send If-None-Match and receive 304.
    const revalidate = nock(API)
      .matchHeader("if-none-match", '"abc"')
      .get("/repos/octocat/again")
      .reply(304, "", { etag: '"abc"', ...RL_HEADERS });

    const second = await client.cachedRequest<typeof body>(
      "GET /repos/{owner}/{repo}",
      { owner: "octocat", repo: "again" },
      { ttlSeconds: 600 },
    );

    expect(revalidate.isDone()).toBe(true);
    expect(second.notModified).toBe(true);
    expect(second.fromCache).toBe(true);
    expect(second.status).toBe(304);
    expect(second.data).toEqual(body); // body reconstructed from cache
  });
});
