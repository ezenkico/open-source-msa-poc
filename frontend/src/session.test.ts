import { afterEach, describe, expect, it } from "vitest";
import {
  ACCESS_TOKEN_STORAGE_KEY,
  clearAccessToken,
  restoreAccessToken,
  storeAccessToken,
} from "./session";

const now = 1_700_000_000_000;
const expBeforeNowToken = "eyJhbGciOiJub25lIn0.eyJleHAiOjE2OTk5OTk5OTl9.signature";
const expAfterNowToken = "eyJhbGciOiJub25lIn0.eyJleHAiOjE3MDAwMDAwMDF9.signature";

afterEach(() => localStorage.clear());

describe("access-token session storage", () => {
  it("stores the access token at its isolated storage key", () => {
    localStorage.setItem("unrelated", "preserved");

    storeAccessToken("token");

    expect(localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY)).toBe("token");
    expect(localStorage.getItem("unrelated")).toBe("preserved");
  });

  it("removes an expired token instead of restoring it", () => {
    localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, expBeforeNowToken);

    expect(restoreAccessToken(now)).toBeNull();
    expect(localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY)).toBeNull();
  });

  it("restores a token whose expiry is still in the future", () => {
    localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, expAfterNowToken);

    expect(restoreAccessToken(now)).toBe(expAfterNowToken);
  });

  it("removes malformed stored tokens instead of restoring them", () => {
    localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, "malformed");

    expect(restoreAccessToken(now)).toBeNull();
    expect(localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY)).toBeNull();
  });

  it("clears only the persisted access token", () => {
    localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, expAfterNowToken);
    localStorage.setItem("unrelated", "preserved");

    clearAccessToken();

    expect(localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem("unrelated")).toBe("preserved");
  });
});
