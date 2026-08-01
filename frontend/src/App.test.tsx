import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  let deviceCreated: () => void;
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
    api.getMeasurements.mockResolvedValue(measurementPage(
      Array.from({ length: PAGE_SIZE }, (_, index) => measurement(index + 1)),
    ));
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
    const initialRows = deferred<MeasurementPage>();
    api.getLatest.mockReturnValue(initialLatest.promise);
    api.getMeasurements.mockReturnValue(initialRows.promise);
    render(<App />);
    await logInAndSelect();
    await waitFor(() => expect(nats.subscribeToMeasurements).toHaveBeenCalledOnce());

    act(() => notification(measurement(3)));
    await act(async () => {
      initialLatest.resolve(measurement(2));
      initialRows.resolve(measurementPage([measurement(1), measurement(2)]));
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
    api.getMeasurements.mockImplementation(async (_deviceId, _token, query) => measurementPage(
      query.startsWith("before_index") ? [measurement(1), measurement(2)] : [measurement(3), measurement(4)],
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

  it("does not replace B with a stale A previous page", async () => {
    const stalePage = deferred<MeasurementPage>();
    api.getLatest.mockImplementation((deviceId: string) => Promise.resolve(
      deviceId === DEVICE_ONE.id ? measurement(5) : measurement(20, DEVICE_TWO.id),
    ));
    api.getMeasurements.mockImplementation((deviceId: string, _token: string, query: string) => {
      if (deviceId === DEVICE_ONE.id && query.startsWith("before_index")) {
        return stalePage.promise;
      }
      return Promise.resolve(measurementPage(deviceId === DEVICE_ONE.id
        ? [measurement(5), measurement(6)]
        : [measurement(20, DEVICE_TWO.id)]));
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
      stalePage.resolve(measurementPage([measurement(3), measurement(4)]));
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
