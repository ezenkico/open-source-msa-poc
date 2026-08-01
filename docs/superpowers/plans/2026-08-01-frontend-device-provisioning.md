# Frontend Device Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let staff users create devices in the frontend, safely copy the one-time device credentials, and see device UUIDs in the selector and selected-device details.

**Architecture:** A new authenticated capability endpoint tells the frontend whether to render provisioning controls while the existing staff-only POST remains authoritative. A focused React component owns transient credentials and clipboard behavior; `App` owns authentication, capability state, authoritative list refresh, and selection.

**Tech Stack:** Python 3.11, Django 5/DRF, React 19, TypeScript, Fetch API, Clipboard API, Vitest, Testing Library.

## Global Constraints

- Preserve the user's current uncommitted `.gitignore`, `django/devices/views.py`, and `iot-device-sim.py` edits; never stage or commit them.
- Keep the existing staff check on `POST /api/devices/` as the security boundary.
- Persist neither provisioning keys nor NATS tokens in browser storage, URLs, logs, or device-list state.
- Treat created credentials as transient component state that disappears on dismissal, unmount, or logout.
- Refresh the authoritative device list after creation; do not append the creation response directly.
- Do not automatically select a newly created device.
- Display devices as `Name — UUID` and render the selected UUID separately.
- Do not add dependencies or perform unrelated frontend restructuring.

---

### Task 1: Authenticated Device-Creation Capability

**Files:**
- Create: `django/devices/auth_views.py`
- Create: `django/devices/tests/test_current_user.py`
- Modify: `django/devices/urls.py`

**Interfaces:**
- Produces: authenticated `GET /api/auth/me/` returning exactly `{ "can_add_devices": request.user.is_staff }`.
- Avoids: `django/devices/views.py`, which contains an unrelated user debug edit.

- [ ] **Step 1: Write failing capability endpoint tests**

Create `CurrentUserCapabilityTests(APITestCase)` with staff and non-staff users:

```python
def test_staff_can_add_devices(self):
    self.client.force_authenticate(self.staff)
    response = self.client.get("/api/auth/me/")
    self.assertEqual(response.status_code, 200)
    self.assertEqual(response.data, {"can_add_devices": True})

def test_non_staff_cannot_add_devices(self):
    self.client.force_authenticate(self.user)
    response = self.client.get("/api/auth/me/")
    self.assertEqual(response.status_code, 200)
    self.assertEqual(response.data, {"can_add_devices": False})

def test_unauthenticated_request_is_rejected(self):
    response = self.client.get("/api/auth/me/")
    self.assertEqual(response.status_code, 401)
```

- [ ] **Step 2: Run the endpoint tests and verify RED**

Run:

```bash
docker compose up -d postgres django
docker compose exec -T django python manage.py test devices.tests.test_current_user --keepdb -v 2
```

Expected: all new requests return 404 because the endpoint is absent.

- [ ] **Step 3: Implement the focused view and URL**

Create `auth_views.py`:

```python
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView


class CurrentUserView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response({"can_add_devices": request.user.is_staff})
```

Import it in `devices/urls.py` and add `path("auth/me/", CurrentUserView.as_view())` before the device paths.

- [ ] **Step 4: Run endpoint and provisioning tests and verify GREEN**

Run:

```bash
docker compose exec -T django python manage.py test \
  devices.tests.test_current_user devices.tests.test_provisioning --keepdb -v 2
```

Expected: all tests pass, including existing staff-only creation tests.

- [ ] **Step 5: Commit only capability files**

```bash
git add django/devices/auth_views.py django/devices/tests/test_current_user.py django/devices/urls.py
git commit -m "feat: expose device creation capability"
```

### Task 2: Frontend Capability and Creation API

**Files:**
- Modify: `frontend/src/api.ts`
- Modify: `frontend/src/api.test.ts`

**Interfaces:**
- Produces: `CurrentUser = { can_add_devices: boolean }`.
- Produces: `CreatedDevice = Device & { key: string }`.
- Produces: `getCurrentUser(accessToken: string): Promise<CurrentUser>`.
- Produces: `createDevice(name: string, accessToken: string): Promise<CreatedDevice>`.

- [ ] **Step 1: Write failing API request tests**

Add tests asserting:

```typescript
await getCurrentUser("token");
expect(fetch).toHaveBeenCalledWith("/api/auth/me/", {
  headers: { Authorization: "Bearer token" },
});

await createDevice("Boiler", "token");
expect(fetch).toHaveBeenCalledWith("/api/devices/", {
  method: "POST",
  headers: {
    Authorization: "Bearer token",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ name: "Boiler" }),
});
```

