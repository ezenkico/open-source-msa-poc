import { waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Measurement } from "./measurementState";

const nats = vi.hoisted(() => ({
  connect: vi.fn(),
  StringCodec: vi.fn(),
}));

vi.mock("nats.ws", () => nats);

import { subscribeToMeasurements } from "./nats";

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

function configureConnection(messages: unknown[]) {
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
    status: vi.fn().mockReturnValue(iterable([])),
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
});
