import { waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Device } from "./api";
import type { Measurement } from "./measurementState";

const nats = vi.hoisted(() => ({
  connect: vi.fn(),
  StringCodec: vi.fn(),
}));

vi.mock("nats.ws", () => nats);

import { subscribeToDeviceCreations, subscribeToMeasurements } from "./nats";

function device(): Device {
  return {
    id: "device-1",
    name: "Greenhouse sensor",
    enabled: true,
    created_at: "2026-07-31T12:00:00Z",
    updated_at: "2026-07-31T12:00:00Z",
  };
}

function measurement(): Measurement {
  return {
    device_id: "device-1",
    entry_index: 3,
    measurement_name: "temperature",
    value: 21.5,
    measured_at: "2026-07-26T12:00:00Z",
    received_at: "2026-07-26T12:00:01Z",
  };
}

function iterable<T>(values: T[]) {
  return {
    async *[Symbol.asyncIterator]() {
      yield* values;
    },
  };
}

function configureConnection(messages: unknown[], statuses: unknown[] = []) {
  const unsubscribe = vi.fn();
  const close = vi.fn().mockResolvedValue(undefined);
  const subscription = {
    unsubscribe,
    [Symbol.asyncIterator]: async function* () {
      for (const message of messages) {
        yield { data: new TextEncoder().encode(JSON.stringify(message)) };
      }
    },
  };
  const subscribe = vi.fn().mockReturnValue(subscription);
  nats.StringCodec.mockReturnValue({
    decode: (data: Uint8Array) => new TextDecoder().decode(data),
  });
  nats.connect.mockResolvedValue({
    subscribe,
    status: vi.fn().mockReturnValue(iterable(statuses)),
    close,
  });
  return { close, subscribe, unsubscribe };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("NATS adapter", () => {
  it("connects through /nats, subscribes to the selected device, and cleans up", async () => {
    const connection = configureConnection([measurement()]);
    const onMeasurement = vi.fn();

    const cleanup = await subscribeToMeasurements(
      "device-1",
      "nats-token",
      onMeasurement,
      vi.fn(),
      vi.fn(),
    );

    expect(nats.connect).toHaveBeenCalledWith({
      servers: [`${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/nats`],
      token: "nats-token",
    });
    expect(connection.subscribe).toHaveBeenCalledWith("devices.device-1.measurements");
    await waitFor(() => expect(onMeasurement).toHaveBeenCalledWith(measurement()));

    cleanup();

    expect(connection.unsubscribe).toHaveBeenCalledOnce();
    expect(connection.close).toHaveBeenCalledOnce();
  });

  it("rejects malformed notification payloads before they reach the UI", async () => {
    configureConnection([{ ...measurement(), value: "not-a-number" }]);
    const onMeasurement = vi.fn();
    const onError = vi.fn();

    await subscribeToMeasurements("device-1", "nats-token", onMeasurement, vi.fn(), onError);

    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: "Received an invalid measurement notification",
    })));
    expect(onMeasurement).not.toHaveBeenCalled();
  });

  it("subscribes to device creations and signals a valid notification", async () => {
    const connection = configureConnection([device()]);
    const onDeviceCreated = vi.fn();

    await subscribeToDeviceCreations(
      "nats-token",
      onDeviceCreated,
      vi.fn(),
      vi.fn(),
    );

    expect(connection.subscribe).toHaveBeenCalledWith("devices.created");
    await waitFor(() => expect(onDeviceCreated).toHaveBeenCalledOnce());
    expect(onDeviceCreated).toHaveBeenCalledWith();
  });

  it("reports an invalid device-created notification without signaling the UI", async () => {
    configureConnection([{ ...device(), enabled: "yes" }]);
    const onDeviceCreated = vi.fn();
    const onError = vi.fn();

    await subscribeToDeviceCreations(
      "nats-token",
      onDeviceCreated,
      vi.fn(),
      onError,
    );

    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: "Received an invalid device-created notification",
    })));
    expect(onDeviceCreated).not.toHaveBeenCalled();
  });

  it("signals reconnection and closes the device-created subscription", async () => {
    const connection = configureConnection([], [{ type: "reconnect" }]);
    const onReconnect = vi.fn();

    const cleanup = await subscribeToDeviceCreations(
      "nats-token",
      vi.fn(),
      onReconnect,
      vi.fn(),
    );

    await waitFor(() => expect(onReconnect).toHaveBeenCalledOnce());

    cleanup();

    expect(connection.unsubscribe).toHaveBeenCalledOnce();
    expect(connection.close).toHaveBeenCalledOnce();
  });
});
