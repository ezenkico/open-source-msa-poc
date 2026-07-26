import type { Measurement } from "./measurementState";

export type Device = {
  id: string;
  name: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(path, init);
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }
  return response;
}

function bearer(accessToken: string): HeadersInit {
  return { Authorization: `Bearer ${accessToken}` };
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

export async function listDevices(accessToken: string): Promise<Device[]> {
  const response = await request("/api/devices/", { headers: bearer(accessToken) });
  return response.json() as Promise<Device[]>;
}

export async function getLatest(deviceId: string, accessToken: string): Promise<Measurement | null> {
  const response = await fetch(`/api/devices/${deviceId}/measurements/latest/`, { headers: bearer(accessToken) });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
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
