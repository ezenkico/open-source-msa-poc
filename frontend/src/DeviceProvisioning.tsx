import { useEffect, useRef, useState } from "react";
import { ApiError, createDevice, type CreatedDevice } from "./api";

export type DeviceProvisioningProps = {
  accessToken: string;
  canAddDevices: boolean;
  onCreated: (device: CreatedDevice) => void;
  onAuthenticationLost: () => void;
  onPermissionDenied: () => void;
};

type ClipboardStatus = {
  kind: "error" | "success";
  message: string;
};

export default function DeviceProvisioning({
  canAddDevices,
  ...props
}: DeviceProvisioningProps) {
  return canAddDevices ? <EnabledDeviceProvisioning {...props} /> : null;
}

function EnabledDeviceProvisioning({
  accessToken,
  onCreated,
  onAuthenticationLost,
  onPermissionDenied,
}: Omit<DeviceProvisioningProps, "canAddDevices">) {
  const [name, setName] = useState("");
  const [createdDevice, setCreatedDevice] = useState<CreatedDevice | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clipboardStatus, setClipboardStatus] = useState<ClipboardStatus | null>(null);
  const isMounted = useRef(true);
  const clipboardOperation = useRef(0);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
      clipboardOperation.current += 1;
    };
  }, []);

  async function submitDevice(event: { preventDefault: () => void }) {
    event.preventDefault();
    if (isSubmitting) {
      return;
    }

    setIsSubmitting(true);
    setError(null);
    let device: CreatedDevice;
    try {
      device = await createDevice(name, accessToken);
    } catch (caught) {
      if (!isMounted.current) {
        return;
      }
      setIsSubmitting(false);
      if (caught instanceof ApiError && caught.status === 401) {
        onAuthenticationLost();
      } else if (caught instanceof ApiError && caught.status === 403) {
        setError("Your device creation permission changed.");
        onPermissionDenied();
      } else {
        setError("Unable to create the device. Try again.");
      }
      return;
    }

    if (!isMounted.current) {
      return;
    }
    clipboardOperation.current += 1;
    setCreatedDevice(device);
    setName("");
    setClipboardStatus(null);
    setIsSubmitting(false);
    onCreated(device);
  }

  async function copyValue(value: string, label: "ID" | "key") {
    const operation = ++clipboardOperation.current;
    setClipboardStatus(null);
    try {
      await navigator.clipboard.writeText(value);
      if (!isMounted.current || operation !== clipboardOperation.current) {
        return;
      }
      setClipboardStatus({ kind: "success", message: `${label} copied.` });
    } catch {
      if (!isMounted.current || operation !== clipboardOperation.current) {
        return;
      }
      setClipboardStatus({
        kind: "error",
        message: `Could not copy automatically. Copy the ${label} manually.`,
      });
    }
  }

  function dismissCredentials() {
    clipboardOperation.current += 1;
    setCreatedDevice(null);
    setClipboardStatus(null);
  }

  return (
    <section aria-labelledby="device-provisioning-heading">
      <h2 id="device-provisioning-heading">Add device</h2>
      <form aria-label="Add device" onSubmit={submitDevice}>
        <label htmlFor="device-name">Device name</label>
        <input
          id="device-name"
          name="device-name"
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <button disabled={isSubmitting} type="submit">
          {isSubmitting ? "Creating device…" : "Create device"}
        </button>
      </form>

      {error && <p role="alert">{error}</p>}

      {createdDevice && (
        <section aria-labelledby="created-device-heading">
          <h3 id="created-device-heading">Device credentials</h3>
          <p>Save this key now. It cannot be retrieved later.</p>
          <dl>
            <dt>Name</dt>
            <dd>{createdDevice.name}</dd>
            <dt>ID</dt>
            <dd>{createdDevice.id}</dd>
            <dt>Key</dt>
            <dd>{createdDevice.key}</dd>
          </dl>
          <button type="button" onClick={() => void copyValue(createdDevice.id, "ID")}>
            Copy ID
          </button>
          <button type="button" onClick={() => void copyValue(createdDevice.key, "key")}>
            Copy key
          </button>
          <button type="button" onClick={dismissCredentials}>Dismiss</button>
          {clipboardStatus?.kind === "success" && <p role="status">{clipboardStatus.message}</p>}
          {clipboardStatus?.kind === "error" && <p role="alert">{clipboardStatus.message}</p>}
        </section>
      )}
    </section>
  );
}
