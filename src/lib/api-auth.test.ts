import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requireApiToken } from "./api-auth";

const originalApiToken = process.env.API_TOKEN;

beforeEach(() => {
  delete process.env.API_TOKEN;
});

afterEach(() => {
  if (originalApiToken === undefined) delete process.env.API_TOKEN;
  else process.env.API_TOKEN = originalApiToken;
});

function req(headers?: Record<string, string>): Request {
  return new Request("http://localhost/api/v1/accounts", { headers });
}

describe("requireApiToken", () => {
  it("returns 503 when API_TOKEN is unset", async () => {
    const res = requireApiToken(req());
    expect(res).not.toBeNull();
    expect(res!.status).toBe(503);
    expect(await res!.json()).toEqual({ error: "API disabled: set API_TOKEN on the server." });
  });

  it("returns 401 when the header is missing", async () => {
    process.env.API_TOKEN = "secret";
    const res = requireApiToken(req());
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
    expect(await res!.json()).toEqual({ error: "Unauthorized" });
  });

  it("returns 401 when the token is wrong", async () => {
    process.env.API_TOKEN = "secret";
    const res = requireApiToken(req({ authorization: "Bearer nope" }));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  it("returns 401 when the token is wrong but the same length (exercises timingSafeEqual)", async () => {
    process.env.API_TOKEN = "secret";
    const res = requireApiToken(req({ authorization: "Bearer secreT" }));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  it("returns null when the token matches", () => {
    process.env.API_TOKEN = "secret";
    const res = requireApiToken(req({ authorization: "Bearer secret" }));
    expect(res).toBeNull();
  });
});
