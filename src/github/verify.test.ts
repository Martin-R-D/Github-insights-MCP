import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import nock from "nock";
import nodeFetch from "node-fetch";

process.env.DB_PATH = ":memory:";
process.env.GITHUB_TOKEN = "test-token";
process.env.GITHUB_USERNAME = "octocat";

type ClientMod = typeof import("./client.js");
type VerifyMod = typeof import("./verify.js");

let createGithubClient: ClientMod["createGithubClient"];
let verifyToken: VerifyMod["verifyToken"];
let overScopedWarning: VerifyMod["overScopedWarning"];
let TokenVerificationError: VerifyMod["TokenVerificationError"];

const API = "https://api.github.com";
const injectedFetch = nodeFetch as unknown as typeof fetch;
const newClient = () => createGithubClient({ token: "test-token", fetch: injectedFetch });

beforeAll(async () => {
  createGithubClient = (await import("./client.js")).createGithubClient;
  const v = await import("./verify.js");
  verifyToken = v.verifyToken;
  overScopedWarning = v.overScopedWarning;
  TokenVerificationError = v.TokenVerificationError;
  nock.disableNetConnect();
});
afterAll(() => nock.enableNetConnect());
afterEach(() => nock.cleanAll());

describe("verifyToken", () => {
  it("returns login and parsed scopes on success", async () => {
    nock(API)
      .get("/user")
      .reply(200, { login: "octocat" }, { "x-oauth-scopes": "repo, read:user, read:org" });
    const info = await verifyToken(newClient());
    expect(info.login).toBe("octocat");
    expect(info.classic).toBe(true);
    expect(info.scopes).toEqual(["repo", "read:user", "read:org"]);
  });

  it("classifies a 401 as bad_token", async () => {
    nock(API).get("/user").reply(401, { message: "Bad credentials" });
    await expect(verifyToken(newClient())).rejects.toMatchObject({ kind: "bad_token" });
  });

  it("classifies a 403 as forbidden", async () => {
    nock(API).get("/user").reply(403, { message: "Forbidden" });
    const err = await verifyToken(newClient()).catch((e) => e);
    expect(err).toBeInstanceOf(TokenVerificationError);
    expect(err.kind).toBe("forbidden");
  });

  it("treats a fine-grained token (no scopes header) as non-classic", async () => {
    nock(API).get("/user").reply(200, { login: "octocat" });
    const info = await verifyToken(newClient());
    expect(info.classic).toBe(false);
    expect(info.scopes).toEqual([]);
  });
});

describe("overScopedWarning", () => {
  it("warns when a classic PAT has extra scopes", () => {
    const w = overScopedWarning({ login: "o", classic: true, scopes: ["repo", "delete_repo", "admin:org"] });
    expect(w).toMatch(/more scopes than this server needs/i);
    expect(w).toContain("delete_repo");
  });

  it("returns null for exactly the needed scopes", () => {
    expect(overScopedWarning({ login: "o", classic: true, scopes: ["repo", "read:user", "read:org"] })).toBeNull();
  });

  it("returns null for fine-grained tokens", () => {
    expect(overScopedWarning({ login: "o", classic: false, scopes: [] })).toBeNull();
  });
});
