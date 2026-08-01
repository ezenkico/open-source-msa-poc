import type { Measurement } from "./measurementState";

export type Device = {
  id: string;
  name: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type CurrentUser = {
  can_add_devices: boolean;
};

export type CreatedDevice = Device & {
  key: string;
};

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Request failed with status ${status}`);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request(path: string, init: RequestInit = {}, acceptedStatuses: readonly number[] = []) {
  const response = await fetch(path, init);
  if (!response.ok && !acceptedStatuses.includes(response.status)) {
    throw new ApiError(response.status);
  }
  return response;
}

function bearer(accessToken: string): HeadersInit {
  return { Authorization: `Bearer ${accessToken}` };
}

function parseCurrentUser(value: unknown): CurrentUser {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { can_add_devices?: unknown }).can_add_devices !== "boolean"
  ) {
    throw new Error("Current-user response did not include a boolean can_add_devices");
  }
  return { can_add_devices: (value as { can_add_devices: boolean }).can_add_devices };
}

function parseDevice(value: unknown): Device {
  if (typeof value !== "object" || value === null) {
    throw new Error("Created-device response included an invalid id");
  }

  const device = value as Partial<Device>;
  if (typeof device.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(device.id)) {
    throw new Error("Created-device response included an invalid id");
  }
  if (typeof device.name !== "string" || device.name.length === 0) {
    throw new Error("Created-device response included an invalid name");
  }
  if (typeof device.enabled !== "boolean") {
    throw new Error("Created-device response included an invalid enabled field");
  }
  if (typeof device.created_at !== "string" || device.created_at.length === 0) {
    throw new Error("Created-device response included an invalid created_at field");
  }
  if (typeof device.updated_at !== "string" || device.updated_at.length === 0) {
    throw new Error("Created-device response included an invalid updated_at field");
  }

  return {
    id: device.id,
    name: device.name,
    enabled: device.enabled,
    created_at: device.created_at,
    updated_at: device.updated_at,
  };
}

function parseCreatedDevice(value: unknown): CreatedDevice {
  const device = parseDevice(value);
  const key = (value as { key?: unknown }).key;
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("Created-device response did not include a provisioning key");
  }
  return { ...device, key };
}

export async function login(username: string, password: string): Promise<string> {
  const response = await request("/api/auth/jwt/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || typeof (body as { access?: unknown }).access !== "string") {
    throw new Error("Login response did not include an access token");
  }
  return (body as { access: string }).access;
}

export async function getNatsToken(accessToken: string): Promise<string> {
  const response = await request("/api/nats-auth/token/", { headers: bearer(accessToken) });
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || typeof (body as { token?: unknown }).token !== "string") {
    throw new Error("NATS token response did not include a token");
  }
  return (body as { token: string }).token;
}

export async function getCurrentUser(accessToken: string): Promise<CurrentUser> {
  const response = await request("/api/auth/me/", { headers: bearer(accessToken) });
  return parseCurrentUser(await response.json());
}

export async function createDevice(name: string, accessToken: string): Promise<CreatedDevice> {
  const response = await request("/api/devices/", {
    method: "POST",
    headers: { ...bearer(accessToken), "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return parseCreatedDevice(await response.json());
}

export async function listDevices(accessToken: string): Promise<Device[]> {
  const response = await request("/api/devices/", { headers: bearer(accessToken) });
  return response.json() as Promise<Device[]>;
}

export async function getLatest(deviceId: string, accessToken: string): Promise<Measurement | null> {
  const response = await request(
    `/api/devices/${deviceId}/measurements/latest/`,
    { headers: bearer(accessToken) },
    [404],
  );
  if (response.status === 404) {
    return null;
  }
  return response.json() as Promise<Measurement>;
}

export async function getMeasurements(
  deviceId: string,
  accessToken: string,
  query: string,
): Promise<Measurement[]> {
  const response = await request(`/api/devices/${deviceId}/measurements/?${query}`, {
    headers: bearer(accessToken),
  });
  return response.json() as Promise<Measurement[]>;
}
