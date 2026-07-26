import { afterEach, describe, expect, it, vi } from "vitest";
import { getMeasurements, listDevices, login } from "./api";

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe("API adapter", () => {
  it("posts credentials to the relative login URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ access: "access-token" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(login("reader", "password")).resolves.toBe("access-token");

    expect(fetchMock).toHaveBeenCalledWith("/api/auth/jwt/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "reader", password: "password" }),
    });
  });

  it("uses a relative measurement URL and Bearer authorization", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response([]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getMeasurements("device-1", "access-token", "limit=50")).resolves.toEqual([]);

    expect(fetchMock).toHaveBeenCalledWith("/api/devices/device-1/measurements/?limit=50", {
      headers: { Authorization: "Bearer access-token" },
    });
  });

  it("reports the HTTP status for a non-success response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ detail: "no" }, 503)));

    await expect(listDevices("access-token")).rejects.toThrow("status 503");
  });
});