Use a valid created response containing UUID `a1111111-1111-4111-8111-111111111111`, all existing public fields, and non-empty `key`.

- [ ] **Step 2: Write failing response-validation tests**

Table-test invalid capability values (missing/non-boolean `can_add_devices`) and invalid created devices (non-UUID ID, empty name, missing public field, empty/missing key). Each call must reject with a specific contract error and return no partial value. Retain an explicit `403` test proving `ApiError.status === 403`.

- [ ] **Step 3: Run API tests and verify RED**

Run: `cd frontend && npm test -- src/api.test.ts`

Expected: imports fail because the new types/functions do not exist.

- [ ] **Step 4: Implement runtime validators and requests**

Add private `parseCurrentUser(value: unknown): CurrentUser`, `parseDevice(value: unknown): Device`, and `parseCreatedDevice(value: unknown): CreatedDevice`. Require a canonical UUID-shaped string using a case-insensitive UUID regex, non-empty strings, boolean `enabled`, and string timestamps. Use the shared `request` helper:

```typescript
export async function getCurrentUser(accessToken: string): Promise<CurrentUser> {
  const response = await request("/api/auth/me/", { headers: bearer(accessToken) });
  return parseCurrentUser(await response.json());
}

export async function createDevice(name: string, accessToken: string): Promise<CreatedDevice> {
  const response = await request("/api/devices/", {
    method: "POST",
    headers: { ...bearer(accessToken), "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return parseCreatedDevice(await response.json());
}
```

- [ ] **Step 5: Run API tests and full frontend type check**

Run:

```bash
cd frontend
npm test -- src/api.test.ts
npm run build
```

Expected: API tests and build pass.

- [ ] **Step 6: Commit API contracts**

```bash
git add frontend/src/api.ts frontend/src/api.test.ts
git commit -m "feat: add device provisioning API client"
```

### Task 3: Transient Device Provisioning Component

**Files:**
- Create: `frontend/src/DeviceProvisioning.tsx`
- Create: `frontend/src/DeviceProvisioning.test.tsx`

**Interfaces:**
- Consumes: `createDevice` and `ApiError` from `api.ts`.
- Produces:

```typescript
type DeviceProvisioningProps = {
  accessToken: string;
  canAddDevices: boolean;
  onCreated: (device: CreatedDevice) => void;
  onAuthenticationLost: () => void;
  onPermissionDenied: () => void;
};
```

- [ ] **Step 1: Write failing visibility and submission tests**

Mock `createDevice`. Verify no form when `canAddDevices` is false. When true, submit a required name and assert `createDevice("Boiler", "access-token")`; while pending, the submit button is disabled and a second click does not submit again.

- [ ] **Step 2: Write failing one-time credential tests**

Resolve a valid `CreatedDevice` and assert the panel shows name, UUID, key, exact warning `Save this key now. It cannot be retrieved later.`, separate `Copy ID`, `Copy key`, and `Dismiss` buttons. Assert `onCreated` receives the device, the name input clears, dismissal removes credentials, and no `localStorage`/`sessionStorage` write occurs.

- [ ] **Step 3: Write failing clipboard and error tests**

Stub `navigator.clipboard.writeText`. Verify each copy button sends only its corresponding value and shows an accessible success status. Reject the clipboard promise and assert the value remains visible with an accessible manual-copy error.

For API errors, verify:

```typescript
new ApiError(401) -> onAuthenticationLost()
new ApiError(403) -> onPermissionDenied() and "Your device creation permission changed."
new ApiError(500) -> keeps entered name and existing successful credential panel
```

Also assert a failed second creation does not replace the prior successful credentials.

- [ ] **Step 4: Run component tests and verify RED**

Run: `cd frontend && npm test -- src/DeviceProvisioning.test.tsx`

Expected: module import fails because the component does not exist.

- [ ] **Step 5: Implement the component**

Use local state for `name`, `createdDevice`, `isSubmitting`, `error`, and clipboard status. Return `null` when capability is false; this unmount behavior ensures credentials disappear when permission/authentication ends. Use accessible `role="alert"` for errors and `role="status"` for copy confirmation. Catch clipboard and API errors separately. Call `onCreated` only after committing a fully validated successful response.

- [ ] **Step 6: Run component tests and frontend build**

Run:

```bash
cd frontend
npm test -- src/DeviceProvisioning.test.tsx
npm run build
```

Expected: component tests and build pass.

- [ ] **Step 7: Commit the component**

