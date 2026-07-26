import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
});
