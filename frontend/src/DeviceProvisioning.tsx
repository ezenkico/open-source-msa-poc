import { useLayoutEffect, useRef, useState } from "react";
import { ApiError, createDevice, type CreatedDevice } from "./api";
import { Button, Field, Panel } from "./ui";

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

  useLayoutEffect(() => {
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
    <Panel aria-labelledby="device-provisioning-heading" className="p-5">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Provisioning</p>
      <h2 className="mt-1 font-semibold text-white" id="device-provisioning-heading">Add device</h2>
      <p className="mt-1 text-xs leading-5 text-slate-500">Create credentials for a new telemetry source.</p>
      <form aria-label="Add device" className="mt-5 grid gap-4" onSubmit={submitDevice}>
        <Field htmlFor="device-name">
          Device name
        </Field>
        <input
          className="min-h-10 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 hover:border-slate-600"
          id="device-name"
          name="device-name"
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. Boiler room"
          required
          value={name}
        />
        <Button className="w-full" disabled={isSubmitting} type="submit">
          {isSubmitting ? "Creating device…" : "Create device"}
        </Button>
      </form>

      {error && (
        <p className="mt-4 rounded-lg border border-red-400/25 bg-red-500/10 px-3 py-2.5 text-sm text-red-200" role="alert">
          {error}
        </p>
      )}

      {createdDevice && (
        <Panel aria-labelledby="created-device-heading" borderTone="amber" className="mt-5 bg-slate-950/60 p-4">
          <h3 className="font-semibold text-white" id="created-device-heading">Device credentials</h3>
          <div
            aria-label="One-time credential warning"
            className="mt-3 rounded-xl border border-amber-400/30 bg-amber-400/10 px-3.5 py-3 text-sm leading-5 text-amber-100"
            role="note"
          >
            <p className="font-semibold">Save this key now. It cannot be retrieved later.</p>
            <p className="mt-1 text-xs text-amber-200/70">Dismiss only after storing both values securely.</p>
          </div>
          <dl className="mt-4 grid gap-3">
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Name</dt>
              <dd className="mt-1 select-all break-all rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 font-mono text-xs leading-5 text-slate-200">
                {createdDevice.name}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">ID</dt>
              <dd className="mt-1 select-all break-all rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 font-mono text-xs leading-5 text-slate-200">
                {createdDevice.id}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Key</dt>
              <dd className="mt-1 select-all break-all rounded-lg border border-amber-400/20 bg-slate-950 px-3 py-2 font-mono text-xs leading-5 text-amber-100">
                {createdDevice.key}
              </dd>
            </div>
          </dl>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <Button appearance="secondary" onClick={() => void copyValue(createdDevice.id, "ID")}>
              Copy ID
            </Button>
            <Button appearance="secondary" onClick={() => void copyValue(createdDevice.key, "key")}>
              Copy key
            </Button>
            <Button appearance="danger" className="col-span-2" onClick={dismissCredentials}>Dismiss</Button>
          </div>
          {clipboardStatus?.kind === "success" && (
            <p className="mt-3 rounded-lg border border-teal-400/25 bg-teal-400/10 px-3 py-2 text-sm text-teal-200" role="status">
              {clipboardStatus.message}
            </p>
          )}
          {clipboardStatus?.kind === "error" && (
            <p className="mt-3 rounded-lg border border-red-400/25 bg-red-500/10 px-3 py-2 text-sm text-red-200" role="alert">
              {clipboardStatus.message}
            </p>
          )}
        </Panel>
      )}
    </Panel>
  );
}
