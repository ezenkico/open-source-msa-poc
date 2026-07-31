import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  ApiError,
  getLatest,
  getMeasurements,
  getNatsToken,
  listDevices,
  login,
  type Device,
} from "./api";
import { subscribeToDeviceCreations, subscribeToMeasurements } from "./nats";
import {
  mergeNotification,
  type Measurement,
  type MeasurementState,
} from "./measurementState";
import { clearAccessToken, restoreAccessToken, storeAccessToken } from "./session";

export const PAGE_SIZE = 50;

const EMPTY_STATE: MeasurementState = { latest: null, rows: [], missingRange: null };

function formatTime(timestamp: string): string {
  return new Date(timestamp).toLocaleString();
}

function appendUniqueRows(rows: Measurement[], additions: Measurement[]): Measurement[] {
  const indexes = new Set(rows.map((row) => row.entry_index));
  return [...rows, ...additions.filter((row) => !indexes.has(row.entry_index))]
    .sort((left, right) => left.entry_index - right.entry_index)
    .slice(0, PAGE_SIZE);
}

export default function App() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(true);
  const [devices, setDevices] = useState<Device[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [measurementState, setMeasurementState] = useState<MeasurementState>(EMPTY_STATE);
  const [apiError, setApiError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const selectionGeneration = useRef(0);
  const deviceListRequestGeneration = useRef(0);
  const authenticationGeneration = useRef(0);
  const selectedDeviceIdRef = useRef("");

  const logout = useCallback(() => {
    clearAccessToken();
    selectionGeneration.current += 1;
    deviceListRequestGeneration.current += 1;
    authenticationGeneration.current += 1;
    selectedDeviceIdRef.current = "";
    setAccessToken(null);
    setDevices([]);
    setDeviceId("");
    setMeasurementState(EMPTY_STATE);
    setConnectionError(null);
  }, []);

  const refreshDevices = useCallback(async (token: string, authGeneration: number) => {
    const generation = ++deviceListRequestGeneration.current;
    try {
      const listedDevices = await listDevices(token);
      if (
        authenticationGeneration.current !== authGeneration
        || deviceListRequestGeneration.current !== generation
      ) {
        return;
      }
      setDevices(listedDevices);
      setApiError(null);
      if (selectedDeviceIdRef.current && !listedDevices.some((device) => device.id === selectedDeviceIdRef.current)) {
        selectionGeneration.current += 1;
        selectedDeviceIdRef.current = "";
        setDeviceId("");
        setMeasurementState(EMPTY_STATE);
        setConnectionError(null);
      }
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        if (authenticationGeneration.current === authGeneration) {
          logout();
        }
        return;
      }
      if (
        authenticationGeneration.current !== authGeneration
        || deviceListRequestGeneration.current !== generation
      ) {
        return;
      }
      setApiError(error instanceof Error ? error.message : "Could not refresh devices");
    }
  }, [logout]);

  const loadAuthoritativeState = useCallback(async (selectedDeviceId: string, token: string) => {
    const [latest, rows] = await Promise.all([
      getLatest(selectedDeviceId, token),
      getMeasurements(selectedDeviceId, token, `limit=${PAGE_SIZE}`),
    ]);
    return { latest, rows, missingRange: null };
  }, []);

  useEffect(() => {
    const restoredToken = restoreAccessToken();
    if (!restoredToken) {
      setIsStarting(false);
      return;
    }

    let disposed = false;
    void listDevices(restoredToken).then((listedDevices) => {
      if (!disposed) {
        setDevices(listedDevices);
        authenticationGeneration.current += 1;
        setAccessToken(restoredToken);
        selectedDeviceIdRef.current = "";
        setDeviceId("");
      }
    }).catch((error: unknown) => {
      if (disposed) {
        return;
      }
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        logout();
      } else {
        setApiError(error instanceof Error ? error.message : "Could not restore the session");
      }
    }).finally(() => {
      if (!disposed) {
        setIsStarting(false);
      }
    });

    return () => {
      disposed = true;
    };
  }, [logout]);

  async function submitLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setApiError(null);
    try {
      const token = await login(username, password);
      const listedDevices = await listDevices(token);
      storeAccessToken(token);
      authenticationGeneration.current += 1;
      setAccessToken(token);
      setDevices(listedDevices);
      selectedDeviceIdRef.current = "";
      setDeviceId("");
      setMeasurementState(EMPTY_STATE);
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "Login failed");
    }
  }

  function selectDevice(selectedDeviceId: string) {
    selectionGeneration.current += 1;
    selectedDeviceIdRef.current = selectedDeviceId;
    setDeviceId(selectedDeviceId);
    setConnectionError(null);
    setApiError(null);
    setMeasurementState(EMPTY_STATE);
  }

  useEffect(() => {
    if (!accessToken) {
      return;
    }

    const token = accessToken;
    const authGeneration = authenticationGeneration.current;
    let disposed = false;
    let closeSubscription: () => void = () => {};

    void getNatsToken(token).then((natsToken) => {
      if (disposed) {
        return undefined;
      }
      return subscribeToDeviceCreations(
        natsToken,
        () => {
          if (!disposed) {
            void refreshDevices(token, authGeneration);
          }
        },
        () => {
          if (!disposed) {
            void refreshDevices(token, authGeneration);
          }
        },
        (error) => {
          if (!disposed) {
            setConnectionError(error.message);
          }
        },
      );
    }).then((close) => {
      if (!close) {
        return;
      }
      if (disposed) {
        close();
      } else {
        closeSubscription = close;
        void refreshDevices(token, authGeneration);
      }
    }).catch((error: unknown) => {
      if (!disposed) {
        setConnectionError(error instanceof Error ? error.message : "Could not connect to device notifications");
      }
    });

    return () => {
      disposed = true;
      closeSubscription();
    };
  }, [accessToken, refreshDevices]);

  useEffect(() => {
    if (!accessToken || !deviceId) {
      return;
    }

    const token = accessToken;
    const generation = selectionGeneration.current;
    let disposed = false;
    let closeSubscription: () => void = () => {};
    let initialStateLoaded = false;
    const pendingNotifications: Measurement[] = [];
    const isCurrent = () => !disposed && selectionGeneration.current === generation;

    async function start() {
      try {
        const natsToken = await getNatsToken(token);
        if (!isCurrent()) {
          return;
        }
        const close = await subscribeToMeasurements(
          deviceId,
          natsToken,
          (notification) => {
            if (isCurrent()) {
              if (!initialStateLoaded) {
                pendingNotifications.push(notification);
              } else {
                setMeasurementState((current) => mergeNotification(current, notification, PAGE_SIZE));
              }
            }
          },
          () => {
            void loadAuthoritativeState(deviceId, token).then((reloadedState) => {
              if (isCurrent()) {
                setMeasurementState(reloadedState);
              }
            }).catch((error: unknown) => {
              if (isCurrent()) {
                setApiError(error instanceof Error ? error.message : "Could not reload measurements");
              }
            });
          },
          (error) => {
            if (isCurrent()) {
              setConnectionError(error.message);
            }
          },
        );
        if (!isCurrent()) {
          close();
          return;
        }
        closeSubscription = close;
        const state = await loadAuthoritativeState(deviceId, token);
        if (!isCurrent()) {
          return;
        }
        const mergedState = pendingNotifications.reduce<MeasurementState>(
          (current, notification) => mergeNotification(current, notification, PAGE_SIZE),
          state,
        );
        pendingNotifications.length = 0;
        initialStateLoaded = true;
        setMeasurementState(mergedState);
      } catch (error) {
        if (isCurrent()) {
          setConnectionError(error instanceof Error ? error.message : "Could not connect to notifications");
        }
      }
    }

    void start();
    return () => {
      disposed = true;
      closeSubscription();
    };
  }, [accessToken, deviceId, loadAuthoritativeState]);

  useEffect(() => {
    const range = measurementState.missingRange;
    if (!range || !accessToken || !deviceId) {
      return;
    }

    const generation = selectionGeneration.current;
    let disposed = false;
    const isCurrent = () => !disposed && selectionGeneration.current === generation;
    void getMeasurements(
      deviceId,
      accessToken,
      `after_index=${range.afterIndex}&through_index=${range.throughIndex}&limit=${PAGE_SIZE}`,
    ).then((rows) => {
      if (isCurrent()) {
        setMeasurementState((current) => ({
          ...current,
          rows: appendUniqueRows(current.rows, rows),
          missingRange: null,
        }));
      }
    }).catch((error: unknown) => {
      if (isCurrent()) {
        setApiError(error instanceof Error ? error.message : "Could not load missing measurements");
      }
    });
    return () => {
      disposed = true;
    };
  }, [accessToken, deviceId, measurementState.missingRange]);

  async function loadPreviousPage() {
    const firstIndex = measurementState.rows[0]?.entry_index;
    if (!accessToken || !deviceId || firstIndex === undefined) {
      return;
    }
    const generation = selectionGeneration.current;
    setApiError(null);
    try {
      const rows = await getMeasurements(deviceId, accessToken, `before_index=${firstIndex}&limit=${PAGE_SIZE}`);
      if (selectionGeneration.current !== generation) {
        return;
      }
      setMeasurementState((current) => ({ ...current, rows, missingRange: null }));
    } catch (error) {
      if (selectionGeneration.current === generation) {
        setApiError(error instanceof Error ? error.message : "Could not load the previous page");
      }
    }
  }

  const { latest, rows } = measurementState;
  return (
    <main>
      <h1>IoT measurements</h1>
      {!isStarting && !accessToken && (
        <form onSubmit={submitLogin}>
          <label>
            Username
            <input value={username} onChange={(event) => setUsername(event.target.value)} required autoComplete="username" />
          </label>
          <label>
            Password
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required autoComplete="current-password" />
          </label>
          <button type="submit">Sign in</button>
        </form>
      )}

      {accessToken && (
        <label>
          Selected device
          <select value={deviceId} onChange={(event) => selectDevice(event.target.value)}>
            <option value="">Choose a device</option>
            {devices.map((device) => <option key={device.id} value={device.id}>{device.name}</option>)}
          </select>
        </label>
      )}

      {apiError && <p role="alert">API error: {apiError}</p>}
      {connectionError && <p role="alert">Connection error: {connectionError}</p>}

      <section aria-live="polite">
        <h2>Latest measurement{latest ? `: ${latest.measurement_name} ${latest.value}` : ""}</h2>
        {latest ? <p>{latest.measured_at}</p> : <p>No measurements yet.</p>}
      </section>

      <section aria-label="Measurement history">
        <h2>Measurement history</h2>
        <button type="button" onClick={() => void loadPreviousPage()} disabled={rows.length === 0}>Previous page</button>
        <table>
          <thead>
            <tr><th scope="col">Index</th><th scope="col">Name</th><th scope="col">Value</th><th scope="col">Measured time</th><th scope="col">Received time</th></tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.entry_index}>
                <td>{row.entry_index}</td><td>{row.measurement_name}</td><td>{row.value}</td><td>{formatTime(row.measured_at)}</td><td>{formatTime(row.received_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
