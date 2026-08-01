import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App, { PAGE_SIZE } from "./App";
import type { CreatedDevice, MeasurementOrder, MeasurementPage } from "./api";
import type { DeviceProvisioningProps } from "./DeviceProvisioning";
import type { Measurement } from "./measurementState";

const api = vi.hoisted(() => ({
  ApiError: class ApiError extends Error {
    readonly status: number;

    constructor(status: number) {
      super(`Request failed with status ${status}`);
      this.status = status;
    }
  },
  login: vi.fn(),
  getCurrentUser: vi.fn(),
  getNatsToken: vi.fn(),
  listDevices: vi.fn(),
  getLatest: vi.fn(),
  getMeasurements: vi.fn(),
}));

const provisioning = vi.hoisted(() => ({
  props: undefined as DeviceProvisioningProps | undefined,
}));

const nats = vi.hoisted(() => ({
  subscribeToDeviceCreations: vi.fn(),
  subscribeToMeasurements: vi.fn(),
}));

const session = vi.hoisted(() => ({
  clearAccessToken: vi.fn(),
  restoreAccessToken: vi.fn(),
  storeAccessToken: vi.fn(),
}));

vi.mock("./api", () => api);
vi.mock("./DeviceProvisioning", async () => {
  const { useState } = await import("react");
  return {
    default: (props: DeviceProvisioningProps) => {
      const [credentialsVisible, setCredentialsVisible] = useState(false);
      provisioning.props = props;
      if (!props.canAddDevices) {
        return null;
      }
      return (
        <section aria-label="Device provisioning mock">
          <button type="button" onClick={() => setCredentialsVisible(true)}>Show credentials</button>
          {credentialsVisible && <p>Credential panel state</p>}
        </section>
      );
    },
  };
});
vi.mock("./nats", () => nats);
vi.mock("./session", () => session);

const DEVICE_ONE = {
  id: "a1111111-1111-4111-8111-111111111111",
  name: "Boiler",
  enabled: true,
  created_at: "2026-07-26T12:00:00Z",
  updated_at: "2026-07-26T12:00:00Z",
};
const DEVICE_TWO = { ...DEVICE_ONE, id: "b2222222-2222-4222-8222-222222222222", name: "Pump" };
const DEVICE_THREE = { ...DEVICE_ONE, id: "c3333333-3333-4333-8333-333333333333", name: "Chiller" };
const CREATED_DEVICE: CreatedDevice = { ...DEVICE_THREE, key: "one-time-key" };

function measurement(entry_index: number, device_id = DEVICE_ONE.id): Measurement {
  return {
    device_id,
    entry_index,
    measurement_name: "temperature",
    value: entry_index,
    measured_at: "2026-07-26T12:00:00Z",
    received_at: "2026-07-26T12:00:01Z",
  };
}

