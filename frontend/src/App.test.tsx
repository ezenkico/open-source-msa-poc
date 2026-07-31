import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App, { PAGE_SIZE } from "./App";
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
  getNatsToken: vi.fn(),
  listDevices: vi.fn(),
  getLatest: vi.fn(),
  getMeasurements: vi.fn(),
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function logIn() {
  fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "reader" } });
  fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "password" } });
  fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

  await screen.findByRole("option", { name: DEVICE_ONE.name });
}

async function logInAndSelect(deviceId = DEVICE_ONE.id) {
  await logIn();
  fireEvent.change(screen.getByLabelText(/selected device/i), { target: { value: deviceId } });
}

describe("App", () => {
  let notification: (value: Measurement) => void;
  let reconnect: () => void;
  let deviceCreated: () => void;
  let deviceReconnect: () => void;
  let close: ReturnType<typeof vi.fn>;
  let closeDeviceCreations: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    close = vi.fn();
    closeDeviceCreations = vi.fn();
    session.restoreAccessToken.mockReturnValue(null);
    api.login.mockResolvedValue("access-token");
    api.getNatsToken.mockResolvedValue("nats-token");
    api.listDevices.mockResolvedValue([DEVICE_ONE, DEVICE_TWO]);
    api.getLatest.mockResolvedValue(measurement(2));
    api.getMeasurements.mockResolvedValue([measurement(1), measurement(2)]);
    nats.subscribeToMeasurements.mockImplementation(
      async (_deviceId, _token, onNotification, onReconnect) => {
        notification = onNotification;
        reconnect = onReconnect;
        return close;
      },
    );
    nats.subscribeToDeviceCreations.mockImplementation(
      async (_token, onDeviceCreated, onReconnect) => {
        deviceCreated = onDeviceCreated;
        deviceReconnect = onReconnect;
        return closeDeviceCreations;
      },
    );
  });

  it("restores a valid session only after its device list is validated", async () => {
    session.restoreAccessToken.mockReturnValue("restored-token");
    api.listDevices.mockResolvedValue([DEVICE_ONE]);

    render(<App />);

    expect(screen.queryByRole("button", { name: /sign in/i })).not.toBeInTheDocument();
    expect(await screen.findByRole("option", { name: DEVICE_ONE.name })).toBeInTheDocument();
    expect(api.listDevices).toHaveBeenCalledWith("restored-token");
  });

  it("persists the access token after login and device listing succeed", async () => {
    render(<App />);

    await logInAndSelect();

    expect(session.storeAccessToken).toHaveBeenCalledWith("access-token");
  });

  it("clears a restored session rejected by the API", async () => {
    session.restoreAccessToken.mockReturnValue("rejected-token");
    api.listDevices.mockRejectedValue(new api.ApiError(401));

    render(<App />);

    expect(await screen.findByRole("button", { name: /sign in/i })).toBeInTheDocument();
    expect(session.clearAccessToken).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText(/selected device/i)).not.toBeInTheDocument();
  });

  it("does not list devices when stored access-token restoration returns null", async () => {
    session.restoreAccessToken.mockReturnValue(null);

    render(<App />);

    expect(await screen.findByRole("button", { name: /sign in/i })).toBeInTheDocument();
    expect(api.listDevices).not.toHaveBeenCalled();
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
    expect(screen.queryByRole("option", { name: DEVICE_THREE.name })).not.toBeInTheDocument();
    await waitFor(() => expect(nats.subscribeToDeviceCreations).toHaveBeenCalledOnce());

    subscriptionReady.resolve(closeDeviceCreations);

    expect(await screen.findByRole("option", { name: DEVICE_THREE.name })).toBeInTheDocument();
    expect(api.listDevices).toHaveBeenNthCalledWith(2, "access-token");
  });

  it("refreshes the authoritative device list after a creation event", async () => {
    render(<App />);
    await logIn();
    await waitFor(() => expect(nats.subscribeToDeviceCreations).toHaveBeenCalledOnce());
    api.listDevices.mockClear();
    api.listDevices.mockResolvedValue([DEVICE_ONE, DEVICE_TWO, DEVICE_THREE]);

    act(() => deviceCreated());

    expect(await screen.findByRole("option", { name: DEVICE_THREE.name })).toBeInTheDocument();
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

    expect(await screen.findByRole("option", { name: DEVICE_THREE.name })).toBeInTheDocument();
    expect(api.listDevices).toHaveBeenCalledOnce();
    expect(api.listDevices).toHaveBeenCalledWith("access-token");
  });

  it("keeps the selected device when an authoritative refresh still returns it", async () => {
    render(<App />);
    await logInAndSelect();
    await waitFor(() => expect(nats.subscribeToDeviceCreations).toHaveBeenCalledOnce());
    api.listDevices.mockResolvedValue([DEVICE_ONE, DEVICE_THREE]);

    act(() => deviceCreated());

    await screen.findByRole("option", { name: DEVICE_THREE.name });
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
    expect(await screen.findByRole("option", { name: DEVICE_THREE.name })).toBeInTheDocument();

    await act(async () => {
      older.resolve([DEVICE_TWO]);
      await older.promise;
    });
    expect(screen.getByRole("option", { name: DEVICE_THREE.name })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: DEVICE_TWO.name })).not.toBeInTheDocument();
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
    expect(await screen.findByRole("option", { name: DEVICE_THREE.name })).toBeInTheDocument();

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

  it("logs in, lists devices, and loads authoritative state for the selected device", async () => {
    render(<App />);
    await logInAndSelect();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /latest measurement/i })).toHaveTextContent("temperature");
    });
    expect(api.login).toHaveBeenCalledWith("reader", "password");
    expect(api.getMeasurements).toHaveBeenCalledWith(DEVICE_ONE.id, "access-token", `limit=${PAGE_SIZE}`);
    expect(screen.getAllByRole("row")).toHaveLength(3);
  });

  it("updates latest but leaves a full table unchanged", async () => {
    api.getMeasurements.mockResolvedValue(Array.from({ length: PAGE_SIZE }, (_, index) => measurement(index + 1)));
    api.getLatest.mockResolvedValue(measurement(PAGE_SIZE));
    render(<App />);
    await logInAndSelect();
    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(PAGE_SIZE + 1));

    notification(measurement(PAGE_SIZE + 1));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /latest measurement/i })).toHaveTextContent(String(PAGE_SIZE + 1));
    });
    expect(screen.getAllByRole("row")).toHaveLength(PAGE_SIZE + 1);
  });

  it("fetches the documented exclusive/inclusive range after a notification gap", async () => {
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
  });

  it("does not miss a notification while the initial authoritative read is pending", async () => {
    const initialLatest = deferred<Measurement | null>();
    const initialRows = deferred<Measurement[]>();
    api.getLatest.mockReturnValue(initialLatest.promise);
    api.getMeasurements.mockReturnValue(initialRows.promise);
    render(<App />);
    await logInAndSelect();
    await waitFor(() => expect(nats.subscribeToMeasurements).toHaveBeenCalledOnce());

    act(() => notification(measurement(3)));
    await act(async () => {
      initialLatest.resolve(measurement(2));
      initialRows.resolve([measurement(1), measurement(2)]);
      await Promise.all([initialLatest.promise, initialRows.promise]);
    });

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /latest measurement/i })).toHaveTextContent("3");
    });
    expect(screen.getAllByRole("row")).toHaveLength(4);
  });

  it("closes the old subscription on device changes and reloads on reconnect", async () => {
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

    reconnect();
    await waitFor(() => {
      expect(api.getLatest).toHaveBeenCalledTimes(3);
      expect(api.getMeasurements).toHaveBeenCalledTimes(3);
    });
  });

  it("loads the previous page using the first displayed index", async () => {
    api.getLatest.mockResolvedValue(measurement(4));
    api.getMeasurements.mockImplementation(async (_deviceId, _token, query) => (
      query.startsWith("before_index") ? [measurement(1), measurement(2)] : [measurement(3), measurement(4)]
    ));
    render(<App />);
    await logInAndSelect();
    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(3));

    fireEvent.click(screen.getByRole("button", { name: /previous page/i }));

    await waitFor(() => expect(api.getMeasurements).toHaveBeenCalledWith(
      DEVICE_ONE.id,
      "access-token",
      `before_index=3&limit=${PAGE_SIZE}`,
    ));
    expect(screen.getAllByRole("row")[1]).toHaveTextContent("1");
  });

  it("does not commit a stale initial A response after selecting B", async () => {
    const staleLatest = deferred<Measurement | null>();
    const staleRows = deferred<Measurement[]>();
    api.getLatest.mockImplementation((deviceId: string) => (
      deviceId === DEVICE_ONE.id ? staleLatest.promise : Promise.resolve(measurement(20, DEVICE_TWO.id))
    ));
    api.getMeasurements.mockImplementation((deviceId: string) => (
      deviceId === DEVICE_ONE.id ? staleRows.promise : Promise.resolve([measurement(20, DEVICE_TWO.id)])
    ));
    render(<App />);
    await logInAndSelect();
    await waitFor(() => expect(api.getLatest).toHaveBeenCalledWith(DEVICE_ONE.id, "access-token"));

    fireEvent.change(screen.getByLabelText(/selected device/i), { target: { value: DEVICE_TWO.id } });
    await waitFor(() => expect(screen.getByRole("heading", { name: /latest measurement/i })).toHaveTextContent("20"));

    await act(async () => {
      staleLatest.resolve(measurement(2));
      staleRows.resolve([measurement(1), measurement(2)]);
      await Promise.all([staleLatest.promise, staleRows.promise]);
    });

    expect(screen.getByRole("heading", { name: /latest measurement/i })).toHaveTextContent("20");
    expect(screen.getAllByRole("row")).toHaveLength(2);
  });

  it("does not append a stale A gap response after selecting B", async () => {
    const staleGap = deferred<Measurement[]>();
    api.getLatest.mockImplementation((deviceId: string) => Promise.resolve(
      deviceId === DEVICE_ONE.id ? measurement(2) : measurement(20, DEVICE_TWO.id),
    ));
    api.getMeasurements.mockImplementation((deviceId: string, _token: string, query: string) => {
      if (deviceId === DEVICE_ONE.id && query.startsWith("after_index")) {
        return staleGap.promise;
      }
      return Promise.resolve(deviceId === DEVICE_ONE.id
        ? [measurement(1), measurement(2)]
        : [measurement(20, DEVICE_TWO.id)]);
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
      staleGap.resolve([measurement(3), measurement(4), measurement(5)]);
      await staleGap.promise;
    });

    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(2));
  });

  it("does not replace B with a stale A previous page", async () => {
    const stalePage = deferred<Measurement[]>();
    api.getLatest.mockImplementation((deviceId: string) => Promise.resolve(
      deviceId === DEVICE_ONE.id ? measurement(5) : measurement(20, DEVICE_TWO.id),
    ));
    api.getMeasurements.mockImplementation((deviceId: string, _token: string, query: string) => {
      if (deviceId === DEVICE_ONE.id && query.startsWith("before_index")) {
        return stalePage.promise;
      }
      return Promise.resolve(deviceId === DEVICE_ONE.id
        ? [measurement(5), measurement(6)]
        : [measurement(20, DEVICE_TWO.id)]);
    });
    render(<App />);
    await logInAndSelect();
    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(3));

    fireEvent.click(screen.getByRole("button", { name: /previous page/i }));
    await waitFor(() => expect(api.getMeasurements).toHaveBeenCalledWith(
      DEVICE_ONE.id,
      "access-token",
      `before_index=5&limit=${PAGE_SIZE}`,
    ));
    fireEvent.change(screen.getByLabelText(/selected device/i), { target: { value: DEVICE_TWO.id } });
    await waitFor(() => expect(screen.getByRole("heading", { name: /latest measurement/i })).toHaveTextContent("20"));

    await act(async () => {
      stalePage.resolve([measurement(3), measurement(4)]);
      await stalePage.promise;
    });

    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(2));
  });

  it("closes and ignores a late A subscription after selecting B", async () => {
    const lateSubscription = deferred<() => void>();
    const lateClose = vi.fn();
    const secondClose = vi.fn();
    let staleNotification: ((value: Measurement) => void) | undefined;
    api.getLatest.mockImplementation((deviceId: string) => Promise.resolve(
      deviceId === DEVICE_ONE.id ? measurement(2) : measurement(20, DEVICE_TWO.id),
    ));
    api.getMeasurements.mockImplementation((deviceId: string) => Promise.resolve(
      deviceId === DEVICE_ONE.id ? [measurement(1), measurement(2)] : [measurement(20, DEVICE_TWO.id)],
    ));
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
