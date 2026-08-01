import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  getCurrentUser,
  getLatest,
  getMeasurements,
  getNatsToken,
  listDevices,
  login,
  type CreatedDevice,
  type CurrentUser,
  type Device,
  type MeasurementOrder,
  type MeasurementPage,
} from "./api";
import DeviceProvisioning from "./DeviceProvisioning";
import { subscribeToDeviceCreations, subscribeToMeasurements } from "./nats";
import {
  mergeNotification,
  type Measurement,
  type MeasurementState,
} from "./measurementState";
import { clearAccessToken, restoreAccessToken, storeAccessToken } from "./session";
import { useDebouncedCallback } from "./useDebouncedCallback";

export const PAGE_SIZE = 50;

const EMPTY_STATE: MeasurementState = { latest: null, rows: [], missingRange: null };

function formatTime(timestamp: string): string {
  return new Date(timestamp).toLocaleString();
}

async function loadAuthenticatedPrerequisites(token: string): Promise<[Device[], CurrentUser]> {
  const results = await Promise.allSettled([
    listDevices(token),
    getCurrentUser(token),
  ]);
  const authenticationFailure = results.find((result) => (
    result.status === "rejected"
    && result.reason instanceof ApiError
    && (result.reason.status === 401 || result.reason.status === 403)
  ));
  if (authenticationFailure?.status === "rejected") {
    throw authenticationFailure.reason;
  }

  const [devicesResult, currentUserResult] = results;
  if (devicesResult.status === "rejected") {
    throw devicesResult.reason;
  }
  if (currentUserResult.status === "rejected") {
    throw currentUserResult.reason;
  }
  return [devicesResult.value, currentUserResult.value];
}

