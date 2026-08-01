import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type CreatedDevice } from "./api";
import DeviceProvisioning from "./DeviceProvisioning";

const api = vi.hoisted(() => ({
  createDevice: vi.fn(),
}));

const reactLifecycle = vi.hoisted(() => ({
  deferPassiveCleanup: false,
  deferredCleanups: [] as Array<() => unknown>,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const useEffect: typeof actual.useEffect = (setup, dependencies) => actual.useEffect(() => {
    const cleanup = setup();
    return () => {
      if (typeof cleanup !== "function") {
        return;
      }
      if (reactLifecycle.deferPassiveCleanup) {
        reactLifecycle.deferredCleanups.push(cleanup);
      } else {
        cleanup();
      }
    };
  }, dependencies);
  return { ...actual, useEffect };
});

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  createDevice: api.createDevice,
}));

const CREATED_DEVICE: CreatedDevice = {
  id: "a1111111-1111-4111-8111-111111111111",
  name: "Boiler",
  enabled: true,
  created_at: "2026-08-01T12:00:00Z",
  updated_at: "2026-08-01T12:00:00Z",
  key: "one-time-provisioning-key",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function renderProvisioning(canAddDevices = true) {
  const onCreated = vi.fn();
  const onAuthenticationLost = vi.fn();
  const onPermissionDenied = vi.fn();
  const view = render(
    <DeviceProvisioning
      accessToken="access-token"
      canAddDevices={canAddDevices}
      onCreated={onCreated}
      onAuthenticationLost={onAuthenticationLost}
      onPermissionDenied={onPermissionDenied}
    />,
  );

  return { onAuthenticationLost, onCreated, onPermissionDenied, ...view };
}

function enterNameAndSubmit(name: string) {
  fireEvent.change(screen.getByLabelText(/device name/i), { target: { value: name } });
  fireEvent.click(screen.getByRole("button", { name: /create device/i }));
}

async function createAndShowCredentials() {
  api.createDevice.mockResolvedValueOnce(CREATED_DEVICE);
  enterNameAndSubmit(CREATED_DEVICE.name);
  await screen.findByText(CREATED_DEVICE.key);
}

describe("DeviceProvisioning", () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    reactLifecycle.deferPassiveCleanup = false;
    reactLifecycle.deferredCleanups.splice(0).forEach((cleanup) => cleanup());
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  it("does not render the form without device-creation capability", () => {
    renderProvisioning(false);

    expect(screen.queryByRole("form")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/device name/i)).not.toBeInTheDocument();
  });

  it("discards credentials when capability is lost", async () => {
    const callbacks = renderProvisioning();
    await createAndShowCredentials();

    callbacks.rerender(
      <DeviceProvisioning
        accessToken="access-token"
        canAddDevices={false}
        onCreated={callbacks.onCreated}
        onAuthenticationLost={callbacks.onAuthenticationLost}
        onPermissionDenied={callbacks.onPermissionDenied}
      />,
    );
    expect(screen.queryByText(CREATED_DEVICE.key)).not.toBeInTheDocument();

    callbacks.rerender(
      <DeviceProvisioning
        accessToken="access-token"
        canAddDevices
        onCreated={callbacks.onCreated}
        onAuthenticationLost={callbacks.onAuthenticationLost}
        onPermissionDenied={callbacks.onPermissionDenied}
      />,
    );
    expect(screen.queryByText(CREATED_DEVICE.key)).not.toBeInTheDocument();
  });

  it("ignores a pending creation result after capability is lost", async () => {
    const pending = deferred<CreatedDevice>();
    api.createDevice.mockReturnValueOnce(pending.promise);
    const callbacks = renderProvisioning();
    enterNameAndSubmit("Boiler");

    callbacks.rerender(
      <DeviceProvisioning
        accessToken="access-token"
        canAddDevices={false}
        onCreated={callbacks.onCreated}
        onAuthenticationLost={callbacks.onAuthenticationLost}
        onPermissionDenied={callbacks.onPermissionDenied}
      />,
    );
    await act(async () => {
      pending.resolve(CREATED_DEVICE);
      await pending.promise;
    });

    expect(callbacks.onCreated).not.toHaveBeenCalled();
    callbacks.rerender(
      <DeviceProvisioning
        accessToken="access-token"
        canAddDevices
        onCreated={callbacks.onCreated}
        onAuthenticationLost={callbacks.onAuthenticationLost}
        onPermissionDenied={callbacks.onPermissionDenied}
      />,
    );
    expect(screen.queryByText(CREATED_DEVICE.key)).not.toBeInTheDocument();
  });

  it("invalidates a pending creation before deferred passive cleanup runs", async () => {
    const pending = deferred<CreatedDevice>();
    api.createDevice.mockReturnValueOnce(pending.promise);
    reactLifecycle.deferPassiveCleanup = true;

    try {
      const callbacks = renderProvisioning();
      enterNameAndSubmit("Boiler");
      callbacks.rerender(
        <DeviceProvisioning
          accessToken="access-token"
          canAddDevices={false}
          onCreated={callbacks.onCreated}
          onAuthenticationLost={callbacks.onAuthenticationLost}
          onPermissionDenied={callbacks.onPermissionDenied}
        />,
      );

      await act(async () => {
        pending.resolve(CREATED_DEVICE);
        await pending.promise;
      });

      expect(callbacks.onCreated).not.toHaveBeenCalled();
    } finally {
      reactLifecycle.deferPassiveCleanup = false;
      reactLifecycle.deferredCleanups.splice(0).forEach((cleanup) => cleanup());
    }
  });

  it("submits the required name once and disables repeat submission while pending", () => {
    const pending = deferred<CreatedDevice>();
    api.createDevice.mockReturnValueOnce(pending.promise);
    renderProvisioning();

    const nameInput = screen.getByLabelText(/device name/i);
    expect(nameInput).toBeRequired();
    fireEvent.change(nameInput, { target: { value: "Boiler" } });

    const submit = screen.getByRole("button", { name: /create device/i });
    fireEvent.click(submit);
    expect(submit).toBeDisabled();
    fireEvent.click(submit);

    expect(api.createDevice).toHaveBeenCalledOnce();
    expect(api.createDevice).toHaveBeenCalledWith("Boiler", "access-token");
  });

  it("shows one-time credentials without persisting them and dismisses them", async () => {
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    const { onCreated } = renderProvisioning();

    await createAndShowCredentials();

    expect(screen.getByText(CREATED_DEVICE.name)).toBeInTheDocument();
    expect(screen.getByText(CREATED_DEVICE.id)).toBeInTheDocument();
    expect(screen.getByText(CREATED_DEVICE.key)).toBeInTheDocument();
    expect(screen.getByText("Save this key now. It cannot be retrieved later.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy ID" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy key" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    expect(screen.getByLabelText(/device name/i)).toHaveValue("");
    expect(onCreated).toHaveBeenCalledOnce();
    expect(onCreated).toHaveBeenCalledWith(CREATED_DEVICE);
    expect(storageWrite).not.toHaveBeenCalled();

    const warning = screen.getByRole("note", { name: "One-time credential warning" });
    expect(warning).toHaveTextContent("Save this key now. It cannot be retrieved later.");

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(screen.queryByText(CREATED_DEVICE.id)).not.toBeInTheDocument();
    expect(screen.queryByText(CREATED_DEVICE.key)).not.toBeInTheDocument();
  });

  it("copies the ID and key separately with an accessible success status", async () => {
    renderProvisioning();
    await createAndShowCredentials();

    fireEvent.click(screen.getByRole("button", { name: "Copy ID" }));
    await waitFor(() => expect(writeText).toHaveBeenNthCalledWith(1, CREATED_DEVICE.id));
    expect(screen.getByRole("status")).toHaveTextContent(/ID copied/i);

    fireEvent.click(screen.getByRole("button", { name: "Copy key" }));
    await waitFor(() => expect(writeText).toHaveBeenNthCalledWith(2, CREATED_DEVICE.key));
    expect(screen.getByRole("status")).toHaveTextContent(/key copied/i);
  });

  it("keeps credentials visible and reports an accessible manual-copy error", async () => {
    writeText.mockRejectedValueOnce(new Error("clipboard denied"));
    renderProvisioning();
    await createAndShowCredentials();

    fireEvent.click(screen.getByRole("button", { name: "Copy key" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/copy the key manually/i);
    expect(screen.getByText(CREATED_DEVICE.id)).toBeInTheDocument();
    expect(screen.getByText(CREATED_DEVICE.key)).toBeInTheDocument();
  });

  it("ignores clipboard feedback for credentials that have been replaced", async () => {
    const pendingCopy = deferred<void>();
    writeText.mockReturnValueOnce(pendingCopy.promise);
    renderProvisioning();
    await createAndShowCredentials();
    fireEvent.click(screen.getByRole("button", { name: "Copy key" }));

    const replacement = {
      ...CREATED_DEVICE,
      id: "b2222222-2222-4222-8222-222222222222",
      name: "Pump",
      key: "replacement-provisioning-key",
    };
    api.createDevice.mockResolvedValueOnce(replacement);
    enterNameAndSubmit(replacement.name);
    await screen.findByText(replacement.key);

    await act(async () => {
      pendingCopy.resolve();
      await pendingCopy.promise;
    });

    expect(writeText).toHaveBeenCalledWith(CREATED_DEVICE.key);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText(replacement.key)).toBeInTheDocument();
  });

  it("reports authentication loss after a 401 response", async () => {
    api.createDevice.mockRejectedValueOnce(new ApiError(401));
    const { onAuthenticationLost, onCreated } = renderProvisioning();

    enterNameAndSubmit("Boiler");

    await waitFor(() => expect(onAuthenticationLost).toHaveBeenCalledOnce());
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("reports changed permission after a 403 response", async () => {
    api.createDevice.mockRejectedValueOnce(new ApiError(403));
    const { onPermissionDenied, onCreated } = renderProvisioning();

    enterNameAndSubmit("Boiler");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your device creation permission changed.",
    );
    expect(onPermissionDenied).toHaveBeenCalledOnce();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("retains the entered name and prior credentials when a later creation fails", async () => {
    const { onCreated } = renderProvisioning();
    await createAndShowCredentials();
    api.createDevice.mockRejectedValueOnce(new ApiError(500));

    enterNameAndSubmit("Pump");

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByLabelText(/device name/i)).toHaveValue("Pump");
    expect(screen.getByText(CREATED_DEVICE.name)).toBeInTheDocument();
    expect(screen.getByText(CREATED_DEVICE.id)).toBeInTheDocument();
    expect(screen.getByText(CREATED_DEVICE.key)).toBeInTheDocument();
    expect(onCreated).toHaveBeenCalledOnce();
    expect(onCreated).toHaveBeenCalledWith(CREATED_DEVICE);
  });
});