function measurementPage(
  results: Measurement[],
  metadata: Partial<Omit<MeasurementPage, "results">> = {},
): MeasurementPage {
  return {
    results,
    total: metadata.total ?? results.length,
    limit: metadata.limit ?? PAGE_SIZE,
    offset: metadata.offset ?? 0,
    order: metadata.order ?? ("desc" satisfies MeasurementOrder),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function currentProvisioningProps(): DeviceProvisioningProps {
  expect(provisioning.props).toBeDefined();
  return provisioning.props!;
}

function submitLoginForm(username = "reader", password = "password") {
  fireEvent.change(screen.getByLabelText(/username/i), { target: { value: username } });
  fireEvent.change(screen.getByLabelText(/password/i), { target: { value: password } });
  fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
}

async function logIn() {
  submitLoginForm();
  await screen.findByRole("option", { name: /Boiler/ });
}

async function logInAndSelect(deviceId = DEVICE_ONE.id) {
  await logIn();
  fireEvent.change(screen.getByLabelText(/selected device/i), { target: { value: deviceId } });
}

describe("App", () => {
  let notification: (value: Measurement) => void;
  let reconnect: () => void;
  let measurementConnectionFailure: (error: Error) => void;
  let deviceCreated: () => void;
  let deviceConnectionFailure: (error: Error) => void;
  let deviceReconnect: () => void;
  let close: ReturnType<typeof vi.fn>;
  let closeDeviceCreations: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    provisioning.props = undefined;
    close = vi.fn();
    closeDeviceCreations = vi.fn();
    session.restoreAccessToken.mockReturnValue(null);
    api.login.mockResolvedValue("access-token");
    api.getCurrentUser.mockResolvedValue({ can_add_devices: true });
    api.getNatsToken.mockResolvedValue("nats-token");
    api.listDevices.mockResolvedValue([DEVICE_ONE, DEVICE_TWO]);
    api.getLatest.mockResolvedValue(measurement(2));
    api.getMeasurements.mockResolvedValue(measurementPage([measurement(1), measurement(2)]));
    nats.subscribeToMeasurements.mockImplementation(
      async (_deviceId, _token, onNotification, onReconnect, onError) => {
        notification = onNotification;
        reconnect = onReconnect;
        measurementConnectionFailure = onError;
        return close;
      },
    );
    nats.subscribeToDeviceCreations.mockImplementation(
      async (_token, onDeviceCreated, onReconnect, onError) => {
        deviceCreated = onDeviceCreated;
        deviceConnectionFailure = onError;
        deviceReconnect = onReconnect;
        return closeDeviceCreations;
      },
    );
  });

  it("presents a named sign-in region without dashboard navigation", async () => {
    render(<App />);

    const signIn = await screen.findByRole("region", { name: "Sign in" });
    expect(within(signIn).getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(within(signIn).getByLabelText("Username")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Devices" })).not.toBeInTheDocument();
  });

  it("presents the authenticated operational shell and signs out from its banner", async () => {
    render(<App />);
    await logInAndSelect();

    const banner = screen.getByRole("banner");
    expect(within(banner).getByText("IoT Operations")).toBeInTheDocument();
    expect(within(banner).getByRole("status", { name: "Connection status" })).toHaveTextContent("Live");
    expect(within(banner).getByText("Authenticated session")).toBeInTheDocument();

    const navigation = screen.getByRole("navigation", { name: "Devices" });
    expect(within(navigation).getByRole("button", {
      name: `Select Boiler device ${DEVICE_ONE.id}`,
    })).toHaveAttribute("aria-pressed", "true");

    const workspace = screen.getByRole("main");
    expect(within(workspace).getByRole("heading", { name: "Boiler" })).toBeInTheDocument();
    const deviceIdLabel = within(workspace).getByText("Device ID:", { selector: "strong" });
    expect(deviceIdLabel.parentElement).toHaveTextContent(DEVICE_ONE.id);
    expect(await within(workspace).findByText("2 measurements")).toBeInTheDocument();

    fireEvent.click(within(banner).getByRole("button", { name: "Sign out" }));

    expect(await screen.findByRole("region", { name: "Sign in" })).toBeInTheDocument();
    expect(session.clearAccessToken).toHaveBeenCalledOnce();
    expect(screen.queryByRole("navigation", { name: "Devices" })).not.toBeInTheDocument();
  });

  it("reports device updates as connecting until ready and clears an error on reconnect", async () => {
    const subscriptionReady = deferred<() => void>();
    nats.subscribeToDeviceCreations.mockImplementation(
      async (_token, onDeviceCreated, onReconnect, onError) => {
        deviceCreated = onDeviceCreated;
        deviceConnectionFailure = onError;
        deviceReconnect = onReconnect;
        return subscriptionReady.promise;
      },
    );
    render(<App />);
    await logIn();

    const connection = screen.getByRole("status", { name: "Connection status" });
    expect(connection).toHaveTextContent("Connecting");

    await act(async () => {
      subscriptionReady.resolve(closeDeviceCreations);
      await subscriptionReady.promise;
    });
    expect(connection).toHaveTextContent("Live");

    act(() => deviceConnectionFailure(new Error("Device updates disconnected")));
    expect(connection).toHaveTextContent("Connection issue");
    expect(screen.getByRole("alert")).toHaveTextContent("Device updates disconnected");

    act(() => deviceReconnect());

    await waitFor(() => expect(connection).toHaveTextContent("Live"));
    expect(screen.queryByText(/Device updates disconnected/i)).not.toBeInTheDocument();
  });

  it("keeps the selected workspace in its initial loading state while notification setup is pending", async () => {
    const measurementToken = deferred<string>();
    render(<App />);
    await logIn();
    await waitFor(() => expect(nats.subscribeToDeviceCreations).toHaveBeenCalledOnce());
    api.getNatsToken.mockReturnValueOnce(measurementToken.promise);

    fireEvent.change(screen.getByLabelText("Selected device"), { target: { value: DEVICE_ONE.id } });

    expect(screen.getByLabelText("Device connection status")).toHaveTextContent("Connecting");
    expect(screen.getByRole("status", { name: "Measurement history status" })).toHaveTextContent(
      "Connecting to telemetry",
    );
    expect(screen.queryByText("No measurements available for this device.")).not.toBeInTheDocument();
    expect(screen.queryByText("No latest reading yet.")).not.toBeInTheDocument();

    await act(async () => {
      measurementToken.resolve("measurement-nats-token");
      await measurementToken.promise;
    });

    await waitFor(() => expect(screen.getByLabelText("Device connection status")).toHaveTextContent("Streaming"));
    expect(screen.getByRole("status", { name: "Measurement history status" })).toHaveTextContent(
      "History up to date",
    );
  });

  it("does not mark a manual page current while measurement transport is connecting", async () => {
    const measurementToken = deferred<string>();
    render(<App />);
    await logIn();
    await waitFor(() => expect(nats.subscribeToDeviceCreations).toHaveBeenCalledOnce());
    api.getNatsToken.mockReturnValueOnce(measurementToken.promise);

    fireEvent.change(screen.getByLabelText("Selected device"), { target: { value: DEVICE_ONE.id } });
    expect(screen.getByLabelText("Device connection status")).toHaveTextContent("Connecting");
    api.getMeasurements.mockResolvedValueOnce(measurementPage(
      [measurement(3), measurement(2), measurement(1)],
      { total: 3, order: "asc" },
    ));

    fireEvent.change(screen.getByLabelText("Measurement order"), { target: { value: "asc" } });

    await waitFor(() => expect(api.getMeasurements).toHaveBeenCalledWith(
      DEVICE_ONE.id,
      "access-token",
      `limit=${PAGE_SIZE}&offset=0&order=asc`,
    ));
    expect(screen.getByText("3 measurements")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(4);
    expect(screen.getAllByRole("row")[1]).toHaveTextContent("3");
    expect(screen.getByRole("status", { name: "Measurement history status" })).toHaveTextContent(
      "History may be out of date",
    );
    expect(screen.queryByText("History up to date")).not.toBeInTheDocument();
  });

  it("keeps measurement history controls in a named region", async () => {
    render(<App />);
    await logInAndSelect();

    const history = await screen.findByRole("region", { name: "Measurement history" });
    expect(within(history).getByLabelText("Measurement order")).toHaveValue("desc");
    expect(within(history).getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(within(history).getByRole("button", { name: "Next" })).toBeDisabled();
    expect(within(history).getByText("Page 1 of 1")).toBeInTheDocument();
  });

  it("announces history loading and renders explicit empty states", async () => {
    const pendingPage = deferred<MeasurementPage>();
    api.getLatest.mockResolvedValue(null);
    api.getMeasurements.mockReturnValueOnce(pendingPage.promise);
    render(<App />);
    await logInAndSelect();

    expect(await screen.findByRole("status", { name: "Measurement history status" })).toHaveTextContent(
      "Refreshing history",
    );

    await act(async () => {
      pendingPage.resolve(measurementPage([], { total: 0 }));
      await pendingPage.promise;
    });

    expect(await screen.findByText("No measurements available for this device.")).toBeInTheDocument();
    expect(screen.getByText("No latest reading yet.")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Measurement history status" })).toHaveTextContent(
      "History up to date",
    );
  });

  it("reports an initial page failure without presenting an empty current history", async () => {
    api.getMeasurements.mockRejectedValueOnce(new Error("Initial history unavailable"));
    render(<App />);
    await logInAndSelect();

    expect(await screen.findByRole("alert")).toHaveTextContent("API error: Initial history unavailable");
    expect(screen.getByRole("status", { name: "Measurement history status" })).toHaveTextContent(
      "History unavailable",
    );
    expect(screen.getByText("Measurement history unavailable.")).toBeInTheDocument();
    expect(screen.getByText("Total unavailable")).toBeInTheDocument();
    expect(screen.queryByText("No measurements available for this device.")).not.toBeInTheDocument();
    expect(screen.queryByText("0 measurements")).not.toBeInTheDocument();
  });

  it("keeps notification transport live when the initial latest API read fails", async () => {
    const failedLatest = deferred<Measurement | null>();
    api.getLatest.mockReturnValueOnce(failedLatest.promise);
    render(<App />);
    await logInAndSelect();

    await waitFor(() => expect(nats.subscribeToMeasurements).toHaveBeenCalledOnce());
    expect(screen.getByLabelText("Device connection status")).toHaveTextContent("Streaming");

    await act(async () => {
      failedLatest.reject(new Error("Latest API unavailable"));
      await failedLatest.promise.catch(() => undefined);
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("API error: Latest API unavailable");
    expect(screen.getByLabelText("Device connection status")).toHaveTextContent("Streaming");
    expect(screen.queryByText(/Connection error: Latest API unavailable/i)).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Measurement history status" })).toHaveTextContent(
      "History up to date",
    );
    expect(screen.getAllByRole("row")).toHaveLength(3);
  });

  it("keeps history stale after a measurement transport failure until reconnect refresh succeeds", async () => {
    const firstPageRows = Array.from({ length: PAGE_SIZE }, (_, index) => measurement(120 - index));
    const secondPageRows = Array.from({ length: PAGE_SIZE }, (_, index) => measurement(70 - index));
    api.getLatest.mockResolvedValue(measurement(120));
    api.getMeasurements.mockResolvedValueOnce(measurementPage(firstPageRows, { total: 120 }));
    render(<App />);
    await logInAndSelect();
    await screen.findByText("Page 1 of 3");

    act(() => measurementConnectionFailure(new Error("Measurement transport lost")));

    expect(screen.getByLabelText("Device connection status")).toHaveTextContent("Attention needed");
    expect(screen.getByRole("alert")).toHaveTextContent("Connection error: Measurement transport lost");
    expect(screen.getByRole("status", { name: "Measurement history status" })).toHaveTextContent(
      "History may be out of date",
    );
    expect(screen.getByText("120 measurements")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(PAGE_SIZE + 1);

    api.getMeasurements.mockResolvedValueOnce(measurementPage(
      secondPageRows,
      { total: 120, offset: PAGE_SIZE },
    ));
    fireEvent.click(screen.getByRole("button", { name: /^next$/i }));

    await screen.findByText("Page 2 of 3");
    expect(screen.getAllByRole("row")[1]).toHaveTextContent("70");
    expect(screen.getByRole("status", { name: "Measurement history status" })).toHaveTextContent(
      "History may be out of date",
    );

    const reconnectPage = deferred<MeasurementPage>();
    api.getLatest.mockClear();
    api.getMeasurements.mockClear();
    api.getLatest.mockResolvedValueOnce(measurement(121));
    api.getMeasurements.mockReturnValueOnce(reconnectPage.promise);

    act(() => reconnect());

    expect(screen.getByLabelText("Device connection status")).toHaveTextContent("Streaming");
    expect(screen.queryByText(/Measurement transport lost/i)).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Measurement history status" })).toHaveTextContent(
      "Refreshing history",
    );
    expect(api.getMeasurements).toHaveBeenCalledWith(
      DEVICE_ONE.id,
      "access-token",
      `limit=${PAGE_SIZE}&offset=${PAGE_SIZE}&order=desc`,
    );

    await act(async () => {
      reconnectPage.resolve(measurementPage(secondPageRows, { total: 120, offset: PAGE_SIZE }));
      await reconnectPage.promise;
    });

    expect(screen.getByRole("status", { name: "Measurement history status" })).toHaveTextContent(
      "History up to date",
    );
  });

  it("does not let a stale reconnect latest result overwrite a newer notification", async () => {
    const staleReconnectLatest = deferred<Measurement | null>();
    render(<App />);
    await logInAndSelect();
    await waitFor(() => expect(screen.getByRole("heading", { name: /latest measurement/i })).toHaveTextContent("temperature 2"));
    act(() => measurementConnectionFailure(new Error("Measurement transport lost")));
    api.getLatest.mockClear();
    api.getMeasurements.mockClear();
    api.getLatest.mockReturnValueOnce(staleReconnectLatest.promise);
    api.getMeasurements.mockResolvedValueOnce(measurementPage([measurement(2), measurement(1)], { total: 2 }));

    act(() => reconnect());
    await waitFor(() => expect(api.getLatest).toHaveBeenCalledOnce());
    act(() => notification(measurement(3)));

    expect(screen.getByRole("heading", { name: /latest measurement/i })).toHaveTextContent("temperature 3");
    await act(async () => {
      staleReconnectLatest.resolve(measurement(2));
      await staleReconnectLatest.promise;
    });

    expect(screen.getByRole("heading", { name: /latest measurement/i })).toHaveTextContent("temperature 3");
  });

  it("ignores a stale reconnect latest failure after changing order", async () => {
    const staleReconnectLatest = deferred<Measurement | null>();
    const staleReconnectPage = deferred<MeasurementPage>();
    render(<App />);
    await logInAndSelect();
    await waitFor(() => expect(screen.getByRole("heading", { name: /latest measurement/i })).toHaveTextContent("temperature 2"));
    act(() => measurementConnectionFailure(new Error("Measurement transport lost")));
    api.getLatest.mockClear();
    api.getMeasurements.mockClear();
    api.getLatest.mockReturnValueOnce(staleReconnectLatest.promise);
    api.getMeasurements.mockImplementation((_deviceId, _token, query) => (
      query.endsWith("order=desc")
        ? staleReconnectPage.promise
        : Promise.resolve(measurementPage([measurement(900)], { total: 1, order: "asc" }))
    ));

    act(() => reconnect());
    await waitFor(() => expect(api.getMeasurements).toHaveBeenCalledWith(
      DEVICE_ONE.id,
      "access-token",
      `limit=${PAGE_SIZE}&offset=0&order=desc`,
    ));
    fireEvent.change(screen.getByLabelText(/measurement order/i), { target: { value: "asc" } });
    await screen.findByText("Page 1 of 1");

    await act(async () => {
      staleReconnectLatest.reject(new Error("stale reconnect latest failed"));
      await staleReconnectLatest.promise.catch(() => undefined);
      staleReconnectPage.resolve(measurementPage([measurement(2), measurement(1)], { total: 2 }));
      await staleReconnectPage.promise;
    });

    expect(screen.queryByText(/stale reconnect latest failed/i)).not.toBeInTheDocument();
  });

  it("does not let an older initial latest result regress a successful reconnect refresh", async () => {
    const initialLatest = deferred<Measurement | null>();
    const initialPage = deferred<MeasurementPage>();
    api.getLatest
      .mockReturnValueOnce(initialLatest.promise)
      .mockResolvedValueOnce(measurement(10));
    api.getMeasurements
      .mockReturnValueOnce(initialPage.promise)
      .mockResolvedValueOnce(measurementPage([measurement(10)], { total: 10 }));
    render(<App />);
    await logInAndSelect();
    await waitFor(() => expect(nats.subscribeToMeasurements).toHaveBeenCalledOnce());
    await waitFor(() => {
      expect(api.getLatest).toHaveBeenCalledOnce();
      expect(api.getMeasurements).toHaveBeenCalledOnce();
    });

    act(() => reconnect());
    await screen.findByText("10 measurements");
    expect(screen.getByRole("heading", { name: /latest measurement/i })).toHaveTextContent("temperature 10");

    await act(async () => {
      initialLatest.resolve(measurement(2));
      initialPage.resolve(measurementPage([measurement(2), measurement(1)], { total: 2 }));
      await Promise.all([initialLatest.promise, initialPage.promise]);
    });

    expect(screen.getByRole("heading", { name: /latest measurement/i })).toHaveTextContent("temperature 10");
    expect(screen.getByText("10 measurements")).toBeInTheDocument();
  });

  it("does not surface an older initial latest failure after a successful reconnect refresh", async () => {
    const initialLatest = deferred<Measurement | null>();
    const initialPage = deferred<MeasurementPage>();
    api.getLatest
      .mockReturnValueOnce(initialLatest.promise)
      .mockResolvedValueOnce(measurement(10));
    api.getMeasurements
      .mockReturnValueOnce(initialPage.promise)
      .mockResolvedValueOnce(measurementPage([measurement(10)], { total: 10 }));
    render(<App />);
    await logInAndSelect();
    await waitFor(() => expect(nats.subscribeToMeasurements).toHaveBeenCalledOnce());
    await waitFor(() => {
      expect(api.getLatest).toHaveBeenCalledOnce();
      expect(api.getMeasurements).toHaveBeenCalledOnce();
    });

    act(() => reconnect());
    await screen.findByText("10 measurements");

    await act(async () => {
      initialLatest.reject(new Error("stale initial latest failed"));
      initialPage.resolve(measurementPage([measurement(2), measurement(1)], { total: 2 }));
      await Promise.allSettled([initialLatest.promise, initialPage.promise]);
    });

    expect(screen.queryByText(/stale initial latest failed/i)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /latest measurement/i })).toHaveTextContent("temperature 10");
  });

  it("restores a valid session only after devices and capability both load", async () => {
    const listedDevices = deferred<typeof DEVICE_ONE[]>();
    const currentUser = deferred<{ can_add_devices: boolean }>();
    session.restoreAccessToken.mockReturnValue("restored-token");
    api.listDevices.mockReturnValue(listedDevices.promise);
    api.getCurrentUser.mockReturnValue(currentUser.promise);

    render(<App />);

    expect(screen.queryByRole("button", { name: /sign in/i })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(api.listDevices).toHaveBeenCalledWith("restored-token");
      expect(api.getCurrentUser).toHaveBeenCalledWith("restored-token");
    });
    await act(async () => {
      listedDevices.resolve([DEVICE_ONE]);
      await listedDevices.promise;
    });
    expect(screen.queryByLabelText(/selected device/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/device provisioning mock/i)).not.toBeInTheDocument();

    await act(async () => {
      currentUser.resolve({ can_add_devices: true });
      await currentUser.promise;
    });

    expect(await screen.findByRole("option", { name: /Boiler/ })).toBeInTheDocument();
    expect(screen.getByLabelText(/device provisioning mock/i)).toBeInTheDocument();
    expect(api.listDevices).toHaveBeenCalledWith("restored-token");
  });

  it("persists an interactive-login token only after devices and capability both load", async () => {
    const listedDevices = deferred<typeof DEVICE_ONE[]>();
    const currentUser = deferred<{ can_add_devices: boolean }>();
    api.listDevices.mockReturnValue(listedDevices.promise);
    api.getCurrentUser.mockReturnValue(currentUser.promise);
    render(<App />);

    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "reader" } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "password" } });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() => {
      expect(api.listDevices).toHaveBeenCalledWith("access-token");
      expect(api.getCurrentUser).toHaveBeenCalledWith("access-token");
    });
    await act(async () => {
      listedDevices.resolve([DEVICE_ONE]);
      await listedDevices.promise;
    });
    expect(session.storeAccessToken).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(/selected device/i)).not.toBeInTheDocument();

    await act(async () => {
      currentUser.resolve({ can_add_devices: true });
      await currentUser.promise;
    });

    expect(await screen.findByRole("option", { name: /Boiler/ })).toBeInTheDocument();
    expect(session.storeAccessToken).toHaveBeenCalledWith("access-token");
    expect(provisioning.props).toMatchObject({ accessToken: "access-token", canAddDevices: true });
  });

  it.each(["devices", "capability"] as const)("clears a restored session when %s returns 401", async (request) => {
    session.restoreAccessToken.mockReturnValue("rejected-token");
    if (request === "devices") {
      api.listDevices.mockRejectedValue(new api.ApiError(401));
    } else {
      api.getCurrentUser.mockRejectedValue(new api.ApiError(401));
    }

    render(<App />);

    expect(await screen.findByRole("button", { name: /sign in/i })).toBeInTheDocument();
    expect(session.clearAccessToken).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText(/selected device/i)).not.toBeInTheDocument();
  });

  it("prioritizes a late restored-session 401 over an earlier transient prerequisite failure", async () => {
    const currentUser = deferred<{ can_add_devices: boolean }>();
    session.restoreAccessToken.mockReturnValue("restored-token");
    api.listDevices.mockRejectedValue(new Error("Device service temporarily unavailable"));
    api.getCurrentUser.mockReturnValue(currentUser.promise);
    render(<App />);

    await waitFor(() => {
      expect(api.listDevices).toHaveBeenCalledWith("restored-token");
      expect(api.getCurrentUser).toHaveBeenCalledWith("restored-token");
    });
    await act(async () => Promise.resolve());
    expect(screen.queryByRole("button", { name: /sign in/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(session.clearAccessToken).not.toHaveBeenCalled();

    await act(async () => {
      currentUser.reject(new api.ApiError(401));
      await currentUser.promise.catch(() => undefined);
    });

    expect(await screen.findByRole("button", { name: /sign in/i })).toBeInTheDocument();
    expect(session.clearAccessToken).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(["devices", "capability"] as const)("clears an interactive session when %s returns 401", async (request) => {
    if (request === "devices") {
      api.listDevices.mockRejectedValue(new api.ApiError(401));
    } else {
      api.getCurrentUser.mockRejectedValue(new api.ApiError(401));
    }
    render(<App />);

    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "reader" } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "password" } });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(session.clearAccessToken).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
    expect(session.storeAccessToken).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(/selected device/i)).not.toBeInTheDocument();
  });

  it("prioritizes a late post-login 401 over an earlier transient prerequisite failure", async () => {
    const currentUser = deferred<{ can_add_devices: boolean }>();
    api.listDevices.mockRejectedValue(new Error("Device service temporarily unavailable"));
    api.getCurrentUser.mockReturnValue(currentUser.promise);
    render(<App />);

    submitLoginForm();
    await waitFor(() => {
      expect(api.listDevices).toHaveBeenCalledWith("access-token");
      expect(api.getCurrentUser).toHaveBeenCalledWith("access-token");
    });
    await act(async () => Promise.resolve());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(session.clearAccessToken).not.toHaveBeenCalled();
    expect(session.storeAccessToken).not.toHaveBeenCalled();

    await act(async () => {
      currentUser.reject(new api.ApiError(401));
      await currentUser.promise.catch(() => undefined);
    });

    await waitFor(() => expect(session.clearAccessToken).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(session.storeAccessToken).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(/selected device/i)).not.toBeInTheDocument();
  });

  it("reports invalid credentials without invoking the authenticated logout reset", async () => {
    api.login.mockRejectedValue(new api.ApiError(401));
    render(<App />);

    submitLoginForm("unknown", "wrong-password");

    expect(await screen.findByRole("alert")).toHaveTextContent("API error: Request failed with status 401");
    expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
    expect(session.clearAccessToken).not.toHaveBeenCalled();
    expect(api.listDevices).not.toHaveBeenCalled();
    expect(api.getCurrentUser).not.toHaveBeenCalled();
  });

  it("ignores an older attempt's late prerequisite 401 after a newer login succeeds", async () => {
    const olderCapability = deferred<{ can_add_devices: boolean }>();
    api.login.mockResolvedValueOnce("older-token").mockResolvedValueOnce("newer-token");
    api.getCurrentUser.mockReturnValueOnce(olderCapability.promise);
    render(<App />);

    submitLoginForm("older-user");
    await waitFor(() => expect(api.getCurrentUser).toHaveBeenCalledWith("older-token"));
    submitLoginForm("newer-user");
    expect(await screen.findByRole("option", { name: /Boiler/ })).toBeInTheDocument();
    expect(provisioning.props).toMatchObject({ accessToken: "newer-token" });

    await act(async () => {
      olderCapability.reject(new api.ApiError(401));
      await olderCapability.promise.catch(() => undefined);
    });

    expect(screen.getByLabelText(/selected device/i)).toBeInTheDocument();
    expect(provisioning.props).toMatchObject({ accessToken: "newer-token" });
    expect(session.storeAccessToken).toHaveBeenLastCalledWith("newer-token");
    expect(session.clearAccessToken).not.toHaveBeenCalled();
  });

  it("does not commit an interactive-login token when capability loading fails transiently", async () => {
    api.getCurrentUser.mockRejectedValue(new Error("Capability service unavailable"));
    render(<App />);

    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "reader" } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "password" } });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("API error: Capability service unavailable");
    expect(session.storeAccessToken).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(/selected device/i)).not.toBeInTheDocument();
  });

  it("does not list devices when stored access-token restoration returns null", async () => {
    session.restoreAccessToken.mockReturnValue(null);

    render(<App />);

    expect(await screen.findByRole("button", { name: /sign in/i })).toBeInTheDocument();
    expect(api.listDevices).not.toHaveBeenCalled();
    expect(api.getCurrentUser).not.toHaveBeenCalled();
  });

  it("passes the authenticated token and capability to device provisioning", async () => {
    render(<App />);

    await logIn();

    expect(provisioning.props).toMatchObject({
      accessToken: "access-token",
      canAddDevices: true,
      onAuthenticationLost: expect.any(Function),
      onCreated: expect.any(Function),
      onPermissionDenied: expect.any(Function),
    });
    expect(screen.getByLabelText(/device provisioning mock/i)).toBeInTheDocument();
  });

  it("refreshes after provisioning without appending or changing the current selection", async () => {
    const refreshedDevices = deferred<typeof DEVICE_ONE[]>();
    render(<App />);
    await logInAndSelect();
    await waitFor(() => expect(api.listDevices).toHaveBeenCalledTimes(2));
    api.listDevices.mockClear();
    api.listDevices.mockReturnValue(refreshedDevices.promise);
    const props = currentProvisioningProps();

    act(() => props.onCreated(CREATED_DEVICE));

    expect(api.listDevices).toHaveBeenCalledOnce();
    expect(api.listDevices).toHaveBeenCalledWith("access-token");
    expect(screen.queryByRole("option", { name: /Chiller/ })).not.toBeInTheDocument();
    await act(async () => {
      refreshedDevices.resolve([DEVICE_ONE, DEVICE_TWO]);
      await refreshedDevices.promise;
    });
    expect(screen.queryByRole("option", { name: /Chiller/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/selected device/i)).toHaveValue(DEVICE_ONE.id);
  });

  it("keeps provisioning credential state mounted when the post-create refresh fails", async () => {
    render(<App />);
    await logIn();
    await waitFor(() => expect(api.listDevices).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: /show credentials/i }));
    expect(screen.getByText("Credential panel state")).toBeInTheDocument();
    api.listDevices.mockClear();
    api.listDevices.mockRejectedValue(new Error("Could not refresh the device list"));
    const props = currentProvisioningProps();

    act(() => props.onCreated(CREATED_DEVICE));

    expect(await screen.findByRole("alert")).toHaveTextContent("API error: Could not refresh the device list");
    expect(screen.getByText("Credential panel state")).toBeInTheDocument();
    expect(screen.getByLabelText(/device provisioning mock/i)).toBeInTheDocument();
  });

  it("logs out when device provisioning reports authentication loss", async () => {
    render(<App />);
    await logIn();
    const props = currentProvisioningProps();

    act(() => props.onAuthenticationLost());

    expect(await screen.findByRole("button", { name: /sign in/i })).toBeInTheDocument();
    expect(session.clearAccessToken).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText(/selected device/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/device provisioning mock/i)).not.toBeInTheDocument();
  });

  it("hides provisioning immediately and reloads capability after permission denial", async () => {
    const currentUser = deferred<{ can_add_devices: boolean }>();
    render(<App />);
    await logIn();
    api.getCurrentUser.mockClear();
    api.getCurrentUser.mockReturnValue(currentUser.promise);
    const props = currentProvisioningProps();

    act(() => props.onPermissionDenied());

    expect(provisioning.props?.canAddDevices).toBe(false);
    expect(screen.queryByLabelText(/device provisioning mock/i)).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Your device creation permission changed.");
    expect(api.getCurrentUser).toHaveBeenCalledOnce();
    expect(api.getCurrentUser).toHaveBeenCalledWith("access-token");
    await act(async () => {
      currentUser.resolve({ can_add_devices: false });
      await currentUser.promise;
    });
    expect(provisioning.props?.canAddDevices).toBe(false);
  });

  it("uses the authoritative capability returned after permission denial", async () => {
    const currentUser = deferred<{ can_add_devices: boolean }>();
    render(<App />);
    await logIn();
    api.getCurrentUser.mockReturnValue(currentUser.promise);
    const props = currentProvisioningProps();

    act(() => props.onPermissionDenied());
    expect(screen.queryByLabelText(/device provisioning mock/i)).not.toBeInTheDocument();
    await act(async () => {
      currentUser.resolve({ can_add_devices: true });
      await currentUser.promise;
    });

    expect(provisioning.props?.canAddDevices).toBe(true);
    expect(screen.getByLabelText(/device provisioning mock/i)).toBeInTheDocument();
  });

  it("logs out when the capability reload after permission denial returns 401", async () => {
    render(<App />);
    await logIn();
    api.getCurrentUser.mockRejectedValue(new api.ApiError(401));
    const props = currentProvisioningProps();

    act(() => props.onPermissionDenied());

    expect(await screen.findByRole("button", { name: /sign in/i })).toBeInTheDocument();
    expect(session.clearAccessToken).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText(/selected device/i)).not.toBeInTheDocument();
  });

  it("keeps provisioning hidden when the capability reload fails transiently", async () => {
    render(<App />);
    await logIn();
    api.getCurrentUser.mockRejectedValue(new Error("Could not reload capability"));
    const props = currentProvisioningProps();

    act(() => props.onPermissionDenied());

    expect(await screen.findByRole("alert")).toHaveTextContent("API error: Could not reload capability");
    expect(provisioning.props?.canAddDevices).toBe(false);
    expect(screen.queryByLabelText(/device provisioning mock/i)).not.toBeInTheDocument();
  });

  it("ignores a stale capability reload from an earlier authentication session", async () => {
    const staleCurrentUser = deferred<{ can_add_devices: boolean }>();
    api.login.mockResolvedValueOnce("first-token").mockResolvedValueOnce("second-token");
    render(<App />);
    await logIn();
    api.getCurrentUser
      .mockReturnValueOnce(staleCurrentUser.promise)
      .mockResolvedValueOnce({ can_add_devices: false });
    const firstSessionCallbacks = currentProvisioningProps();

    act(() => firstSessionCallbacks.onPermissionDenied());
    act(() => firstSessionCallbacks.onAuthenticationLost());
    await logIn();
    expect(provisioning.props).toMatchObject({ accessToken: "second-token", canAddDevices: false });

    await act(async () => {
      staleCurrentUser.resolve({ can_add_devices: true });
      await staleCurrentUser.promise;
    });

    expect(provisioning.props).toMatchObject({ accessToken: "second-token", canAddDevices: false });
    expect(screen.getByLabelText(/selected device/i)).toBeInTheDocument();
  });

  it("shows each device name together with its UUID in the selector", async () => {
    render(<App />);

    await logIn();

    expect(screen.getByRole("option", {
      name: "Boiler — a1111111-1111-4111-8111-111111111111",
    })).toBeInTheDocument();
  });

  it("shows the selected device UUID as visible labeled text", async () => {
    render(<App />);

    await logInAndSelect();

    const label = screen.getByText("Device ID:", { selector: "strong" });
    expect(label.parentElement).toHaveTextContent("Device ID: a1111111-1111-4111-8111-111111111111");
  });

  it("does not show selected-device ID text while the placeholder is selected", async () => {
    render(<App />);
    await logInAndSelect();
    fireEvent.change(screen.getByLabelText(/selected device/i), { target: { value: "" } });

    expect(screen.queryByText("Device ID:", { selector: "strong" })).not.toBeInTheDocument();
  });

  it("starts one global device-creation subscription after authentication", async () => {
    render(<App />);

    await logIn();

    await waitFor(() => expect(nats.subscribeToDeviceCreations).toHaveBeenCalledOnce());
    expect(nats.subscribeToDeviceCreations).toHaveBeenCalledWith(
      "nats-token",
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
  });

  it("reconciles devices after the global subscription becomes ready", async () => {
    const subscriptionReady = deferred<() => void>();
    api.listDevices
      .mockResolvedValueOnce([DEVICE_ONE])
      .mockResolvedValueOnce([DEVICE_ONE, DEVICE_THREE]);
    nats.subscribeToDeviceCreations.mockReturnValue(subscriptionReady.promise);
    render(<App />);

    await logIn();
    expect(screen.queryByRole("option", { name: /Chiller/ })).not.toBeInTheDocument();
    await waitFor(() => expect(nats.subscribeToDeviceCreations).toHaveBeenCalledOnce());

    subscriptionReady.resolve(closeDeviceCreations);

    expect(await screen.findByRole("option", { name: /Chiller/ })).toBeInTheDocument();
    expect(api.listDevices).toHaveBeenNthCalledWith(2, "access-token");
  });

  it("refreshes the authoritative device list after a creation event", async () => {
    render(<App />);
    await logIn();
    await waitFor(() => expect(nats.subscribeToDeviceCreations).toHaveBeenCalledOnce());
    api.listDevices.mockClear();
    api.listDevices.mockResolvedValue([DEVICE_ONE, DEVICE_TWO, DEVICE_THREE]);

    act(() => deviceCreated());

    expect(await screen.findByRole("option", { name: /Chiller/ })).toBeInTheDocument();
    expect(api.listDevices).toHaveBeenCalledOnce();
    expect(api.listDevices).toHaveBeenCalledWith("access-token");
  });

  it("refreshes the authoritative device list after a global reconnect", async () => {
    render(<App />);
    await logIn();
    await waitFor(() => expect(nats.subscribeToDeviceCreations).toHaveBeenCalledOnce());
    api.listDevices.mockClear();
    api.listDevices.mockResolvedValue([DEVICE_THREE]);

    act(() => deviceReconnect());

    expect(await screen.findByRole("option", { name: /Chiller/ })).toBeInTheDocument();
    expect(api.listDevices).toHaveBeenCalledOnce();
    expect(api.listDevices).toHaveBeenCalledWith("access-token");
  });

  it("keeps the selected device when an authoritative refresh still returns it", async () => {
    render(<App />);
    await logInAndSelect();
    await waitFor(() => expect(nats.subscribeToDeviceCreations).toHaveBeenCalledOnce());
    api.listDevices.mockResolvedValue([DEVICE_ONE, DEVICE_THREE]);

    act(() => deviceCreated());

    await screen.findByRole("option", { name: /Chiller/ });
    expect(screen.getByLabelText(/selected device/i)).toHaveValue(DEVICE_ONE.id);
  });

  it("does not let an older overlapping refresh replace a newer device list", async () => {
    const older = deferred<typeof DEVICE_ONE[]>();
    const newer = deferred<typeof DEVICE_ONE[]>();
    render(<App />);
    await logIn();
    await waitFor(() => expect(nats.subscribeToDeviceCreations).toHaveBeenCalledOnce());
    api.listDevices.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);

    act(() => {
      deviceCreated();
      deviceCreated();
    });
    await act(async () => {
      newer.resolve([DEVICE_ONE, DEVICE_THREE]);
      await newer.promise;
    });
    expect(await screen.findByRole("option", { name: /Chiller/ })).toBeInTheDocument();

    await act(async () => {
      older.resolve([DEVICE_TWO]);
      await older.promise;
    });
    expect(screen.getByRole("option", { name: /Chiller/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Pump/ })).not.toBeInTheDocument();
  });

  it.each([401, 403])("logs out when an older overlapping refresh returns %i", async (status) => {
    const older = deferred<typeof DEVICE_ONE[]>();
    const newer = deferred<typeof DEVICE_ONE[]>();
    render(<App />);
    await logIn();
    await waitFor(() => expect(nats.subscribeToDeviceCreations).toHaveBeenCalledOnce());
    api.listDevices.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);

    act(() => {
      deviceCreated();
      deviceCreated();
    });
    await act(async () => {
      newer.resolve([DEVICE_ONE, DEVICE_THREE]);
      await newer.promise;
    });
    expect(await screen.findByRole("option", { name: /Chiller/ })).toBeInTheDocument();

    await act(async () => {
      older.reject(new api.ApiError(status));
      await older.promise.catch(() => undefined);
    });
    expect(await screen.findByRole("button", { name: /sign in/i })).toBeInTheDocument();
    expect(session.clearAccessToken).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText(/selected device/i)).not.toBeInTheDocument();
  });

  it.each([401, 403])("ignores a stale %i response from an earlier authentication session", async (status) => {
    const staleUnauthorized = deferred<typeof DEVICE_ONE[]>();
    api.login.mockResolvedValueOnce("first-token").mockResolvedValueOnce("second-token");
    render(<App />);
    await logIn();
    await waitFor(() => expect(nats.subscribeToDeviceCreations).toHaveBeenCalledOnce());
    const firstSessionDeviceCreated = deviceCreated;
    api.listDevices
      .mockReturnValueOnce(staleUnauthorized.promise)
      .mockRejectedValueOnce(new api.ApiError(401));

    act(() => {
      firstSessionDeviceCreated();
      firstSessionDeviceCreated();
    });
    expect(await screen.findByRole("button", { name: /sign in/i })).toBeInTheDocument();
    await logIn();
    await waitFor(() => expect(nats.subscribeToDeviceCreations).toHaveBeenCalledTimes(2));
    session.clearAccessToken.mockClear();

    await act(async () => {
      staleUnauthorized.reject(new api.ApiError(status));
      await staleUnauthorized.promise.catch(() => undefined);
    });
    expect(screen.getByLabelText(/selected device/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /sign in/i })).not.toBeInTheDocument();
    expect(session.storeAccessToken).toHaveBeenLastCalledWith("second-token");
    expect(session.clearAccessToken).not.toHaveBeenCalled();
  });

  it("closes the global device subscription when the component unmounts", async () => {
    const view = render(<App />);
    await logIn();
    await waitFor(() => expect(nats.subscribeToDeviceCreations).toHaveBeenCalledOnce());

    view.unmount();

    await waitFor(() => expect(closeDeviceCreations).toHaveBeenCalledOnce());
  });

  it("logs out and closes the global subscription when a refresh is unauthorized", async () => {
    render(<App />);
    await logIn();
    await waitFor(() => expect(nats.subscribeToDeviceCreations).toHaveBeenCalledOnce());
    api.listDevices.mockRejectedValue(new api.ApiError(401));

    act(() => deviceCreated());

    expect(await screen.findByRole("button", { name: /sign in/i })).toBeInTheDocument();
    expect(session.clearAccessToken).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText(/selected device/i)).not.toBeInTheDocument();
    await waitFor(() => expect(closeDeviceCreations).toHaveBeenCalledOnce());
  });

  it("logs in, lists devices, and loads the first descending measurement page", async () => {
    render(<App />);
    await logInAndSelect();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /latest measurement/i })).toHaveTextContent("temperature");
    });
    expect(api.login).toHaveBeenCalledWith("reader", "password");
    expect(api.getMeasurements).toHaveBeenCalledWith(
      DEVICE_ONE.id,
      "access-token",
      `limit=${PAGE_SIZE}&offset=0&order=desc`,
    );
    expect(screen.getAllByRole("row")).toHaveLength(3);
  });

  it("uses authoritative metadata for numeric page controls and requests adjacent offsets", async () => {
    const firstPageRows = Array.from({ length: PAGE_SIZE }, (_, index) => measurement(120 - index));
    const secondPageRows = Array.from({ length: PAGE_SIZE }, (_, index) => measurement(70 - index));
    api.getMeasurements.mockImplementation(async (_deviceId, _token, query) => (
      query === `limit=${PAGE_SIZE}&offset=50&order=desc`
        ? measurementPage(secondPageRows, { total: 120, offset: 50 })
        : measurementPage(firstPageRows, { total: 120 })
    ));
    render(<App />);
    await logInAndSelect();

    expect(await screen.findByText("Page 1 of 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^previous$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^next$/i })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: /^next$/i }));

    await waitFor(() => expect(api.getMeasurements).toHaveBeenCalledWith(
      DEVICE_ONE.id,
      "access-token",
      `limit=${PAGE_SIZE}&offset=50&order=desc`,
    ));
    expect(await screen.findByText("Page 2 of 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^previous$/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^next$/i })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: /^previous$/i }));

    await waitFor(() => expect(api.getMeasurements).toHaveBeenLastCalledWith(
      DEVICE_ONE.id,
      "access-token",
      `limit=${PAGE_SIZE}&offset=0&order=desc`,
    ));
    expect(await screen.findByText("Page 1 of 3")).toBeInTheDocument();
  });

  it("disables Next at the authoritative last-page boundary regardless of entry indexes", async () => {
    api.getMeasurements.mockResolvedValue(measurementPage(
      Array.from({ length: 20 }, (_, index) => measurement(121 - index)),
      { total: 120, offset: 100 },
    ));
    render(<App />);
    await logInAndSelect();

    expect(await screen.findByText("Page 3 of 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^previous$/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^next$/i })).toBeDisabled();
  });

  it("renders an empty authoritative result as a single disabled page", async () => {
    api.getLatest.mockResolvedValue(null);
    api.getMeasurements.mockResolvedValue(measurementPage([], { total: 0 }));
    render(<App />);
    await logInAndSelect();

    expect(await screen.findByText("Page 1 of 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^previous$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^next$/i })).toBeDisabled();
  });

  it("normalizes an empty nonzero page to offset zero without a correction loop", async () => {
    const firstPageRows = Array.from({ length: PAGE_SIZE }, (_, index) => measurement(120 - index));
    api.getMeasurements
      .mockResolvedValueOnce(measurementPage(firstPageRows, { total: 120 }))
      .mockResolvedValueOnce(measurementPage([], { total: 0, offset: 50 }));
    render(<App />);
    await logInAndSelect();
    await screen.findByText("Page 1 of 3");

    fireEvent.click(screen.getByRole("button", { name: /^next$/i }));

    expect(await screen.findByText("Page 1 of 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^previous$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^next$/i })).toBeDisabled();
    expect(api.getMeasurements).toHaveBeenCalledTimes(2);

    api.getMeasurements.mockClear();
    api.getMeasurements.mockResolvedValue(measurementPage([], { total: 0 }));
    act(() => reconnect());

    await waitFor(() => expect(api.getMeasurements).toHaveBeenCalledWith(
      DEVICE_ONE.id,
      "access-token",
      `limit=${PAGE_SIZE}&offset=0&order=desc`,
    ));
  });

  it("disables both page controls while an adjacent page request is pending", async () => {
    const pendingPage = deferred<MeasurementPage>();
    const firstPageRows = Array.from({ length: PAGE_SIZE }, (_, index) => measurement(120 - index));
    api.getMeasurements
      .mockResolvedValueOnce(measurementPage(firstPageRows, { total: 120 }))
      .mockReturnValueOnce(pendingPage.promise);
    render(<App />);
    await logInAndSelect();
    await screen.findByText("Page 1 of 3");

    fireEvent.click(screen.getByRole("button", { name: /^next$/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^previous$/i })).toBeDisabled();
      expect(screen.getByRole("button", { name: /^next$/i })).toBeDisabled();
    });
    expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
  });

  it("resets ordering and device changes to offset zero and reconnects at the current selection", async () => {
    api.getMeasurements.mockImplementation(async (requestedDeviceId, _token, query) => {
      const requestedOrder = query.endsWith("order=asc") ? "asc" : "desc";
      const requestedOffset = query.includes("offset=50") ? 50 : 0;
      const firstIndex = requestedDeviceId === DEVICE_TWO.id ? 220 : 120;
      return measurementPage(
        Array.from({ length: PAGE_SIZE }, (_, index) => measurement(firstIndex - index, requestedDeviceId)),
        { total: 120, offset: requestedOffset, order: requestedOrder },
      );
    });
    render(<App />);
    await logInAndSelect();
    await screen.findByText("Page 1 of 3");

    const ordering = screen.getByLabelText(/measurement order/i);
    expect(ordering).toHaveValue("desc");
    expect(screen.getByRole("option", { name: "Newest first" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Oldest first" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
    expect(await screen.findByText("Page 2 of 3")).toBeInTheDocument();
    fireEvent.change(ordering, { target: { value: "asc" } });

    await waitFor(() => expect(api.getMeasurements).toHaveBeenCalledWith(
      DEVICE_ONE.id,
      "access-token",
      `limit=${PAGE_SIZE}&offset=0&order=asc`,
    ));
    expect(await screen.findByText("Page 1 of 3")).toBeInTheDocument();

    api.getMeasurements.mockClear();
    fireEvent.change(screen.getByLabelText(/selected device/i), { target: { value: DEVICE_TWO.id } });

    await waitFor(() => expect(api.getMeasurements).toHaveBeenCalledWith(
      DEVICE_TWO.id,
      "access-token",
      `limit=${PAGE_SIZE}&offset=0&order=asc`,
    ));
    expect(screen.getByLabelText(/measurement order/i)).toHaveValue("asc");
    fireEvent.click(await screen.findByRole("button", { name: /^next$/i }));
    expect(await screen.findByText("Page 2 of 3")).toBeInTheDocument();

    api.getMeasurements.mockClear();
    api.getLatest.mockClear();
    act(() => reconnect());

    await waitFor(() => expect(api.getMeasurements).toHaveBeenCalledWith(
      DEVICE_TWO.id,
      "access-token",
      `limit=${PAGE_SIZE}&offset=50&order=asc`,
    ));
    expect(api.getLatest).toHaveBeenCalledWith(DEVICE_TWO.id, "access-token");
  });

  describe("live measurement refresh", () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.resetAllMocks();
    });

    async function advanceTimersByTime(milliseconds: number) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(milliseconds);
      });
    }

    async function waitForInitialMeasurements() {
      await waitFor(() => {
        expect(screen.getByRole("heading", { name: /latest measurement/i })).toHaveTextContent("temperature 2");
      });
    }

    it("reports scheduled, loading, and current history freshness through a live refresh", async () => {
      const refreshedLatest = deferred<Measurement | null>();
      const refreshedPage = deferred<MeasurementPage>();
      render(<App />);
      await logInAndSelect();
      await waitForInitialMeasurements();
      api.getLatest.mockClear();
      api.getMeasurements.mockClear();
      api.getLatest.mockReturnValueOnce(refreshedLatest.promise);
      api.getMeasurements.mockReturnValueOnce(refreshedPage.promise);
      vi.useFakeTimers();

      act(() => notification(measurement(3)));

      expect(screen.getByRole("status", { name: "Measurement history status" })).toHaveTextContent(
        "Refresh scheduled",
      );

      await advanceTimersByTime(250);

      expect(screen.getByRole("status", { name: "Measurement history status" })).toHaveTextContent(
        "Refreshing history",
      );
      await act(async () => {
        refreshedLatest.resolve(measurement(3));
        refreshedPage.resolve(measurementPage([measurement(3), measurement(2), measurement(1)]));
        await Promise.all([refreshedLatest.promise, refreshedPage.promise]);
      });

      expect(screen.getByRole("status", { name: "Measurement history status" })).toHaveTextContent(
        "History up to date",
      );
    });

    it("updates latest immediately but keeps rows stable only during the 250 ms debounce window", async () => {
      render(<App />);
      await logInAndSelect();
      await waitForInitialMeasurements();
      api.getLatest.mockClear();
      api.getMeasurements.mockClear();
      api.getLatest.mockResolvedValue(measurement(3));
      vi.useFakeTimers();

      act(() => notification(measurement(3)));

      expect(screen.getByRole("heading", { name: /latest measurement/i })).toHaveTextContent("temperature 3");
      expect(screen.getAllByRole("row")).toHaveLength(3);
      await advanceTimersByTime(249);
      expect(api.getLatest).not.toHaveBeenCalled();
      expect(api.getMeasurements).not.toHaveBeenCalled();

      await advanceTimersByTime(1);

      expect(api.getLatest).toHaveBeenCalledOnce();
      expect(api.getLatest).toHaveBeenCalledWith(DEVICE_ONE.id, "access-token");
      expect(api.getMeasurements).toHaveBeenCalledOnce();
      expect(api.getMeasurements).toHaveBeenCalledWith(
        DEVICE_ONE.id,
        "access-token",
        `limit=${PAGE_SIZE}&offset=0&order=desc`,
      );
    });

    it("keeps a newer notification scheduled when an in-flight manual page later succeeds", async () => {
      const manualPage = deferred<MeasurementPage>();
      const firstPageRows = Array.from({ length: PAGE_SIZE }, (_, index) => measurement(120 - index));
      const secondPageRows = Array.from({ length: PAGE_SIZE }, (_, index) => measurement(70 - index));
      const refreshedRows = Array.from({ length: PAGE_SIZE }, (_, index) => measurement(69 - index));
      api.getLatest.mockResolvedValue(measurement(120));
      api.getMeasurements.mockResolvedValueOnce(measurementPage(firstPageRows, { total: 120 }));
      render(<App />);
      await logInAndSelect();
      await screen.findByText("Page 1 of 3");
      api.getLatest.mockClear();
      api.getMeasurements.mockClear();
      api.getLatest.mockResolvedValueOnce(measurement(121));
      api.getMeasurements
        .mockReturnValueOnce(manualPage.promise)
        .mockResolvedValueOnce(measurementPage(refreshedRows, { total: 120, offset: PAGE_SIZE }));
      vi.useFakeTimers();

      fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
      expect(api.getMeasurements).toHaveBeenCalledWith(
        DEVICE_ONE.id,
        "access-token",
        `limit=${PAGE_SIZE}&offset=${PAGE_SIZE}&order=desc`,
      );
      expect(screen.getByRole("status", { name: "Measurement history status" })).toHaveTextContent(
        "Refreshing history",
      );

      act(() => notification(measurement(121)));
      expect(screen.getByRole("status", { name: "Measurement history status" })).toHaveTextContent(
        "Refresh scheduled",
      );
      await act(async () => {
        manualPage.resolve(measurementPage(secondPageRows, { total: 120, offset: PAGE_SIZE }));
        await manualPage.promise;
      });

      expect(screen.getByText("Page 2 of 3")).toBeInTheDocument();
      expect(screen.getAllByRole("row")[1]).toHaveTextContent("70");
      expect(screen.getByRole("status", { name: "Measurement history status" })).toHaveTextContent(
        "Refresh scheduled",
      );

      await advanceTimersByTime(250);

      expect(api.getMeasurements).toHaveBeenCalledTimes(2);
      expect(api.getMeasurements).toHaveBeenNthCalledWith(
        2,
        DEVICE_ONE.id,
        "access-token",
        `limit=${PAGE_SIZE}&offset=${PAGE_SIZE}&order=desc`,
      );
      expect(screen.getAllByRole("row")[1]).toHaveTextContent("69");
      expect(screen.getByRole("status", { name: "Measurement history status" })).toHaveTextContent(
        "History up to date",
      );
    });

    it("coalesces three notifications inside 250 ms into one additional refresh", async () => {
      render(<App />);
      await logInAndSelect();
      await waitForInitialMeasurements();
      api.getLatest.mockClear();
      api.getMeasurements.mockClear();
      api.getLatest.mockResolvedValue(measurement(5));
      vi.useFakeTimers();

      act(() => notification(measurement(3)));
      await advanceTimersByTime(100);
      act(() => notification(measurement(4)));
      await advanceTimersByTime(100);
      act(() => notification(measurement(5)));
      await advanceTimersByTime(249);

      expect(screen.getByRole("heading", { name: /latest measurement/i })).toHaveTextContent("temperature 5");
      expect(api.getLatest).not.toHaveBeenCalled();
      expect(api.getMeasurements).not.toHaveBeenCalled();

      await advanceTimersByTime(1);

      expect(api.getLatest).toHaveBeenCalledOnce();
      expect(api.getMeasurements).toHaveBeenCalledOnce();
    });

    it("does not let an older paired refresh regress a newer live notification", async () => {
      const olderLatest = deferred<Measurement | null>();
      const olderPage = deferred<MeasurementPage>();
      render(<App />);
      await logInAndSelect();
      await waitForInitialMeasurements();
      api.getLatest.mockClear();
      api.getMeasurements.mockClear();
      api.getLatest.mockReturnValue(olderLatest.promise);
      api.getMeasurements.mockReturnValue(olderPage.promise);
      vi.useFakeTimers();

      act(() => notification(measurement(3)));
      await advanceTimersByTime(250);
      await act(async () => {
        olderLatest.resolve(measurement(3));
        await olderLatest.promise;
      });

      act(() => notification(measurement(4)));
      expect(screen.getByRole("heading", { name: /latest measurement/i })).toHaveTextContent("temperature 4");
      await act(async () => {
        olderPage.resolve(measurementPage([measurement(3), measurement(2), measurement(1)], { total: 3 }));
        await olderPage.promise;
      });

      expect(screen.getByRole("heading", { name: /latest measurement/i })).toHaveTextContent("temperature 4");
      expect(screen.getAllByRole("row")).toHaveLength(3);
      expect(screen.getAllByRole("row")[1]).toHaveTextContent("1");
      expect(screen.getAllByRole("row")[2]).toHaveTextContent("2");
    });

    it("refreshes the exact current ascending page and replaces rows and total metadata", async () => {
      const firstPageRows = Array.from({ length: PAGE_SIZE }, (_, index) => measurement(120 - index));
      const secondPageRows = Array.from({ length: PAGE_SIZE }, (_, index) => measurement(70 - index));
      const refreshedLatest = deferred<Measurement | null>();
      const refreshedPage = deferred<MeasurementPage>();
      api.getMeasurements
        .mockResolvedValueOnce(measurementPage(firstPageRows, { total: 120 }))
        .mockResolvedValueOnce(measurementPage(firstPageRows, { total: 120, order: "asc" }))
        .mockResolvedValueOnce(measurementPage(secondPageRows, { total: 120, offset: 50, order: "asc" }))
        .mockReturnValueOnce(refreshedPage.promise);
      api.getLatest
        .mockResolvedValueOnce(measurement(120))
        .mockReturnValueOnce(refreshedLatest.promise);
      render(<App />);
      await logInAndSelect();
      await waitFor(() => expect(screen.getByText("Page 1 of 3")).toBeInTheDocument());

      fireEvent.change(screen.getByLabelText(/measurement order/i), { target: { value: "asc" } });
      await waitFor(() => expect(screen.getByLabelText(/measurement order/i)).toHaveValue("asc"));
      fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
      await waitFor(() => expect(screen.getByText("Page 2 of 3")).toBeInTheDocument());
      api.getLatest.mockClear();
      api.getMeasurements.mockClear();
      vi.useFakeTimers();

      act(() => notification(measurement(121)));
      await advanceTimersByTime(250);

      expect(api.getLatest).toHaveBeenCalledWith(DEVICE_ONE.id, "access-token");
      expect(api.getMeasurements).toHaveBeenCalledWith(
        DEVICE_ONE.id,
        "access-token",
        `limit=${PAGE_SIZE}&offset=50&order=asc`,
      );
      await act(async () => {
        refreshedLatest.resolve(measurement(175));
        refreshedPage.resolve(measurementPage([measurement(999)], {
          total: 175,
          offset: 50,
          order: "asc",
        }));
        await Promise.all([refreshedLatest.promise, refreshedPage.promise]);
      });

      expect(screen.getByText("Page 2 of 4")).toBeInTheDocument();
      expect(screen.getAllByRole("row")).toHaveLength(2);
      expect(screen.getAllByRole("row")[1]).toHaveTextContent("999");
      expect(screen.getByRole("heading", { name: /latest measurement/i })).toHaveTextContent("temperature 175");
    });

    it("corrects a live refresh whose current offset is no longer valid exactly once", async () => {
      const firstPageRows = Array.from({ length: PAGE_SIZE }, (_, index) => measurement(120 - index));
      const secondPageRows = Array.from({ length: PAGE_SIZE }, (_, index) => measurement(70 - index));
      let ascendingOffsetZeroRequests = 0;
      let ascendingOffsetFiftyRequests = 0;
      api.getLatest.mockResolvedValue(measurement(120));
      api.getMeasurements.mockImplementation((_deviceId, _token, query) => {
        if (query === `limit=${PAGE_SIZE}&offset=0&order=desc`) {
          return Promise.resolve(measurementPage(firstPageRows, { total: 120 }));
        }
        if (query === `limit=${PAGE_SIZE}&offset=0&order=asc`) {
          ascendingOffsetZeroRequests += 1;
          return Promise.resolve(ascendingOffsetZeroRequests === 1
            ? measurementPage(firstPageRows, { total: 120, order: "asc" })
            : measurementPage([measurement(20)], { total: 20, order: "asc" }));
        }
        ascendingOffsetFiftyRequests += 1;
        return Promise.resolve(ascendingOffsetFiftyRequests === 1
          ? measurementPage(secondPageRows, { total: 120, offset: 50, order: "asc" })
          : measurementPage([], { total: 20, offset: 50, order: "asc" }));
      });
      render(<App />);
      await logInAndSelect();
      await waitFor(() => expect(screen.getByText("Page 1 of 3")).toBeInTheDocument());
      fireEvent.change(screen.getByLabelText(/measurement order/i), { target: { value: "asc" } });
      fireEvent.click(await screen.findByRole("button", { name: /^next$/i }));
      await waitFor(() => expect(screen.getByText("Page 2 of 3")).toBeInTheDocument());
      api.getMeasurements.mockClear();
      vi.useFakeTimers();

      act(() => notification(measurement(121)));
      await advanceTimersByTime(250);

      expect(api.getMeasurements).toHaveBeenCalledTimes(2);
      expect(api.getMeasurements).toHaveBeenNthCalledWith(
        1,
        DEVICE_ONE.id,
        "access-token",
        `limit=${PAGE_SIZE}&offset=50&order=asc`,
      );
      expect(api.getMeasurements).toHaveBeenNthCalledWith(
        2,
        DEVICE_ONE.id,
        "access-token",
        `limit=${PAGE_SIZE}&offset=0&order=asc`,
      );
      expect(screen.getByText("Page 1 of 1")).toBeInTheDocument();
      expect(screen.getAllByRole("row")).toHaveLength(2);
      expect(screen.getAllByRole("row")[1]).toHaveTextContent("20");
    });

    it("keeps the current page on refresh failure and retries after a later notification", async () => {
      const initialRows = Array.from({ length: PAGE_SIZE }, (_, index) => measurement(120 - index));
      const failedRefresh = deferred<MeasurementPage>();
      api.getMeasurements
        .mockResolvedValueOnce(measurementPage(initialRows, { total: 120 }))
        .mockReturnValueOnce(failedRefresh.promise);
      api.getLatest.mockResolvedValue(measurement(120));
      render(<App />);
      await logInAndSelect();
      await waitFor(() => expect(screen.getByText("Page 1 of 3")).toBeInTheDocument());
      api.getLatest.mockClear();
      api.getMeasurements.mockClear();
      api.getLatest.mockResolvedValue(measurement(121));
      vi.useFakeTimers();

      act(() => notification(measurement(121)));
      expect(screen.getByRole("status", { name: "Measurement history status" })).toHaveTextContent(
        "Refresh scheduled",
      );
      await advanceTimersByTime(250);
      expect(api.getLatest).toHaveBeenCalledOnce();
      expect(api.getMeasurements).toHaveBeenCalledOnce();
      expect(screen.getByRole("status", { name: "Measurement history status" })).toHaveTextContent(
        "Refreshing history",
      );
      await act(async () => {
        failedRefresh.reject(new Error("live refresh unavailable"));
        await failedRefresh.promise.catch(() => undefined);
      });
      vi.useRealTimers();

      expect(await screen.findByRole("alert")).toHaveTextContent("API error: live refresh unavailable");
      expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
      expect(screen.getAllByRole("row")).toHaveLength(PAGE_SIZE + 1);
      expect(screen.getAllByRole("row")[1]).toHaveTextContent("120");
      expect(screen.getByRole("status", { name: "Measurement history status" })).toHaveTextContent(
        "History may be out of date",
      );

      api.getLatest.mockClear();
      api.getMeasurements.mockClear();
      api.getLatest.mockResolvedValue(measurement(122));
      api.getMeasurements.mockResolvedValue(measurementPage([measurement(122)], { total: 121 }));
      vi.useFakeTimers();
      act(() => notification(measurement(122)));
      await advanceTimersByTime(250);

      expect(api.getLatest).toHaveBeenCalledOnce();
      expect(api.getMeasurements).toHaveBeenCalledOnce();
      expect(screen.queryByText(/live refresh unavailable/i)).not.toBeInTheDocument();
      expect(screen.getAllByRole("row")).toHaveLength(2);
      expect(screen.getAllByRole("row")[1]).toHaveTextContent("122");
      expect(screen.getByRole("status", { name: "Measurement history status" })).toHaveTextContent(
        "History up to date",
      );
    });

    it("reports a page failure without waiting for latest and blocks its late success", async () => {
      const initialRows = Array.from({ length: PAGE_SIZE }, (_, index) => measurement(120 - index));
      const pendingLatest = deferred<Measurement | null>();
      const failedPage = deferred<MeasurementPage>();
      api.getMeasurements.mockResolvedValueOnce(measurementPage(initialRows, { total: 120 }));
      api.getLatest.mockResolvedValueOnce(measurement(120));
      render(<App />);
      await logInAndSelect();
      await waitFor(() => expect(screen.getByText("Page 1 of 3")).toBeInTheDocument());
      api.getLatest.mockClear();
      api.getMeasurements.mockClear();
      api.getLatest.mockReturnValueOnce(pendingLatest.promise);
      api.getMeasurements.mockReturnValueOnce(failedPage.promise);
      vi.useFakeTimers();

      act(() => notification(measurement(121)));
      await advanceTimersByTime(250);
      await act(async () => {
        failedPage.reject(new Error("live page failed promptly"));
        await failedPage.promise.catch(() => undefined);
      });

      expect(screen.getByRole("alert")).toHaveTextContent("API error: live page failed promptly");
      expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
      expect(screen.getAllByRole("row")).toHaveLength(PAGE_SIZE + 1);
      expect(screen.getAllByRole("row")[1]).toHaveTextContent("120");

      await act(async () => {
        pendingLatest.resolve(measurement(999));
        await pendingLatest.promise;
      });

      expect(screen.getByRole("alert")).toHaveTextContent("API error: live page failed promptly");
      expect(screen.getByRole("heading", { name: /latest measurement/i })).toHaveTextContent("temperature 121");
      expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
      expect(screen.getAllByRole("row")[1]).toHaveTextContent("120");
    });

    it("keeps the current page atomic when latest fails and retries on a later notification", async () => {
      const initialRows = Array.from({ length: PAGE_SIZE }, (_, index) => measurement(120 - index));
      const failedLatest = deferred<Measurement | null>();
      const successfulPage = deferred<MeasurementPage>();
      api.getMeasurements.mockResolvedValueOnce(measurementPage(initialRows, { total: 120 }));
      api.getLatest.mockResolvedValueOnce(measurement(120));
      render(<App />);
      await logInAndSelect();
      await waitFor(() => expect(screen.getByText("Page 1 of 3")).toBeInTheDocument());
      api.getLatest.mockClear();
      api.getMeasurements.mockClear();
      api.getLatest.mockReturnValueOnce(failedLatest.promise);
      api.getMeasurements.mockReturnValueOnce(successfulPage.promise);
      vi.useFakeTimers();

      act(() => notification(measurement(121)));
      await advanceTimersByTime(250);
      await act(async () => {
        successfulPage.resolve(measurementPage([measurement(999)], { total: 175 }));
        await successfulPage.promise;
      });

      expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
      expect(screen.getAllByRole("row")).toHaveLength(PAGE_SIZE + 1);
      expect(screen.getAllByRole("row")[1]).toHaveTextContent("120");

      await act(async () => {
        failedLatest.reject(new Error("latest refresh unavailable"));
        await failedLatest.promise.catch(() => undefined);
      });
      vi.useRealTimers();

      expect(await screen.findByRole("alert")).toHaveTextContent("API error: latest refresh unavailable");
      expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
      expect(screen.getAllByRole("row")).toHaveLength(PAGE_SIZE + 1);
      expect(screen.getAllByRole("row")[1]).toHaveTextContent("120");

      api.getLatest.mockClear();
      api.getMeasurements.mockClear();
      api.getLatest.mockResolvedValue(measurement(122));
      api.getMeasurements.mockResolvedValue(measurementPage([measurement(122)], { total: 121 }));
      vi.useFakeTimers();
      act(() => notification(measurement(122)));
      await advanceTimersByTime(250);

      expect(screen.queryByText(/latest refresh unavailable/i)).not.toBeInTheDocument();
      expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
      expect(screen.getAllByRole("row")).toHaveLength(2);
      expect(screen.getAllByRole("row")[1]).toHaveTextContent("122");
    });

    it("reports a latest failure without waiting for the page and blocks its late success", async () => {
      const initialRows = Array.from({ length: PAGE_SIZE }, (_, index) => measurement(120 - index));
      const failedLatest = deferred<Measurement | null>();
      const pendingPage = deferred<MeasurementPage>();
      api.getMeasurements.mockResolvedValueOnce(measurementPage(initialRows, { total: 120 }));
      api.getLatest.mockResolvedValueOnce(measurement(120));
      render(<App />);
      await logInAndSelect();
      await waitFor(() => expect(screen.getByText("Page 1 of 3")).toBeInTheDocument());
      api.getLatest.mockClear();
      api.getMeasurements.mockClear();
      api.getLatest.mockReturnValueOnce(failedLatest.promise);
      api.getMeasurements.mockReturnValueOnce(pendingPage.promise);
      vi.useFakeTimers();

      act(() => notification(measurement(121)));
      await advanceTimersByTime(250);
      await act(async () => {
        failedLatest.reject(new Error("live latest failed promptly"));
        await failedLatest.promise.catch(() => undefined);
      });

      expect(screen.getByRole("alert")).toHaveTextContent("API error: live latest failed promptly");
      expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
      expect(screen.getAllByRole("row")).toHaveLength(PAGE_SIZE + 1);
      expect(screen.getAllByRole("row")[1]).toHaveTextContent("120");

      await act(async () => {
        pendingPage.resolve(measurementPage([measurement(999)], { total: 175 }));
        await pendingPage.promise;
      });

      expect(screen.getByRole("alert")).toHaveTextContent("API error: live latest failed promptly");
      expect(screen.getByRole("heading", { name: /latest measurement/i })).toHaveTextContent("temperature 121");
      expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
      expect(screen.getAllByRole("row")[1]).toHaveTextContent("120");
    });

    it("ignores a live refresh success after the measurement order changes", async () => {
      const staleLatest = deferred<Measurement | null>();
      const stalePage = deferred<MeasurementPage>();
      render(<App />);
      await logInAndSelect();
      await waitForInitialMeasurements();
      api.getLatest.mockClear();
      api.getMeasurements.mockClear();
      api.getLatest.mockReturnValue(staleLatest.promise);
      api.getMeasurements.mockImplementation((_deviceId, _token, query) => (
        query === `limit=${PAGE_SIZE}&offset=0&order=asc`
          ? Promise.resolve(measurementPage([measurement(900)], { total: 1, order: "asc" }))
          : stalePage.promise
      ));
      vi.useFakeTimers();

      act(() => notification(measurement(3)));
      await advanceTimersByTime(250);
      expect(api.getLatest).toHaveBeenCalledOnce();
      expect(api.getMeasurements).toHaveBeenCalledWith(
        DEVICE_ONE.id,
        "access-token",
        `limit=${PAGE_SIZE}&offset=0&order=desc`,
      );
      await act(async () => {
        stalePage.resolve(measurementPage([measurement(777)], { total: 1 }));
        await stalePage.promise;
      });
      expect(screen.getAllByRole("row")).toHaveLength(3);
      expect(screen.getAllByRole("row")[1]).toHaveTextContent("1");
      vi.useRealTimers();
      fireEvent.change(screen.getByLabelText(/measurement order/i), { target: { value: "asc" } });
      await waitFor(() => expect(screen.getAllByRole("row")[1]).toHaveTextContent("900"));

      await act(async () => {
        staleLatest.resolve(measurement(999));
        await staleLatest.promise;
      });

      expect(screen.getByLabelText(/measurement order/i)).toHaveValue("asc");
      expect(screen.getByText("Page 1 of 1")).toBeInTheDocument();
      expect(screen.getAllByRole("row")[1]).toHaveTextContent("900");
      expect(screen.getByRole("heading", { name: /latest measurement/i })).toHaveTextContent("temperature 3");
    });

    it("ignores a live refresh latest failure after a newer page request", async () => {
      const staleLatest = deferred<Measurement | null>();
      const stalePage = deferred<MeasurementPage>();
      const initialRows = Array.from({ length: PAGE_SIZE }, (_, index) => measurement(120 - index));
      api.getMeasurements.mockResolvedValueOnce(measurementPage(initialRows, { total: 120 }));
      api.getLatest.mockResolvedValueOnce(measurement(120));
      render(<App />);
      await logInAndSelect();
      await waitFor(() => expect(screen.getByText("Page 1 of 3")).toBeInTheDocument());
      api.getLatest.mockClear();
      api.getMeasurements.mockClear();
      api.getLatest.mockReturnValue(staleLatest.promise);
      api.getMeasurements.mockReturnValueOnce(stalePage.promise);
      vi.useFakeTimers();

      act(() => notification(measurement(121)));
      await advanceTimersByTime(250);
      await act(async () => {
        stalePage.resolve(measurementPage([measurement(121)], { total: 120 }));
        await stalePage.promise;
      });
      vi.useRealTimers();
      api.getMeasurements.mockResolvedValue(measurementPage(
        [measurement(900)],
        { total: 120, offset: 50 },
      ));
      fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
      await waitFor(() => expect(screen.getAllByRole("row")[1]).toHaveTextContent("900"));

      await act(async () => {
        staleLatest.reject(new Error("stale latest failed"));
        await staleLatest.promise.catch(() => undefined);
      });

      expect(screen.queryByText(/stale latest failed/i)).not.toBeInTheDocument();
      expect(screen.getByText("Page 2 of 3")).toBeInTheDocument();
      expect(screen.getAllByRole("row")[1]).toHaveTextContent("900");
    });

    it("ignores a live refresh failure after the selected device changes", async () => {
      const stalePage = deferred<MeasurementPage>();
      render(<App />);
      await logInAndSelect();
      await waitForInitialMeasurements();
      api.getLatest.mockClear();
      api.getMeasurements.mockClear();
      api.getLatest.mockImplementation((requestedDeviceId: string) => Promise.resolve(
        requestedDeviceId === DEVICE_ONE.id ? measurement(3) : measurement(20, DEVICE_TWO.id),
      ));
      api.getMeasurements.mockImplementation((requestedDeviceId: string) => (
        requestedDeviceId === DEVICE_ONE.id
          ? stalePage.promise
          : Promise.resolve(measurementPage([measurement(20, DEVICE_TWO.id)]))
      ));
      vi.useFakeTimers();

      act(() => notification(measurement(3)));
      await advanceTimersByTime(250);
      expect(api.getLatest).toHaveBeenCalledOnce();
      expect(api.getMeasurements).toHaveBeenCalledWith(
        DEVICE_ONE.id,
        "access-token",
        `limit=${PAGE_SIZE}&offset=0&order=desc`,
      );
      vi.useRealTimers();
      fireEvent.change(screen.getByLabelText(/selected device/i), { target: { value: DEVICE_TWO.id } });
      await waitFor(() => {
        expect(screen.getByRole("heading", { name: /latest measurement/i })).toHaveTextContent("temperature 20");
      });

      await act(async () => {
        stalePage.reject(new Error("stale live refresh failed"));
        await stalePage.promise.catch(() => undefined);
      });

      expect(screen.queryByText(/stale live refresh failed/i)).not.toBeInTheDocument();
      expect(screen.getAllByRole("row")).toHaveLength(2);
      expect(screen.getAllByRole("row")[1]).toHaveTextContent("20");
    });

    it.each(["device change", "sign out", "unmount"])(
      "cancels a scheduled live refresh on %s",
      async (resetAction) => {
        const view = render(<App />);
        await logInAndSelect();
        await waitForInitialMeasurements();
        api.getLatest.mockClear();
        api.getMeasurements.mockClear();
        vi.useFakeTimers();

        act(() => notification(measurement(3)));
        if (resetAction === "device change") {
          api.getLatest.mockImplementation((requestedDeviceId: string) => Promise.resolve(
            measurement(20, requestedDeviceId),
          ));
          api.getMeasurements.mockImplementation((requestedDeviceId: string) => Promise.resolve(
            measurementPage([measurement(20, requestedDeviceId)]),
          ));
          fireEvent.change(screen.getByLabelText(/selected device/i), { target: { value: DEVICE_TWO.id } });
          await advanceTimersByTime(0);
          expect(api.getLatest).toHaveBeenCalledWith(DEVICE_TWO.id, "access-token");
          expect(api.getMeasurements).toHaveBeenCalledWith(
            DEVICE_TWO.id,
            "access-token",
            `limit=${PAGE_SIZE}&offset=0&order=desc`,
          );
          api.getLatest.mockClear();
          api.getMeasurements.mockClear();
        } else if (resetAction === "sign out") {
          act(() => currentProvisioningProps().onAuthenticationLost());
          expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
        } else {
          view.unmount();
        }

        await advanceTimersByTime(250);

        expect(api.getLatest).not.toHaveBeenCalled();
        expect(api.getMeasurements).not.toHaveBeenCalled();
      },
    );
  });

  it("consumes gap recovery without rewriting the displayed page", async () => {
    api.getMeasurements.mockImplementation(async (_deviceId, _token, query) => (
      query.startsWith("after_index")
        ? measurementPage([measurement(3), measurement(4), measurement(5)], { order: "asc" })
        : measurementPage([measurement(2), measurement(1)], { total: 2 })
    ));
    render(<App />);
    await logInAndSelect();
    await waitFor(() => expect(nats.subscribeToMeasurements).toHaveBeenCalledOnce());

    notification(measurement(5));

    await waitFor(() => {
      expect(api.getMeasurements).toHaveBeenCalledWith(
        DEVICE_ONE.id,
        "access-token",
        `after_index=2&through_index=5&limit=${PAGE_SIZE}`,
      );
    });
    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(3));
    expect(screen.getAllByRole("row")[1]).toHaveTextContent("2");
    expect(screen.getAllByRole("row")[2]).toHaveTextContent("1");
  });

  it("does not let a page success erase a live missing range", async () => {
    const nextPage = deferred<MeasurementPage>();
    const gapRecovery = deferred<MeasurementPage>();
    api.getLatest.mockResolvedValue(measurement(50));
    api.getMeasurements.mockImplementation((_deviceId, _token, query) => {
      if (query === `limit=${PAGE_SIZE}&offset=50&order=desc`) {
        return nextPage.promise;
      }
      if (query.startsWith("after_index")) {
        return gapRecovery.promise;
      }
      return Promise.resolve(measurementPage(
        Array.from({ length: PAGE_SIZE }, (_, index) => measurement(120 - index)),
        { total: 120 },
      ));
    });
    render(<App />);
    await logInAndSelect();
    await screen.findByText("Page 1 of 3");

    fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
    await waitFor(() => expect(api.getMeasurements).toHaveBeenCalledWith(
      DEVICE_ONE.id,
      "access-token",
      `limit=${PAGE_SIZE}&offset=50&order=desc`,
    ));
    act(() => notification(measurement(55)));
    await waitFor(() => expect(api.getMeasurements).toHaveBeenCalledWith(
      DEVICE_ONE.id,
      "access-token",
      `after_index=50&through_index=55&limit=${PAGE_SIZE}`,
    ));

    await act(async () => {
      nextPage.resolve(measurementPage(
        Array.from({ length: PAGE_SIZE }, (_, index) => measurement(70 - index)),
        { total: 120, offset: 50 },
      ));
      await nextPage.promise;
    });
    await screen.findByText("Page 2 of 3");
    act(() => notification(measurement(58)));

    await waitFor(() => expect(api.getMeasurements).toHaveBeenCalledWith(
      DEVICE_ONE.id,
      "access-token",
      `after_index=50&through_index=58&limit=${PAGE_SIZE}`,
    ));
  });

  it.each([
    ["latest", "Initial latest unavailable"],
    ["page", "Initial history unavailable"],
  ] as const)(
    "activates queued and later notifications when the initial %s read fails",
    async (failedRead, expectedError) => {
      const initialLatest = deferred<Measurement | null>();
      const initialRows = deferred<MeasurementPage>();
      api.getLatest.mockReturnValue(initialLatest.promise);
      api.getMeasurements.mockReturnValue(initialRows.promise);
      render(<App />);
      await logInAndSelect();
      await waitFor(() => expect(nats.subscribeToMeasurements).toHaveBeenCalledOnce());
      await waitFor(() => {
        expect(api.getLatest).toHaveBeenCalledOnce();
        expect(api.getMeasurements).toHaveBeenCalledOnce();
      });
      api.getLatest.mockClear();
      api.getMeasurements.mockClear();
      vi.useFakeTimers();

      try {
        act(() => notification(measurement(3)));
        await act(async () => {
          if (failedRead === "latest") {
            initialLatest.reject(new Error(expectedError));
            initialRows.resolve(measurementPage([measurement(2), measurement(1)], { total: 2 }));
          } else {
            initialLatest.resolve(measurement(2));
            initialRows.reject(new Error(expectedError));
          }
          await Promise.allSettled([initialLatest.promise, initialRows.promise]);
        });

        expect(api.getLatest).not.toHaveBeenCalled();
        expect(api.getMeasurements).not.toHaveBeenCalled();
        expect(screen.getByLabelText("Device connection status")).toHaveTextContent("Streaming");
        expect(screen.getByRole("heading", { name: /latest measurement/i })).toHaveTextContent("3");
        expect(screen.getByRole("status", { name: "Measurement history status" })).not.toHaveTextContent(
          "History up to date",
        );

        act(() => notification(measurement(4)));
        expect(screen.getByRole("heading", { name: /latest measurement/i })).toHaveTextContent("4");
        api.getLatest.mockResolvedValueOnce(measurement(4));
        api.getMeasurements.mockResolvedValueOnce(measurementPage(
          [measurement(4), measurement(3), measurement(2), measurement(1)],
          { total: 4 },
        ));

        await act(async () => {
          await vi.advanceTimersByTimeAsync(250);
        });

        expect(api.getLatest).toHaveBeenCalledWith(DEVICE_ONE.id, "access-token");
        expect(api.getMeasurements).toHaveBeenCalledWith(
          DEVICE_ONE.id,
          "access-token",
          `limit=${PAGE_SIZE}&offset=0&order=desc`,
        );
        expect(screen.getByRole("status", { name: "Measurement history status" })).toHaveTextContent(
          "History up to date",
        );
        expect(screen.getByText("4 measurements")).toBeInTheDocument();
        expect(screen.getAllByRole("row")).toHaveLength(5);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("does not miss a notification while the initial authoritative read is pending", async () => {
    const initialLatest = deferred<Measurement | null>();
    const initialRows = deferred<MeasurementPage>();
    api.getLatest.mockReturnValue(initialLatest.promise);
    api.getMeasurements.mockReturnValue(initialRows.promise);
    render(<App />);
    await logInAndSelect();
    await waitFor(() => expect(nats.subscribeToMeasurements).toHaveBeenCalledOnce());
    api.getLatest.mockClear();
    api.getMeasurements.mockClear();
    api.getLatest.mockResolvedValueOnce(measurement(3));
    api.getMeasurements.mockResolvedValueOnce(measurementPage(
      [measurement(3), measurement(2), measurement(1)],
      { total: 3 },
    ));
    vi.useFakeTimers();

    act(() => notification(measurement(3)));
    await act(async () => {
      initialLatest.resolve(measurement(2));
      initialRows.resolve(measurementPage([measurement(2), measurement(1)], { total: 2 }));
      await Promise.all([initialLatest.promise, initialRows.promise]);
    });

    expect(screen.getByRole("heading", { name: /latest measurement/i })).toHaveTextContent("3");
    expect(screen.getByRole("status", { name: "Measurement history status" })).toHaveTextContent(
      "Refresh scheduled",
    );
    expect(screen.getByText("2 measurements")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(screen.getAllByRole("row")[1]).toHaveTextContent("2");
    expect(screen.getAllByRole("row")[2]).toHaveTextContent("1");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(249);
    });
    expect(api.getLatest).not.toHaveBeenCalled();
    expect(api.getMeasurements).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(api.getLatest).toHaveBeenCalledWith(DEVICE_ONE.id, "access-token");
    expect(api.getMeasurements).toHaveBeenCalledWith(
      DEVICE_ONE.id,
      "access-token",
      `limit=${PAGE_SIZE}&offset=0&order=desc`,
    );
    expect(screen.getByRole("status", { name: "Measurement history status" })).toHaveTextContent(
      "History up to date",
    );
    expect(screen.getByText("3 measurements")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(4);
    expect(screen.getAllByRole("row")[1]).toHaveTextContent("3");

    vi.useRealTimers();
  });

  it("closes the old subscription on device changes", async () => {
    render(<App />);
    await logInAndSelect();
    await waitFor(() => expect(nats.subscribeToMeasurements).toHaveBeenCalledOnce());

    fireEvent.change(screen.getByLabelText(/selected device/i), { target: { value: DEVICE_TWO.id } });
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    await waitFor(() => expect(nats.subscribeToMeasurements).toHaveBeenLastCalledWith(
      DEVICE_TWO.id,
      "nats-token",
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    ));
  });

  it("ignores an older page success after a newer ordering selection", async () => {
    const stalePage = deferred<MeasurementPage>();
    const firstPageRows = Array.from({ length: PAGE_SIZE }, (_, index) => measurement(120 - index));
    api.getMeasurements.mockImplementation((_deviceId, _token, query) => {
      if (query === `limit=${PAGE_SIZE}&offset=50&order=desc`) {
        return stalePage.promise;
      }
      if (query === `limit=${PAGE_SIZE}&offset=0&order=asc`) {
        return Promise.resolve(measurementPage([measurement(900)], { total: 1, order: "asc" }));
      }
      return Promise.resolve(measurementPage(firstPageRows, { total: 120 }));
    });
    render(<App />);
    await logInAndSelect();
    await screen.findByText("Page 1 of 3");

    fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
    await waitFor(() => expect(api.getMeasurements).toHaveBeenCalledWith(
      DEVICE_ONE.id,
      "access-token",
      `limit=${PAGE_SIZE}&offset=50&order=desc`,
    ));
    fireEvent.change(screen.getByLabelText(/measurement order/i), { target: { value: "asc" } });
    await waitFor(() => expect(screen.getAllByRole("row")[1]).toHaveTextContent("900"));

    await act(async () => {
      stalePage.resolve(measurementPage([measurement(777)], { total: 120, offset: 50 }));
      await stalePage.promise;
    });

    expect(screen.getAllByRole("row")[1]).toHaveTextContent("900");
    expect(screen.getByText("Page 1 of 1")).toBeInTheDocument();
  });

  it("does not commit a stale initial A response after selecting B", async () => {
    const staleLatest = deferred<Measurement | null>();
    const staleRows = deferred<MeasurementPage>();
    api.getLatest.mockImplementation((deviceId: string) => (
      deviceId === DEVICE_ONE.id ? staleLatest.promise : Promise.resolve(measurement(20, DEVICE_TWO.id))
    ));
    api.getMeasurements.mockImplementation((deviceId: string) => (
      deviceId === DEVICE_ONE.id
        ? staleRows.promise
        : Promise.resolve(measurementPage([measurement(20, DEVICE_TWO.id)]))
    ));
    render(<App />);
    await logInAndSelect();
    await waitFor(() => expect(api.getLatest).toHaveBeenCalledWith(DEVICE_ONE.id, "access-token"));

    fireEvent.change(screen.getByLabelText(/selected device/i), { target: { value: DEVICE_TWO.id } });
    await waitFor(() => expect(screen.getByRole("heading", { name: /latest measurement/i })).toHaveTextContent("20"));

    await act(async () => {
      staleLatest.resolve(measurement(2));
      staleRows.resolve(measurementPage([measurement(1), measurement(2)]));
      await Promise.all([staleLatest.promise, staleRows.promise]);
    });

    expect(screen.getByRole("heading", { name: /latest measurement/i })).toHaveTextContent("20");
    expect(screen.getAllByRole("row")).toHaveLength(2);
  });

  it("does not append a stale A gap response after selecting B", async () => {
    const staleGap = deferred<MeasurementPage>();
    api.getLatest.mockImplementation((deviceId: string) => Promise.resolve(
      deviceId === DEVICE_ONE.id ? measurement(2) : measurement(20, DEVICE_TWO.id),
    ));
    api.getMeasurements.mockImplementation((deviceId: string, _token: string, query: string) => {
      if (deviceId === DEVICE_ONE.id && query.startsWith("after_index")) {
        return staleGap.promise;
      }
      return Promise.resolve(measurementPage(deviceId === DEVICE_ONE.id
        ? [measurement(1), measurement(2)]
        : [measurement(20, DEVICE_TWO.id)]));
    });
    render(<App />);
    await logInAndSelect();
    await waitFor(() => expect(nats.subscribeToMeasurements).toHaveBeenCalledOnce());

    notification(measurement(5));
    await waitFor(() => expect(api.getMeasurements).toHaveBeenCalledWith(
      DEVICE_ONE.id,
      "access-token",
      `after_index=2&through_index=5&limit=${PAGE_SIZE}`,
    ));
    fireEvent.change(screen.getByLabelText(/selected device/i), { target: { value: DEVICE_TWO.id } });
    await waitFor(() => expect(screen.getByRole("heading", { name: /latest measurement/i })).toHaveTextContent("20"));

    await act(async () => {
      staleGap.resolve(measurementPage(
        [measurement(3), measurement(4), measurement(5)],
        { order: "asc" },
      ));
      await staleGap.promise;
    });

    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(2));
  });

  it("ignores an older page failure after selecting a newer device", async () => {
    const stalePage = deferred<MeasurementPage>();
    const firstPageRows = Array.from({ length: PAGE_SIZE }, (_, index) => measurement(120 - index));
    api.getLatest.mockImplementation((deviceId: string) => Promise.resolve(
      deviceId === DEVICE_ONE.id ? measurement(120) : measurement(20, DEVICE_TWO.id),
    ));
    api.getMeasurements.mockImplementation((deviceId: string, _token: string, query: string) => {
      if (deviceId === DEVICE_ONE.id && query === `limit=${PAGE_SIZE}&offset=50&order=desc`) {
        return stalePage.promise;
      }
      return Promise.resolve(measurementPage(deviceId === DEVICE_ONE.id
        ? firstPageRows
        : [measurement(20, DEVICE_TWO.id)], { total: deviceId === DEVICE_ONE.id ? 120 : 1 }));
    });
    render(<App />);
    await logInAndSelect();
    await screen.findByText("Page 1 of 3");

    fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
    await waitFor(() => expect(api.getMeasurements).toHaveBeenCalledWith(
      DEVICE_ONE.id,
      "access-token",
      `limit=${PAGE_SIZE}&offset=50&order=desc`,
    ));
    fireEvent.change(screen.getByLabelText(/selected device/i), { target: { value: DEVICE_TWO.id } });
    await waitFor(() => expect(screen.getByRole("heading", { name: /latest measurement/i })).toHaveTextContent("20"));

    await act(async () => {
      stalePage.reject(new Error("stale page failed"));
      await stalePage.promise.catch(() => undefined);
    });

    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(2));
    expect(screen.queryByText(/stale page failed/i)).not.toBeInTheDocument();
  });

  it("retains the last successful page and reports a current page failure", async () => {
    const failedPage = deferred<MeasurementPage>();
    const firstPageRows = Array.from({ length: PAGE_SIZE }, (_, index) => measurement(120 - index));
    api.getMeasurements
      .mockResolvedValueOnce(measurementPage(firstPageRows, { total: 120 }))
      .mockReturnValueOnce(failedPage.promise);
    render(<App />);
    await logInAndSelect();
    await screen.findByText("Page 1 of 3");

    fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
    await act(async () => {
      failedPage.reject(new Error("measurement page unavailable"));
      await failedPage.promise.catch(() => undefined);
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("API error: measurement page unavailable");
    expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(PAGE_SIZE + 1);
    expect(screen.getAllByRole("row")[1]).toHaveTextContent("120");

    api.getMeasurements.mockClear();
    api.getMeasurements.mockResolvedValue(measurementPage(firstPageRows, { total: 120 }));
    act(() => reconnect());

    await waitFor(() => expect(api.getMeasurements).toHaveBeenCalledWith(
      DEVICE_ONE.id,
      "access-token",
      `limit=${PAGE_SIZE}&offset=0&order=desc`,
    ));
  });

  it("corrects an empty out-of-range page exactly once without committing it", async () => {
    const correctedPage = deferred<MeasurementPage>();
    const firstPageRows = Array.from({ length: PAGE_SIZE }, (_, index) => measurement(120 - index));
    let offsetZeroRequests = 0;
    api.getMeasurements.mockImplementation((_deviceId, _token, query) => {
      if (query === `limit=${PAGE_SIZE}&offset=50&order=desc`) {
        return Promise.resolve(measurementPage([], { total: 20, offset: 50 }));
      }
      offsetZeroRequests += 1;
      return offsetZeroRequests === 1
        ? Promise.resolve(measurementPage(firstPageRows, { total: 120 }))
        : correctedPage.promise;
    });
    render(<App />);
    await logInAndSelect();
    await screen.findByText("Page 1 of 3");
    api.getMeasurements.mockClear();

    fireEvent.click(screen.getByRole("button", { name: /^next$/i }));

    await waitFor(() => expect(api.getMeasurements).toHaveBeenCalledTimes(2));
    expect(api.getMeasurements).toHaveBeenNthCalledWith(
      1,
      DEVICE_ONE.id,
      "access-token",
      `limit=${PAGE_SIZE}&offset=50&order=desc`,
    );
    expect(api.getMeasurements).toHaveBeenNthCalledWith(
      2,
      DEVICE_ONE.id,
      "access-token",
      `limit=${PAGE_SIZE}&offset=0&order=desc`,
    );
    expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(PAGE_SIZE + 1);

    await act(async () => {
      correctedPage.resolve(measurementPage([measurement(20)], { total: 20 }));
      await correctedPage.promise;
    });

    expect(await screen.findByText("Page 1 of 1")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(2);
    expect(screen.getAllByRole("row")[1]).toHaveTextContent("20");
    expect(api.getMeasurements).toHaveBeenCalledTimes(2);
  });

  it("closes and ignores a late A subscription after selecting B", async () => {
    const lateSubscription = deferred<() => void>();
    const lateClose = vi.fn();
    const secondClose = vi.fn();
    let staleNotification: ((value: Measurement) => void) | undefined;
    api.getLatest.mockImplementation((deviceId: string) => Promise.resolve(
      deviceId === DEVICE_ONE.id ? measurement(2) : measurement(20, DEVICE_TWO.id),
    ));
    api.getMeasurements.mockImplementation((deviceId: string) => Promise.resolve(measurementPage(
      deviceId === DEVICE_ONE.id ? [measurement(1), measurement(2)] : [measurement(20, DEVICE_TWO.id)],
    )));
    nats.subscribeToMeasurements
      .mockImplementationOnce((_deviceId, _token, onNotification) => {
        staleNotification = onNotification;
        return lateSubscription.promise;
      })
      .mockResolvedValueOnce(secondClose);
    render(<App />);
    await logInAndSelect();
    await waitFor(() => expect(nats.subscribeToMeasurements).toHaveBeenCalledOnce());

    fireEvent.change(screen.getByLabelText(/selected device/i), { target: { value: DEVICE_TWO.id } });
    await waitFor(() => expect(nats.subscribeToMeasurements).toHaveBeenCalledTimes(2));
    await act(async () => {
      lateSubscription.resolve(lateClose);
      await lateSubscription.promise;
    });

    await waitFor(() => expect(lateClose).toHaveBeenCalledOnce());
    expect(staleNotification).toEqual(expect.any(Function));
    await act(async () => {
      staleNotification!(measurement(99));
      await Promise.resolve();
    });
    expect(screen.getByRole("heading", { name: /latest measurement/i })).toHaveTextContent("20");
  });
});