export default function App() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(true);
  const [devices, setDevices] = useState<Device[]>([]);
  const [canAddDevices, setCanAddDevices] = useState(false);
  const [deviceId, setDeviceId] = useState("");
  const [measurementState, setMeasurementState] = useState<MeasurementState>(EMPTY_STATE);
  const [offset, setOffset] = useState(0);
  const [order, setOrder] = useState<MeasurementOrder>("desc");
  const [measurementPage, setMeasurementPage] = useState<MeasurementPage | null>(null);
  const [isPageLoading, setIsPageLoading] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const selectionGeneration = useRef(0);
  const pageRequestGeneration = useRef(0);
  const pageLoadGeneration = useRef(0);
  const deviceListRequestGeneration = useRef(0);
  const authenticationGeneration = useRef(0);
  const loginAttemptGeneration = useRef(0);
  const selectedDeviceIdRef = useRef("");
  const offsetRef = useRef(0);
  const orderRef = useRef<MeasurementOrder>("desc");

  const logout = useCallback(() => {
    clearAccessToken();
    selectionGeneration.current += 1;
    pageRequestGeneration.current += 1;
    deviceListRequestGeneration.current += 1;
    authenticationGeneration.current += 1;
    loginAttemptGeneration.current += 1;
    selectedDeviceIdRef.current = "";
    offsetRef.current = 0;
    orderRef.current = "desc";
    setAccessToken(null);
    setDevices([]);
    setCanAddDevices(false);
    setDeviceId("");
    setMeasurementState(EMPTY_STATE);
    setOffset(0);
    setOrder("desc");
    setMeasurementPage(null);
    setIsPageLoading(false);
    setConnectionError(null);
  }, []);

  const loadMeasurementPage = useCallback(async (
    selectedDeviceId: string,
    token: string,
    requestedOffset: number,
    requestedOrder: MeasurementOrder,
    selectedGeneration: number,
  ): Promise<MeasurementPage | null> => {
    pageLoadGeneration.current += 1;

    async function requestPage(targetOffset: number, correctionAttempted: boolean): Promise<MeasurementPage | null> {
      const requestGeneration = ++pageRequestGeneration.current;
      setIsPageLoading(true);
      setApiError(null);

      const isCurrentRequest = () => (
        selectionGeneration.current === selectedGeneration
        && selectedDeviceIdRef.current === selectedDeviceId
        && pageRequestGeneration.current === requestGeneration
        && orderRef.current === requestedOrder
      );

      try {
        const page = await getMeasurements(
          selectedDeviceId,
          token,
          `limit=${PAGE_SIZE}&offset=${targetOffset}&order=${requestedOrder}`,
        );
        if (!isCurrentRequest()) {
          return null;
        }

        if (
          !correctionAttempted
          && page.results.length === 0
          && page.total > 0
          && page.offset >= page.total
        ) {
          const lastValidOffset = Math.floor((page.total - 1) / page.limit) * page.limit;
          if (lastValidOffset !== targetOffset) {
            return requestPage(lastValidOffset, true);
          }
        }

        const committedPage = page.total === 0 && page.offset !== 0
          ? { ...page, offset: 0 }
          : page;
        offsetRef.current = committedPage.offset;
        setOffset(committedPage.offset);
        setMeasurementPage(committedPage);
        setMeasurementState((current) => ({
          ...current,
          rows: committedPage.results,
        }));
        setApiError(null);
        return committedPage;
      } catch (error) {
        if (isCurrentRequest()) {
          setApiError(error instanceof Error ? error.message : "Could not load measurements");
        }
        return null;
      } finally {
        if (
          selectionGeneration.current === selectedGeneration
          && selectedDeviceIdRef.current === selectedDeviceId
          && pageRequestGeneration.current === requestGeneration
        ) {
          setIsPageLoading(false);
        }
      }
    }

    return requestPage(requestedOffset, false);
  }, []);

  const refreshSelectedMeasurements = useCallback(() => {
    const selectedDeviceId = selectedDeviceIdRef.current;
    const selectedOffset = offsetRef.current;
    const selectedOrder = orderRef.current;
    const generation = selectionGeneration.current;
    if (!accessToken || !selectedDeviceId) {
      return;
    }

    const latestRequest = getLatest(selectedDeviceId, accessToken).then(
      (latest) => ({ latest, status: "fulfilled" as const }),
      (error: unknown) => ({ error, status: "rejected" as const }),
    );
    const pageRequest = loadMeasurementPage(
      selectedDeviceId,
      accessToken,
      selectedOffset,
      selectedOrder,
      generation,
    );
    const loadGeneration = pageLoadGeneration.current;
    void Promise.all([
      latestRequest,
      pageRequest,
    ]).then(([latestResult, page]) => {
      if (
        !page
        || selectionGeneration.current !== generation
        || pageLoadGeneration.current !== loadGeneration
      ) {
        return;
      }
      if (latestResult.status === "rejected") {
        setApiError(latestResult.error instanceof Error
          ? latestResult.error.message
          : "Could not reload measurements");
        return;
      }
      setMeasurementState((current) => ({ ...current, latest: latestResult.latest }));
    });
  }, [accessToken, loadMeasurementPage]);

  const { schedule: scheduleMeasurementRefresh } = useDebouncedCallback(
    refreshSelectedMeasurements,
    250,
    [accessToken, deviceId],
  );

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
        pageRequestGeneration.current += 1;
        selectedDeviceIdRef.current = "";
        offsetRef.current = 0;
        setDeviceId("");
        setMeasurementState(EMPTY_STATE);
        setOffset(0);
        setMeasurementPage(null);
        setIsPageLoading(false);
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

  useEffect(() => {
    const restoredToken = restoreAccessToken();
    if (!restoredToken) {
      setIsStarting(false);
      return;
    }

    let disposed = false;
    void loadAuthenticatedPrerequisites(restoredToken).then(([listedDevices, currentUser]) => {
      if (!disposed) {
        setDevices(listedDevices);
        setCanAddDevices(currentUser.can_add_devices);
        authenticationGeneration.current += 1;
        setAccessToken(restoredToken);
        selectedDeviceIdRef.current = "";
        offsetRef.current = 0;
        setDeviceId("");
        setMeasurementState(EMPTY_STATE);
        setOffset(0);
        setMeasurementPage(null);
        setIsPageLoading(false);
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

  async function submitLogin(event: any) {
    event.preventDefault();
    const attemptGeneration = ++loginAttemptGeneration.current;
    setApiError(null);
    let token: string;
    try {
      token = await login(username, password);
    } catch (error) {
      if (loginAttemptGeneration.current === attemptGeneration) {
        setApiError(error instanceof Error ? error.message : "Login failed");
      }
      return;
    }
    if (loginAttemptGeneration.current !== attemptGeneration) {
      return;
    }

    let listedDevices: Device[];
    let currentUser: CurrentUser;
    try {
      [listedDevices, currentUser] = await loadAuthenticatedPrerequisites(token);
    } catch (error) {
      if (loginAttemptGeneration.current !== attemptGeneration) {
        return;
      }
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        logout();
        return;
      }
      setApiError(error instanceof Error ? error.message : "Login failed");
      return;
    }
    if (loginAttemptGeneration.current !== attemptGeneration) {
      return;
    }

    try {
      storeAccessToken(token);
      authenticationGeneration.current += 1;
      setAccessToken(token);
      setDevices(listedDevices);
      setCanAddDevices(currentUser.can_add_devices);
      selectedDeviceIdRef.current = "";
      offsetRef.current = 0;
      pageRequestGeneration.current += 1;
      setDeviceId("");
      setMeasurementState(EMPTY_STATE);
      setOffset(0);
      setMeasurementPage(null);
      setIsPageLoading(false);
    } catch (error) {
      if (loginAttemptGeneration.current === attemptGeneration) {
        setApiError(error instanceof Error ? error.message : "Login failed");
      }
    }
  }

  const reloadCapabilityAfterPermissionDenied = useCallback(async (
    token: string,
    authGeneration: number,
  ) => {
    setCanAddDevices(false);
    setApiError("Your device creation permission changed.");
    try {
      const currentUser = await getCurrentUser(token);
      if (authenticationGeneration.current !== authGeneration) {
        return;
      }
      setCanAddDevices(currentUser.can_add_devices);
    } catch (error) {
      if (authenticationGeneration.current !== authGeneration) {
        return;
      }
      if (error instanceof ApiError && error.status === 401) {
        logout();
        return;
      }
      setApiError(error instanceof Error ? error.message : "Could not reload device creation permission");
    }
  }, [logout]);

  function selectDevice(selectedDeviceId: string) {
    selectionGeneration.current += 1;
    pageRequestGeneration.current += 1;
    selectedDeviceIdRef.current = selectedDeviceId;
    offsetRef.current = 0;
    setDeviceId(selectedDeviceId);
    setOffset(0);
    setConnectionError(null);
    setApiError(null);
    setMeasurementState(EMPTY_STATE);
    setMeasurementPage(null);
    setIsPageLoading(false);
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
                setMeasurementState((current) => mergeNotification(current, notification));
                scheduleMeasurementRefresh();
              }
            }
          },
          () => {
            const reconnectOffset = offsetRef.current;
            const reconnectOrder = orderRef.current;
            void Promise.all([
              getLatest(deviceId, token),
              loadMeasurementPage(
                deviceId,
                token,
                reconnectOffset,
                reconnectOrder,
                generation,
              ),
            ]).then(([latest]) => {
              if (isCurrent()) {
                setMeasurementState((current) => ({ ...current, latest }));
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
        const initialOffset = offsetRef.current;
        const initialOrder = orderRef.current;
        const [latest] = await Promise.all([
          getLatest(deviceId, token),
          loadMeasurementPage(deviceId, token, initialOffset, initialOrder, generation),
        ]);
        if (!isCurrent()) {
          return;
        }
        const queuedNotifications = pendingNotifications.splice(0);
        pendingNotifications.length = 0;
        initialStateLoaded = true;
        setMeasurementState((current) => queuedNotifications.reduce<MeasurementState>(
          (state, notification) => mergeNotification(state, notification),
          { ...current, latest },
        ));
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
  }, [accessToken, deviceId, loadMeasurementPage, scheduleMeasurementRefresh]);

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
    ).then((page) => {
      void page.results;
      if (isCurrent()) {
        setMeasurementState((current) => {
          if (
            current.missingRange?.afterIndex !== range.afterIndex
            || current.missingRange.throughIndex !== range.throughIndex
          ) {
            return current;
          }
          return { ...current, missingRange: null };
        });
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

  function loadAdjacentPage(targetOffset: number) {
    if (
      !accessToken
      || !deviceId
      || isPageLoading
      || (targetOffset === offset && measurementPage?.offset === offset)
    ) {
      return;
    }
    void loadMeasurementPage(
      deviceId,
      accessToken,
      targetOffset,
      orderRef.current,
      selectionGeneration.current,
    );
  }

  function changeMeasurementOrder(nextOrder: MeasurementOrder) {
    if (nextOrder === orderRef.current) {
      return;
    }
    orderRef.current = nextOrder;
    offsetRef.current = 0;
    pageRequestGeneration.current += 1;
    setOrder(nextOrder);
    setOffset(0);
    if (accessToken && deviceId) {
      void loadMeasurementPage(
        deviceId,
        accessToken,
        0,
        nextOrder,
        selectionGeneration.current,
      );
    }
  }

  const { latest, rows } = measurementState;
  const currentPage = measurementPage
    ? Math.floor(measurementPage.offset / measurementPage.limit) + 1
    : 1;
  const totalPages = measurementPage
    ? Math.max(1, Math.ceil(measurementPage.total / measurementPage.limit))
    : 1;
  const hasPrevious = measurementPage ? measurementPage.offset > 0 : false;
  const hasNext = measurementPage
    ? measurementPage.offset + measurementPage.results.length < measurementPage.total
    : false;
  const selectedDevice = devices.find((device) => device.id === deviceId);
  const renderedAuthenticationGeneration = authenticationGeneration.current;

  function refreshAfterCreation(_createdDevice: CreatedDevice) {
    if (accessToken) {
      void refreshDevices(accessToken, renderedAuthenticationGeneration);
    }
  }

  function handlePermissionDenied() {
    if (accessToken) {
      void reloadCapabilityAfterPermissionDenied(accessToken, renderedAuthenticationGeneration);
    }
  }

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
        <>
          <label>
            Selected device
            <select value={deviceId} onChange={(event) => selectDevice(event.target.value)}>
              <option value="">Choose a device</option>
              {devices.map((device) => (
                <option key={device.id} value={device.id}>{device.name} — {device.id}</option>
              ))}
            </select>
          </label>
          {selectedDevice && <p><strong>Device ID:</strong> {selectedDevice.id}</p>}
          <DeviceProvisioning
            accessToken={accessToken}
            canAddDevices={canAddDevices}
            onCreated={refreshAfterCreation}
            onAuthenticationLost={logout}
            onPermissionDenied={handlePermissionDenied}
          />
        </>
      )}

      {apiError && <p role="alert">API error: {apiError}</p>}
      {connectionError && <p role="alert">Connection error: {connectionError}</p>}

      <section aria-live="polite">
        <h2>Latest measurement{latest ? `: ${latest.measurement_name} ${latest.value}` : ""}</h2>
        {latest ? <p>{latest.measured_at}</p> : <p>No measurements yet.</p>}
      </section>

      <section aria-label="Measurement history">
        <h2>Measurement history</h2>
        <label>
          Measurement order
          <select
            value={order}
            onChange={(event) => changeMeasurementOrder(event.target.value as MeasurementOrder)}
          >
            <option value="desc">Newest first</option>
            <option value="asc">Oldest first</option>
          </select>
        </label>
        <button
          type="button"
          onClick={() => measurementPage && loadAdjacentPage(Math.max(0, measurementPage.offset - measurementPage.limit))}
          disabled={isPageLoading || !hasPrevious}
        >
          Previous
        </button>
        <span>Page {currentPage} of {totalPages}</span>
        <button
          type="button"
          onClick={() => measurementPage && loadAdjacentPage(measurementPage.offset + measurementPage.limit)}
          disabled={isPageLoading || !hasNext}
        >
          Next
        </button>
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