```bash
git add frontend/src/DeviceProvisioning.tsx frontend/src/DeviceProvisioning.test.tsx
git commit -m "feat: add device provisioning component"
```

### Task 4: Integrate Capability, Creation Refresh, and UUID Presentation

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/App.test.tsx`

**Interfaces:**
- Consumes: `getCurrentUser`, `CurrentUser`, `CreatedDevice`, and `DeviceProvisioning`.
- Produces: capability-aware authenticated UI, authoritative post-create refresh, and visible UUIDs.

- [ ] **Step 1: Write failing startup/login capability tests**

Add `getCurrentUser` and `DeviceProvisioning` to existing mocks. Assert restored-session and interactive-login flows load devices and capability together before showing authenticated controls. A `401` from either call logs out; a transient capability error reports an API error without storing/committing a new interactive-login token.

- [ ] **Step 2: Write failing provisioning integration tests**

Capture the mocked component callbacks and verify:

- it receives current `accessToken` and `canAddDevices`;
- `onCreated` calls the existing race-safe authoritative device refresh;
- the returned creation object is not appended directly;
- selected device remains selected after refresh;
- a failed refresh reports its error without unmounting the provisioning component, allowing its internal credential panel to remain;
- `onAuthenticationLost` invokes the existing logout reset; and
- `onPermissionDenied` sets capability false immediately, calls `getCurrentUser` again, and shows the permission-changed message.

- [ ] **Step 3: Write failing UUID presentation tests**

Assert each option has text `Boiler — a1111111-1111-4111-8111-111111111111`. After selection, assert visible text labeled `Device ID` contains the UUID. Assert no selected-ID text when the placeholder is selected.

- [ ] **Step 4: Run App tests and verify RED**

Run: `cd frontend && npm test -- src/App.test.tsx`

Expected: capability calls, provisioning component, refresh callback, and UUID presentation are absent.

- [ ] **Step 5: Implement capability-aware authentication**

Add `canAddDevices` state. For startup and interactive login, load:

```typescript
const [listedDevices, currentUser] = await Promise.all([
  listDevices(token),
  getCurrentUser(token),
]);
```

Commit authenticated state only after both succeed. Reset capability to false in `logout`. Preserve existing authentication and request generations.

- [ ] **Step 6: Integrate provisioning callbacks**

Render `DeviceProvisioning` only inside authenticated UI. `onCreated` invokes `refreshDevices(accessToken, authenticationGeneration.current)` and does not select/append. `onPermissionDenied` first sets capability false and reports the change, then reloads `getCurrentUser` for the matching authentication generation; a reload `401` logs out and other failures retain false capability with an error.

- [ ] **Step 7: Add UUID presentation**

Render option content as `{device.name} — {device.id}`. Resolve the selected device from `devices` and render:

```tsx
{selectedDevice && <p><strong>Device ID:</strong> {selectedDevice.id}</p>}
```

- [ ] **Step 8: Run App tests, full frontend suite, and build**

Run:

```bash
cd frontend
npm test -- src/App.test.tsx
npm test
npm run build
```

Expected: all tests and build pass without changing measurement/NATS behavior.

- [ ] **Step 9: Commit integration**

```bash
git add frontend/src/App.tsx frontend/src/App.test.tsx
git commit -m "feat: provision devices from frontend"
```

### Task 5: Full Verification

**Files:**
- Verify only; do not change unrelated user files.

**Interfaces:**
- Confirms the complete backend/frontend contract and existing system behavior.

- [ ] **Step 1: Run backend verification**

```bash
docker compose up -d postgres django
docker compose exec -T django python manage.py test --keepdb -v 2
docker compose exec -T django python manage.py check
docker compose exec -T django python manage.py makemigrations --check
```

Expected: all Django tests pass, checks report no issues, and no migration changes exist.

- [ ] **Step 2: Run frontend verification**

```bash
cd frontend
npm test
npm run build
```

Expected: all Vitest tests and the production build pass.

- [ ] **Step 3: Run simulator and deployment contracts**

```bash
.venv/bin/python -m unittest tests.test_iot_device_sim -v
sh scripts/test-compose.sh
sh -n get-issuer-key.sh
docker compose config --quiet
```

Expected: all commands exit zero.

- [ ] **Step 4: Inspect scope and user changes**

Run `git diff --check`, `git status --short`, and `git log --oneline -8`. Confirm the user's pre-existing `.gitignore`, `django/devices/views.py`, and `iot-device-sim.py` changes remain uncommitted and unchanged by this implementation.
