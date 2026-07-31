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

    const segments = token.split(".");
    if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) {
      throw new Error("Access token is not a JWT");
    }

    const [headerSegment, payloadSegment] = segments;
    const decodeJsonSegment = (segment: string): unknown => {
      const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
      const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
      return JSON.parse(atob(padded));
    };
    const header = decodeJsonSegment(headerSegment);
    if (typeof header !== "object" || header === null) {
      throw new Error("Access token has an invalid header");
    }

    const payload = decodeJsonSegment(payloadSegment);
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
