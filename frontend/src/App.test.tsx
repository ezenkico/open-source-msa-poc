import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App, { PAGE_SIZE } from "./App";
import type { Measurement } from "./measurementState";

const api = vi.hoisted(() => ({
  login: vi.fn(),
  getNatsToken: vi.fn(),
  listDevices: vi.fn(),
  getLatest: vi.fn(),
  getMeasurements: vi.fn(),
}));

const nats = vi.hoisted(() => ({
  subscribeToMeasurements: vi.fn(),
}));

vi.mock("./api", () => api);
vi.mock("./nats", () => nats);

const DEVICE_ONE = {
  id: "a1111111-1111-4111-8111-111111111111",
  name: "Boiler",
  enabled: true,
  created_at: "2026-07-26T12:00:00Z",
  updated_at: "2026-07-26T12:00:00Z",
};
const DEVICE_TWO = { ...DEVICE_ONE, id: "b2222222-2222-4222-8222-222222222222", name: "Pump" };

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
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function logInAndSelect(deviceId = DEVICE_ONE.id) {
  fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "reader" } });
  fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "password" } });
  fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

  await screen.findByRole("option", { name: DEVICE_ONE.name });
  fireEvent.change(screen.getByLabelText(/selected device/i), { target: { value: deviceId } });
}

describe("App", () => {
  let notification: (value: Measurement) => void;
  let reconnect: () => void;
  let close: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    close = vi.fn();
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
