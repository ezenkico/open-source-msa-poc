# Frontend Device Provisioning Design

## Goal

Allow authorized users to create devices from the frontend, safely capture the
one-time provisioning credentials, and make device UUIDs visible wherever a
user selects or inspects a device.

The Django API remains the authorization boundary and source of truth. The
frontend capability check controls presentation only; it does not replace the
existing staff check on `POST /api/devices/`.

## Authenticated Capability Endpoint

Django will expose `GET /api/auth/me/` for authenticated users. Its response is:

```json
{
  "can_add_devices": true
}
```

`can_add_devices` is `true` exactly when `request.user.is_staff` is true. The
endpoint returns no unnecessary profile or permission data. Unauthenticated or
expired credentials continue to receive the standard authentication failure.

The frontend loads this capability with the initial authenticated device list.
It also reloads it when a device-creation request receives `403`, because that
indicates the user's authorization may have changed since sign-in.

## Frontend API Contracts

The frontend API module will add:

- `getCurrentUser(accessToken)`, returning `{ can_add_devices: boolean }`; and
- `createDevice(name, accessToken)`, posting `{ name }` to `/api/devices/` and
  returning the public device fields plus the one-time `key`.

Both responses will be runtime-validated before entering UI state. The created
device response must contain a UUID-shaped ID, a non-empty name, the public
device fields, and a non-empty provisioning key. Existing `ApiError` status
handling remains the basis for authentication and permission decisions.

## Device Provisioning Component

A focused `DeviceProvisioning` component will own the add-device form and the
transient credential presentation. It receives the access token, current
capability, and callbacks for successful creation and permission changes.

The form is rendered only when `can_add_devices` is true. It accepts a required
device name and disables repeat submission while the request is pending. On a
successful response, it clears the name input and shows a provisioning panel
containing:

- device name;
- device UUID;
- one-time provisioning key;
- separate `Copy ID` and `Copy key` buttons; and
- a warning that the key cannot be retrieved later.

The panel remains visible until explicitly dismissed. A later successful
creation replaces it with the new credentials. A failed creation does not
clear the entered name or replace an already displayed successful result.

The provisioning key exists only in the component's in-memory state. It is not
written to `localStorage`, session storage, NATS, logs, URLs, or the general
device list. Unmounting the component or ending authentication discards it.

Copy buttons use the browser Clipboard API. Copy success receives a brief
accessible confirmation. Clipboard failure leaves the value visible and
reports an accessible error so the user can copy manually.

## Device List and UUID Presentation

Every device option will display `Name — UUID`, while retaining the UUID as the
option value. After selection, the interface will also render the selected
device UUID as visible text so it can be read independently of the open
selector.

After successful creation, the frontend immediately performs an authenticated,
authoritative device-list refresh. It does not append the creation response
directly. The existing `devices.created` NATS event remains the invalidation
mechanism for other signed-in clients and provides redundant reconciliation
for the creating client.

The current selection is preserved if it remains in the authoritative list.
Creating a device does not automatically select it.

## Error and Permission Behavior

- `401` during capability loading or creation clears the persisted/current
  session through the existing logout behavior.
- `403` during creation clears the local add-device capability, hides the form,
  reloads `/api/auth/me/`, and displays that permission changed.
- Other API failures keep the form and entered name available and display an
  accessible error.
- A device-list refresh failure after successful creation does not hide or
  discard the one-time credentials. It reports the refresh error while leaving
  the provisioning panel visible.
- An invalid capability or creation response is treated as an API-contract
  error and no partial state is committed.

## Component Boundaries

- Django `CurrentUserView`: exposes the single capability derived from the
  authenticated user.
- Frontend `api.ts`: owns HTTP calls and runtime response validation.
- Frontend `DeviceProvisioning.tsx`: owns name input, submission state,
  clipboard behavior, and transient one-time credentials.
- Frontend `App.tsx`: owns authentication, capability state, authoritative
  device-list refresh, selection, and logout integration.

No unrelated frontend restructuring is included.

## Verification

Backend tests will verify authenticated staff/non-staff capability responses
and unauthenticated rejection while retaining the existing POST authorization
tests.

Frontend API tests will verify endpoint paths, request bodies, bearer headers,
runtime response validation, and status propagation.

Component tests will verify:

- the form is visible only with capability;
- pending submission cannot be repeated;
- successful creation presents name, UUID, key, warning, and dismiss action;
- copy ID/key success and failure are accessible;
- credentials are not persisted;
- failed creation retains the name and existing successful credentials;
- `401` logs out and `403` hides/reloads capability;
- successful creation triggers an authoritative list refresh without changing
  selection;
- refresh failure preserves the one-time credential panel; and
- selector options and selected-device details visibly include the UUID.

The complete Django, frontend, simulator, build, and Compose verification
commands will run after implementation.
