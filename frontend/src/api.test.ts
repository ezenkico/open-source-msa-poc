import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  createDevice,
  getCurrentUser,
  getLatest,
  getMeasurements,
  listDevices,
  login,
} from "./api";

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

afterEach(() => vi.unstubAllGlobals());

const createdDevice = {
  id: "a1111111-1111-4111-8111-111111111111",
  name: "Boiler",
  enabled: true,
  created_at: "2026-08-01T12:00:00Z",
  updated_at: "2026-08-01T12:00:00Z",
  key: "provisioning-key",
};

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

  it("gets the current-user capability with Bearer authorization", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ can_add_devices: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getCurrentUser("token")).resolves.toEqual({ can_add_devices: true });

    expect(fetchMock).toHaveBeenCalledWith("/api/auth/me/", {
      headers: { Authorization: "Bearer token" },
    });
  });

  it("posts a device name and returns its provisioning credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(createdDevice));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createDevice("Boiler", "token")).resolves.toEqual(createdDevice);

    expect(fetchMock).toHaveBeenCalledWith("/api/devices/", {
      method: "POST",
      headers: {
        Authorization: "Bearer token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "Boiler" }),
    });
  });

  it.each([
    [null, "Current-user response did not include a boolean can_add_devices"],
    [undefined, "Current-user response did not include a boolean can_add_devices"],
    [{}, "Current-user response did not include a boolean can_add_devices"],
    [{ can_add_devices: "true" }, "Current-user response did not include a boolean can_add_devices"],
  ])("rejects invalid current-user capability responses: %o", async (body, error) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(body)));

    await expect(getCurrentUser("token")).rejects.toThrow(error);
  });

  it.each([
    [{ ...createdDevice, id: "not-a-uuid" }, "Created-device response included an invalid id"],
    [{ ...createdDevice, name: "" }, "Created-device response included an invalid name"],
    [{ ...createdDevice, enabled: undefined }, "Created-device response included an invalid enabled field"],
    [{ ...createdDevice, created_at: undefined }, "Created-device response included an invalid created_at field"],
    [{ ...createdDevice, updated_at: 123 }, "Created-device response included an invalid updated_at field"],
    [{ ...createdDevice, key: "" }, "Created-device response did not include a provisioning key"],
    [{ ...createdDevice, key: undefined }, "Created-device response did not include a provisioning key"],
  ])("rejects invalid created-device responses: %o", async (body, error) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(body)));

    await expect(createDevice("Boiler", "token")).rejects.toThrow(error);
  });

  it("reports the HTTP status for a non-success response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ detail: "no" }, 503)));

    await expect(listDevices("access-token")).rejects.toThrow("status 503");
  });

  it("rejects unauthorized device requests with an API status error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ detail: "expired" }, 401)));

    await expect(listDevices("expired")).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
    });
  });

  it("preserves a forbidden device-creation status as an API error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ detail: "forbidden" }, 403)));

    const error = await createDevice("Boiler", "token").catch((error: unknown) => error);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
  });

  it("returns null when the latest measurement endpoint responds with 404", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ detail: "missing" }, 404)));

    await expect(getLatest("device-1", "access-token")).resolves.toBeNull();
  });
});
