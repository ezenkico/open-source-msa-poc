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
import { Button, Field, Panel, StatusBadge } from "./ui";
import { useDebouncedCallback } from "./useDebouncedCallback";

export const PAGE_SIZE = 50;

const EMPTY_STATE: MeasurementState = { latest: null, rows: [], missingRange: null };
type ConnectionState = "connecting" | "live" | "error";

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
  const [isInitialMeasurementLoading, setIsInitialMeasurementLoading] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [deviceUpdatesConnection, setDeviceUpdatesConnection] = useState<ConnectionState>("connecting");
  const [measurementConnection, setMeasurementConnection] = useState<ConnectionState>("connecting");
  const [deviceUpdatesError, setDeviceUpdatesError] = useState<string | null>(null);
  const [measurementConnectionError, setMeasurementConnectionError] = useState<string | null>(null);
  const connectionError = measurementConnectionError ?? deviceUpdatesError;
  const selectionGeneration = useRef(0);
  const pageRequestGeneration = useRef(0);
  const pageLoadGeneration = useRef(0);
  const measurementNotificationGeneration = useRef(0);
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
    setIsInitialMeasurementLoading(false);
    setDeviceUpdatesConnection("connecting");
    setMeasurementConnection("connecting");
    setDeviceUpdatesError(null);
    setMeasurementConnectionError(null);
  }, []);

  const loadMeasurementPage = useCallback(async (
    selectedDeviceId: string,
    token: string,
    requestedOffset: number,
    requestedOrder: MeasurementOrder,
    selectedGeneration: number,
    commitResult = true,
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
        if (commitResult) {
          offsetRef.current = committedPage.offset;
          setOffset(committedPage.offset);
          setMeasurementPage(committedPage);
          setMeasurementState((current) => ({
            ...current,
            rows: committedPage.results,
          }));
          setApiError(null);
        }
        return committedPage;
      } catch (error) {
        if (isCurrentRequest()) {
          if (!commitResult) {
            throw error;
          }
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
    const notificationGeneration = measurementNotificationGeneration.current;
    if (!accessToken || !selectedDeviceId) {
      return;
    }

    const latestPromise = getLatest(selectedDeviceId, accessToken);
    const pagePromise = loadMeasurementPage(
      selectedDeviceId,
      accessToken,
      selectedOffset,
      selectedOrder,
      generation,
      false,
    );
    const loadGeneration = pageLoadGeneration.current;
    let pairFailed = false;
    const isCurrentPair = () => (
      selectionGeneration.current === generation
      && pageLoadGeneration.current === loadGeneration
      && measurementNotificationGeneration.current === notificationGeneration
    );
    const rejectPair = (error: unknown, fallbackMessage: string) => {
      pairFailed = true;
      if (isCurrentPair()) {
        setApiError(error instanceof Error ? error.message : fallbackMessage);
      }
      return { error, status: "rejected" as const };
    };
    const latestRequest = latestPromise.then(
      (latest) => ({ latest, status: "fulfilled" as const }),
      (error: unknown) => rejectPair(error, "Could not reload measurements"),
    );
    const pageRequest = pagePromise.then(
      (page) => ({ page, status: "fulfilled" as const }),
      (error: unknown) => rejectPair(error, "Could not load measurements"),
    );
    void Promise.all([
      latestRequest,
      pageRequest,
    ]).then(([latestResult, pageResult]) => {
      if (pairFailed || !isCurrentPair()) {
        return;
      }
      if (pageResult.status !== "fulfilled" || latestResult.status !== "fulfilled") {
        return;
      }
      const page = pageResult.page;
      if (!page) {
        return;
      }
      offsetRef.current = page.offset;
      setOffset(page.offset);
      setMeasurementPage(page);
      setMeasurementState((current) => ({
        ...current,
        latest: (
          !latestResult.latest
          || (current.latest && current.latest.entry_index > latestResult.latest.entry_index)
        )
          ? current.latest
          : latestResult.latest,
        rows: page.results,
      }));
      setApiError(null);
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
        setIsInitialMeasurementLoading(false);
        setMeasurementConnection("connecting");
        setMeasurementConnectionError(null);
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
        setIsInitialMeasurementLoading(false);
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
      setIsInitialMeasurementLoading(false);
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
    setMeasurementConnection("connecting");
    setMeasurementConnectionError(null);
    setApiError(null);
    setMeasurementState(EMPTY_STATE);
    setMeasurementPage(null);
    setIsPageLoading(false);
    setIsInitialMeasurementLoading(Boolean(selectedDeviceId));
  }

  useEffect(() => {
    if (!accessToken) {
      return;
    }

    const token = accessToken;
    const authGeneration = authenticationGeneration.current;
    let disposed = false;
    let closeSubscription: () => void = () => {};
    setDeviceUpdatesConnection("connecting");
    setDeviceUpdatesError(null);

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
            setDeviceUpdatesConnection("live");
            setDeviceUpdatesError(null);
            void refreshDevices(token, authGeneration);
          }
        },
        (error) => {
          if (!disposed) {
            setDeviceUpdatesConnection("error");
            setDeviceUpdatesError(error.message);
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
        setDeviceUpdatesConnection("live");
        setDeviceUpdatesError(null);
        void refreshDevices(token, authGeneration);
      }
    }).catch((error: unknown) => {
      if (!disposed) {
        setDeviceUpdatesConnection("error");
        setDeviceUpdatesError(error instanceof Error ? error.message : "Could not connect to device notifications");
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
    setMeasurementConnection("connecting");
    setMeasurementConnectionError(null);

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
                measurementNotificationGeneration.current += 1;
                setMeasurementState((current) => mergeNotification(current, notification));
                scheduleMeasurementRefresh();
              }
            }
          },
          () => {
            if (!isCurrent()) {
              return;
            }
            setMeasurementConnection("live");
            setMeasurementConnectionError(null);
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
              setMeasurementConnection("error");
              setMeasurementConnectionError(error.message);
            }
          },
        );
        if (!isCurrent()) {
          close();
          return;
        }
        closeSubscription = close;
        setMeasurementConnection("live");
        setMeasurementConnectionError(null);
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
        setIsInitialMeasurementLoading(false);
      } catch (error) {
        if (isCurrent()) {
          setMeasurementConnection("error");
          setMeasurementConnectionError(error instanceof Error ? error.message : "Could not connect to notifications");
          setIsInitialMeasurementLoading(false);
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

  if (!accessToken) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100">
        <main className="mx-auto grid min-h-screen w-full max-w-6xl items-center gap-12 px-5 py-12 lg:grid-cols-[1.15fr_0.85fr] lg:px-10">
          <section aria-labelledby="product-heading" className="max-w-2xl">
            <div className="mb-8 flex h-14 w-14 items-center justify-center rounded-2xl border border-cyan-300/20 bg-cyan-400/10 text-cyan-300 shadow-lg shadow-cyan-950/30">
              <svg aria-hidden="true" className="h-7 w-7" fill="none" viewBox="0 0 24 24">
                <path d="M4 17V7m5 10V4m5 13V9m5 8V6" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
              </svg>
            </div>
            <p className="mb-3 text-sm font-semibold uppercase tracking-[0.25em] text-cyan-300">IoT Operations</p>
            <h1 id="product-heading" className="max-w-xl text-4xl font-semibold tracking-tight text-white sm:text-5xl">
              Telemetry you can act on.
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-8 text-slate-400">
              Monitor connected devices, inspect authoritative measurement history, and provision new equipment from one focused workspace.
            </p>
            <dl className="mt-10 grid max-w-xl grid-cols-2 gap-4 text-sm sm:grid-cols-3">
              <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
                <dt className="text-slate-500">Signal</dt>
                <dd className="mt-1 font-semibold text-teal-300">Live events</dd>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
                <dt className="text-slate-500">History</dt>
                <dd className="mt-1 font-semibold text-slate-200">Authoritative</dd>
              </div>
              <div className="col-span-2 rounded-xl border border-slate-800 bg-slate-900/50 p-4 sm:col-span-1">
                <dt className="text-slate-500">Access</dt>
                <dd className="mt-1 font-semibold text-slate-200">Permission-aware</dd>
              </div>
            </dl>
          </section>

          {isStarting ? (
            <Panel aria-label="Session loading" className="p-8">
              <p aria-live="polite" className="text-sm text-slate-300" role="status">Restoring session…</p>
            </Panel>
          ) : (
            <Panel aria-labelledby="sign-in-heading" className="p-6 sm:p-8">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-300">Secure workspace</p>
              <h2 id="sign-in-heading" className="mt-2 text-2xl font-semibold text-white">Sign in</h2>
              <p className="mt-2 text-sm leading-6 text-slate-400">Use your operator credentials to access device telemetry.</p>
              <form aria-label="Sign in" className="mt-8 grid gap-5" onSubmit={submitLogin}>
                <Field>
                  Username
                  <input
                    autoComplete="username"
                    className="min-h-11 rounded-lg border border-slate-700 bg-slate-950/80 px-3.5 py-2.5 text-slate-100 placeholder:text-slate-600 hover:border-slate-600"
                    onChange={(event) => setUsername(event.target.value)}
                    required
                    value={username}
                  />
                </Field>
                <Field>
                  Password
                  <input
                    autoComplete="current-password"
                    className="min-h-11 rounded-lg border border-slate-700 bg-slate-950/80 px-3.5 py-2.5 text-slate-100 placeholder:text-slate-600 hover:border-slate-600"
                    onChange={(event) => setPassword(event.target.value)}
                    required
                    type="password"
                    value={password}
                  />
                </Field>
                <Button className="mt-2 w-full" type="submit">Sign in</Button>
              </form>
              {apiError && (
                <p className="mt-5 rounded-lg border border-red-400/25 bg-red-500/10 px-4 py-3 text-sm text-red-200" role="alert">
                  API error: {apiError}
                </p>
              )}
            </Panel>
          )}
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-20 border-b border-slate-800/90 bg-slate-950/85 backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-[96rem] flex-wrap items-center gap-4 px-4 py-3 sm:px-6 lg:px-8">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-cyan-300/20 bg-cyan-400/10 text-cyan-300">
              <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
                <path d="M4 17V7m5 10V4m5 13V9m5 8V6" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
              </svg>
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-white">IoT Operations</p>
              <p className="truncate text-xs text-slate-500">Telemetry control plane</p>
            </div>
          </div>
          <StatusBadge
            appearance={deviceUpdatesConnection === "error" ? "warning" : deviceUpdatesConnection === "live" ? "live" : "neutral"}
            aria-label="Connection status"
            aria-live="polite"
            role="status"
          >
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 rounded-full ${
                deviceUpdatesConnection === "error"
                  ? "bg-amber-300"
                  : deviceUpdatesConnection === "live" ? "bg-teal-300" : "bg-slate-400"
              }`}
            />
            {deviceUpdatesConnection === "error" ? "Connection issue" : deviceUpdatesConnection === "live" ? "Live" : "Connecting"}
          </StatusBadge>
          <span className="hidden text-sm text-slate-400 sm:inline">Authenticated session</span>
          <Button appearance="secondary" onClick={logout}>Sign out</Button>
        </div>
      </header>

      <div className="mx-auto w-full max-w-[96rem] px-4 py-6 sm:px-6 lg:px-8">
        {(apiError || connectionError) && (
          <div className="mb-5 grid gap-3">
            {apiError && (
              <p className="rounded-xl border border-red-400/25 bg-red-500/10 px-4 py-3 text-sm text-red-200" role="alert">
                API error: {apiError}
              </p>
            )}
            {connectionError && (
              <p className="rounded-xl border border-red-400/25 bg-red-500/10 px-4 py-3 text-sm text-red-200" role="alert">
                Connection error: {connectionError}
              </p>
            )}
          </div>
        )}

        <div className="grid min-w-0 gap-6 lg:grid-cols-[20rem_minmax(0,1fr)]">
          <aside className="min-w-0 self-start lg:sticky lg:top-24">
            <nav aria-label="Devices">
              <Panel className="overflow-hidden">
              <div className="border-b border-slate-800 px-5 py-4">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="font-semibold text-white">Devices</h2>
                  <StatusBadge>{devices.length}</StatusBadge>
                </div>
                <p className="mt-1 text-xs text-slate-500">Select a source to inspect telemetry.</p>
              </div>
              <div className="p-3">
                <Field className="mb-3 px-1 text-xs text-slate-400">
                  Selected device
                  <select
                    className="min-h-10 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 hover:border-slate-600"
                    onChange={(event) => selectDevice(event.target.value)}
                    value={deviceId}
                  >
                    <option value="">Choose a device</option>
                    {devices.map((device) => (
                      <option key={device.id} value={device.id}>{device.name} — {device.id}</option>
                    ))}
                  </select>
                </Field>
                <div className="grid gap-1.5">
                  {devices.length === 0 && (
                    <p className="rounded-lg border border-dashed border-slate-700 px-3 py-5 text-center text-sm text-slate-500">
                      No devices available.
                    </p>
                  )}
                  {devices.map((device) => {
                    const isSelected = device.id === deviceId;
                    return (
                      <button
                        aria-label={`Select ${device.name} device ${device.id}`}
                        aria-pressed={isSelected}
                        className={`min-w-0 rounded-xl border px-3.5 py-3 text-left transition-colors ${
                          isSelected
                            ? "border-cyan-400/35 bg-cyan-400/10 text-white"
                            : "border-transparent text-slate-300 hover:border-slate-700 hover:bg-slate-800/70"
                        }`}
                        key={device.id}
                        onClick={() => selectDevice(device.id)}
                        type="button"
                      >
                        <span className="block truncate text-sm font-semibold">{device.name}</span>
                        <span className={`mt-1 block break-all font-mono text-[0.68rem] leading-4 ${isSelected ? "text-cyan-200/70" : "text-slate-600"}`}>
                          {device.id}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
              </Panel>
            </nav>

            <div className="mt-4">
              <DeviceProvisioning
                accessToken={accessToken}
                canAddDevices={canAddDevices}
                onAuthenticationLost={logout}
                onCreated={refreshAfterCreation}
                onPermissionDenied={handlePermissionDenied}
              />
            </div>
          </aside>

          <main className="min-w-0">
            {!selectedDevice ? (
              <Panel className="flex min-h-72 items-center justify-center p-8 text-center">
                <div className="max-w-md">
                  <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-slate-700 bg-slate-800 text-slate-400">
                    <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
                      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
                    </svg>
                  </span>
                  <h1 className="mt-5 text-xl font-semibold text-white">Choose a device</h1>
                  <p className="mt-2 text-sm leading-6 text-slate-400">
                    Select a device from the navigation to view its latest reading and authoritative history.
                  </p>
                </div>
              </Panel>
            ) : (
              <div className="grid min-w-0 gap-6">
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-300">Device workspace</p>
                  <h1 className="mt-2 truncate text-3xl font-semibold tracking-tight text-white">{selectedDevice.name}</h1>
                  <p className="mt-2 break-all font-mono text-xs text-slate-500">{selectedDevice.id}</p>
                </div>

                <div className="grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  <Panel aria-live="polite" className="overflow-hidden border-cyan-400/20 p-5 sm:col-span-2 xl:col-span-1">
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Latest reading</p>
                    <h2 className="mt-3 text-sm font-medium text-slate-300">
                      Latest measurement{latest ? `: ${latest.measurement_name} ${latest.value}` : ""}
                    </h2>
                    {isInitialMeasurementLoading ? (
                      <p className="mt-3 text-sm text-slate-500">Waiting for latest reading…</p>
                    ) : latest ? (
                      <>
                        <p className="mt-2 truncate text-3xl font-semibold tabular-nums text-cyan-300">{latest.value}</p>
                        <p className="mt-2 truncate text-xs text-slate-500">{latest.measurement_name} · {latest.measured_at}</p>
                      </>
                    ) : (
                      <p className="mt-3 text-sm text-slate-500">No latest reading yet.</p>
                    )}
                  </Panel>
                  <Panel className="p-5">
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Device identity</p>
                    <p className="mt-3 break-all font-mono text-xs leading-5 text-slate-300">
                      <strong className="font-sans text-slate-400">Device ID:</strong> {selectedDevice.id}
                    </p>
                  </Panel>
                  <Panel className="p-5">
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Connection</p>
                    <StatusBadge
                      appearance={measurementConnection === "error" ? "warning" : measurementConnection === "live" ? "live" : "neutral"}
                      aria-label="Device connection status"
                      className="mt-3"
                    >
                      {measurementConnection === "error" ? "Attention needed" : measurementConnection === "live" ? "Streaming" : "Connecting"}
                    </StatusBadge>
                  </Panel>
                  <Panel className="p-5">
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">History total</p>
                    <p className="mt-3 text-2xl font-semibold tabular-nums text-white">
                      {isInitialMeasurementLoading ? "Loading total…" : `${measurementPage?.total ?? 0} measurements`}
                    </p>
                  </Panel>
                </div>

                <Panel aria-label="Measurement history" className="min-w-0 overflow-hidden">
                  <div className="flex flex-col gap-4 border-b border-slate-800 px-5 py-5 sm:flex-row sm:items-end sm:justify-between">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Authoritative log</p>
                      <h2 className="mt-1 text-lg font-semibold text-white">Measurement history</h2>
                      <p aria-label="Measurement history status" aria-live="polite" className="mt-1 text-xs text-slate-500" role="status">
                        {isInitialMeasurementLoading && measurementConnection === "connecting"
                          ? "Connecting to telemetry…"
                          : isPageLoading ? "Refreshing history…" : "History up to date"}
                      </p>
                    </div>
                    <Field className="w-full sm:w-44">
                      Measurement order
                      <select
                        className="min-h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 hover:border-slate-600"
                        onChange={(event) => changeMeasurementOrder(event.target.value as MeasurementOrder)}
                        value={order}
                      >
                        <option value="desc">Newest first</option>
                        <option value="asc">Oldest first</option>
                      </select>
                    </Field>
                  </div>

                  <div className="max-w-full overflow-x-auto">
                    <table className="w-full min-w-[48rem] border-collapse text-left text-sm">
                      <thead className="bg-slate-950/60 text-xs uppercase tracking-wide text-slate-500">
                        <tr>
                          <th className="px-5 py-3 font-semibold" scope="col">Index</th>
                          <th className="px-5 py-3 font-semibold" scope="col">Name</th>
                          <th className="px-5 py-3 font-semibold" scope="col">Value</th>
                          <th className="px-5 py-3 font-semibold" scope="col">Measured time</th>
                          <th className="px-5 py-3 font-semibold" scope="col">Received time</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/80">
                        {isInitialMeasurementLoading ? (
                          <tr>
                            <td className="px-5 py-12 text-center text-slate-500" colSpan={5}>
                              Loading measurements…
                            </td>
                          </tr>
                        ) : rows.length === 0 ? (
                          <tr>
                            <td className="px-5 py-12 text-center text-slate-500" colSpan={5}>
                              No measurements available for this device.
                            </td>
                          </tr>
                        ) : rows.map((row) => (
                          <tr className="odd:bg-slate-900/30 hover:bg-slate-800/60" key={row.entry_index}>
                            <td className="px-5 py-3.5 font-mono text-xs tabular-nums text-slate-400">{row.entry_index}</td>
                            <td className="px-5 py-3.5 font-medium text-slate-200">{row.measurement_name}</td>
                            <td className="px-5 py-3.5 font-semibold tabular-nums text-cyan-200">{row.value}</td>
                            <td className="whitespace-nowrap px-5 py-3.5 tabular-nums text-slate-400">{formatTime(row.measured_at)}</td>
                            <td className="whitespace-nowrap px-5 py-3.5 tabular-nums text-slate-400">{formatTime(row.received_at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 px-5 py-4">
                    <Button
                      appearance="secondary"
                      disabled={isPageLoading || !hasPrevious}
                      onClick={() => measurementPage && loadAdjacentPage(Math.max(0, measurementPage.offset - measurementPage.limit))}
                    >
                      Previous
                    </Button>
                    <span className="text-sm tabular-nums text-slate-400">Page {currentPage} of {totalPages}</span>
                    <Button
                      appearance="secondary"
                      disabled={isPageLoading || !hasNext}
                      onClick={() => measurementPage && loadAdjacentPage(measurementPage.offset + measurementPage.limit)}
                    >
                      Next
                    </Button>
                  </div>
                </Panel>
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
