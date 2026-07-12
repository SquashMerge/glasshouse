import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  setCredentials,
  clearCredentials,
  getCredentials,
  authHeader,
  authedFetch,
  onAuthInvalid,
} from "../../src/lib/auth";

describe("credentials helpers", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it("setCredentials + getCredentials round-trips", () => {
    setCredentials("alice", "hunter2");
    expect(getCredentials()).toEqual({ username: "alice", password: "hunter2" });
  });

  it("clearCredentials removes both keys", () => {
    setCredentials("alice", "hunter2");
    clearCredentials();
    expect(getCredentials()).toBeNull();
  });

  it("getCredentials returns null if either key is missing", () => {
    window.localStorage.setItem("astraea.auth.username", "alice");
    expect(getCredentials()).toBeNull();
    clearCredentials();
    window.localStorage.setItem("astraea.auth.password", "hunter2");
    expect(getCredentials()).toBeNull();
  });
});

describe("authHeader", () => {
  it("returns empty object when creds are null", () => {
    expect(authHeader(null)).toEqual({});
  });

  it("encodes credentials as Basic <base64(user:pass)>", () => {
    const header = authHeader({ username: "alice", password: "hunter2" });
    expect(header).toEqual({
      authorization: "Basic " + Buffer.from("alice:hunter2").toString("base64"),
    });
  });
});

describe("authedFetch 401 handling", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it("clears credentials and dispatches auth-invalid on 401", async () => {
    setCredentials("alice", "hunter2");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("nope", { status: 401, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const handler = vi.fn();
    const off = onAuthInvalid(handler);

    const res = await authedFetch("http://x/v1/traces");
    expect(res.status).toBe(401);
    expect(getCredentials()).toBeNull();
    expect(handler).toHaveBeenCalledTimes(1);

    off();
  });

  it("does not clear credentials on 200", async () => {
    setCredentials("alice", "hunter2");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const handler = vi.fn();
    const off = onAuthInvalid(handler);

    const res = await authedFetch("http://x/v1/traces");
    expect(res.status).toBe(200);
    expect(getCredentials()).toEqual({ username: "alice", password: "hunter2" });
    expect(handler).not.toHaveBeenCalled();

    off();
  });

  it("does not clear credentials on 500 (only 401 triggers re-auth)", async () => {
    setCredentials("alice", "hunter2");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("oops", { status: 500, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const handler = vi.fn();
    const off = onAuthInvalid(handler);

    const res = await authedFetch("http://x/v1/traces");
    expect(res.status).toBe(500);
    expect(getCredentials()).toEqual({ username: "alice", password: "hunter2" });
    expect(handler).not.toHaveBeenCalled();

    off();
  });

  it("attaches Basic Auth header from localStorage", async () => {
    setCredentials("alice", "hunter2");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await authedFetch("http://x/v1/traces");
    const calledWith = fetchMock.mock.calls[0] as Parameters<typeof fetch> | undefined;
    const init = (calledWith?.[1] ?? {}) as RequestInit;
    const headers = init.headers as Headers;
    expect(headers.get("authorization")).toBe("Basic " + Buffer.from("alice:hunter2").toString("base64"));
  });
});