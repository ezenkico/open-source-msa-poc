import { FormEvent, useCallback, useEffect, useState } from "react";
import {
  getLatest,
  getMeasurements,
  getNatsToken,
  listDevices,
  login,
  type Device,
} from "./api";
import { subscribeToMeasurements } from "./nats";
import {
  mergeNotification,
  type Measurement,
  type MeasurementState,
} from "./measurementState";

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
  const [devices, setDevices] = useState<Device[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [measurementState, setMeasurementState] = useState<MeasurementState>(EMPTY_STATE);
  const [apiError, setApiError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  const loadAuthoritativeState = useCallback(async (selectedDeviceId: string, token: string) => {
    const [latest, rows] = await Promise.all([
      getLatest(selectedDeviceId, token),
      getMeasurements(selectedDeviceId, token, `limit=${PAGE_SIZE}`),
    ]);
    setMeasurementState({ latest, rows, missingRange: null });
  }, []);

  async function submitLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setApiError(null);
    try {
      const token = await login(username, password);
      const listedDevices = await listDevices(token);
      setAccessToken(token);
      setDevices(listedDevices);
      setDeviceId("");
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "Login failed");
    }
  }

  function selectDevice(selectedDeviceId: string) {
    setDeviceId(selectedDeviceId);
    setConnectionError(null);
    setApiError(null);
    setMeasurementState(EMPTY_STATE);
  }

  useEffect(() => {
    if (!accessToken || !deviceId) {
      return;
    }

    const token = accessToken;
    let disposed = false;
    let closeSubscription: () => void = () => {};

    async function start() {
      try {
        await loadAuthoritativeState(deviceId, token);
        const natsToken = await getNatsToken(token);
        if (disposed) {
          return;
        }
        closeSubscription = await subscribeToMeasurements(
          deviceId,
          natsToken,
          (notification) => setMeasurementState((current) => mergeNotification(current, notification, PAGE_SIZE)),
          () => {
            void loadAuthoritativeState(deviceId, token).catch((error: unknown) => {
              if (!disposed) {
                setApiError(error instanceof Error ? error.message : "Could not reload measurements");
              }
            });
          },
          (error) => {
            if (!disposed) {
              setConnectionError(error.message);
            }
          },
        );
      } catch (error) {
        if (!disposed) {
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

    void getMeasurements(
      deviceId,
      accessToken,
      `after_index=${range.afterIndex}&through_index=${range.throughIndex}&limit=${PAGE_SIZE}`,
    ).then((rows) => {
      setMeasurementState((current) => ({
        ...current,
        rows: appendUniqueRows(current.rows, rows),
        missingRange: null,
      }));
    }).catch((error: unknown) => {
      setApiError(error instanceof Error ? error.message : "Could not load missing measurements");
    });
  }, [accessToken, deviceId, measurementState.missingRange]);

  async function loadPreviousPage() {
    const firstIndex = measurementState.rows[0]?.entry_index;
    if (!accessToken || !deviceId || firstIndex === undefined) {
      return;
    }
    setApiError(null);
    try {
      const rows = await getMeasurements(deviceId, accessToken, `before_index=${firstIndex}&limit=${PAGE_SIZE}`);
      setMeasurementState((current) => ({ ...current, rows, missingRange: null }));
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "Could not load the previous page");
    }
  }

  const { latest, rows } = measurementState;
  return (
    <main>
      <h1>IoT measurements</h1>
      {!accessToken && (
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
