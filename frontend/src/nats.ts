import { connect, DebugEvents, Events, StringCodec } from "nats.ws";
import type { Device } from "./api";
import type { Measurement } from "./measurementState";

type OnMeasurement = (measurement: Measurement) => void;
type OnDeviceCreated = () => void;
export type NatsLifecycleStatus = Events.Disconnect | DebugEvents.Reconnecting | Events.Reconnect;
type OnLifecycle = (status: NatsLifecycleStatus) => void;
type OnError = (error: Error) => void;

function isMeasurement(value: unknown): value is Measurement {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.device_id === "string"
    && typeof candidate.entry_index === "number"
    && typeof candidate.measurement_name === "string"
    && typeof candidate.value === "number"
    && typeof candidate.measured_at === "string"
    && typeof candidate.received_at === "string";
}

function isDevice(value: unknown): value is Device {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string"
    && typeof candidate.name === "string"
    && typeof candidate.enabled === "boolean"
    && typeof candidate.created_at === "string"
    && typeof candidate.updated_at === "string";
}

export async function subscribeToMeasurements(
  deviceId: string,
  token: string,
  onMeasurement: OnMeasurement,
  onLifecycle: OnLifecycle,
  onError: OnError,
): Promise<() => void> {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  const server = `${scheme}://${window.location.host}/nats`;
  const connection = await connect({ servers: [server], token });
  const subscription = connection.subscribe(`devices.${deviceId}.measurements`);
  const codec = StringCodec();
  let closed = false;

  void (async () => {
    try {
      for await (const message of subscription) {
        const decoded: unknown = JSON.parse(codec.decode(message.data));
        if (!isMeasurement(decoded)) {
          throw new Error("Received an invalid measurement notification");
        }
        onMeasurement(decoded);
      }
    } catch (error) {
      if (!closed) {
        onError(error instanceof Error ? error : new Error("NATS subscription failed"));
      }
    }
  })();

  void (async () => {
    try {
      for await (const status of connection.status()) {
        if (
          status.type === Events.Disconnect
          || status.type === DebugEvents.Reconnecting
          || status.type === Events.Reconnect
        ) {
          onLifecycle(status.type);
        }
      }
    } catch (error) {
      if (!closed) {
        onError(error instanceof Error ? error : new Error("NATS connection failed"));
      }
    }
  })();

  return () => {
    closed = true;
    subscription.unsubscribe();
    void connection.close();
  };
}

export async function subscribeToDeviceCreations(
  token: string,
  onDeviceCreated: OnDeviceCreated,
  onLifecycle: OnLifecycle,
  onError: OnError,
): Promise<() => void> {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  const server = `${scheme}://${window.location.host}/nats`;
  const connection = await connect({ servers: [server], token });
  const subscription = connection.subscribe("devices.created");
  await connection.flush();
  const codec = StringCodec();
  let closed = false;

  void (async () => {
    try {
      for await (const message of subscription) {
        const decoded: unknown = JSON.parse(codec.decode(message.data));
        if (!isDevice(decoded)) {
          throw new Error("Received an invalid device-created notification");
        }
        onDeviceCreated();
      }
    } catch (error) {
      if (!closed) {
        onError(error instanceof Error ? error : new Error("NATS subscription failed"));
      }
    }
  })();

  void (async () => {
    try {
      for await (const status of connection.status()) {
        if (
          status.type === Events.Disconnect
          || status.type === DebugEvents.Reconnecting
          || status.type === Events.Reconnect
        ) {
          onLifecycle(status.type);
        }
      }
    } catch (error) {
      if (!closed) {
        onError(error instanceof Error ? error : new Error("NATS connection failed"));
      }
    }
  })();

  return () => {
    closed = true;
    subscription.unsubscribe();
    void connection.close();
  };
}
