export const ACCESS_TOKEN_STORAGE_KEY = "iot.accessToken";

export function storeAccessToken(token: string): void {
  try {
    localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, token);
  } catch {
    // Storage can be unavailable, such as in private browsing modes.
  }
}

export function restoreAccessToken(nowMs = Date.now()): string | null {
  try {
    const token = localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY);
    if (token === null) {
      return null;
    }

    const payloadSegment = token.split(".")[1];
    if (payloadSegment === undefined) {
      throw new Error("Access token is not a JWT");
    }

    const base64Payload = payloadSegment.replace(/-/g, "+").replace(/_/g, "/");
    const paddedPayload = base64Payload.padEnd(Math.ceil(base64Payload.length / 4) * 4, "=");
    const payload: unknown = JSON.parse(atob(paddedPayload));
    const exp = typeof payload === "object" && payload !== null ? (payload as { exp?: unknown }).exp : undefined;

    if (typeof exp !== "number" || !Number.isFinite(exp) || exp * 1000 <= nowMs) {
      throw new Error("Access token is expired or invalid");
    }

    return token;
  } catch {
    clearAccessToken();
    return null;
  }
}

export function clearAccessToken(): void {
  try {
    localStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
  } catch {
    // Storage can be unavailable, such as in private browsing modes.
  }
}
