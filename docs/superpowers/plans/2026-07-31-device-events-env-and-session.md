# Device Events, Simulator Environment, and Persistent Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Document account-key setup, load simulator device credentials from `.env`, refresh browser device lists from a `devices.created` NATS event, and restore valid access tokens from `localStorage`.

**Architecture:** Django publishes a best-effort post-commit invalidation event while its API remains authoritative. The frontend keeps a global device-event subscription beside its selected-device measurement subscription, and session-storage logic is isolated in a small module that checks JWT expiration before API validation.

**Tech Stack:** Python 3.11, Django 5/DRF, `nats.py`, React 19, TypeScript, `nats.ws`, Vitest, Testing Library, unittest.

## Global Constraints

- Preserve all pre-existing uncommitted user changes and do not rewrite unrelated files.
- Do not add a dotenv dependency; parse the repository `.env` locally.
- Process environment overrides `.env`; CLI options override both.
- PostgreSQL and authenticated Django APIs remain authoritative.
- NATS publishing remains post-commit and best effort.
- Never place device keys, passwords, or NATS tokens in events or browser storage.
- Persist only the access token, and never extend its configured 30-day lifetime.

---

### Task 1: Simulator `.env` Credentials

**Files:**
- Modify: `tests/test_iot_device_sim.py`
- Modify: `iot-device-sim.py`

**Interfaces:**
- Produces: `load_dotenv(path: Path, environ: MutableMapping[str, str]) -> None`, which fills only missing environment keys.
- Produces: CLI resolution where `--device-id`/`--key` override `DEVICE_ID`/`DEVICE_KEY`.

- [ ] **Step 1: Write failing parser tests**

Add tests using a temporary `.env` and patched `os.environ`/`sys.argv` that prove:

```python
def test_load_dotenv_accepts_comments_export_and_quotes_without_overwriting_environment(self):
    # file contains DEVICE_ID=file-id, export DEVICE_KEY="file-key", comments
    # existing environ DEVICE_ID=process-id remains process-id
    # DEVICE_KEY becomes file-key

def test_main_uses_dotenv_device_credentials(self):
    # patch load_dotenv to provide DEVICE_ID and DEVICE_KEY, invoke main without
    # credential flags, and assert send_measurement receives decoded key bytes

def test_cli_device_credentials_override_environment(self):
    # provide both sources and assert CLI values reach send_measurement

def test_main_reports_missing_device_credentials(self):
    # no CLI or environment values; assert argparse exits with a message naming
    # --device-id/DEVICE_ID and --key/DEVICE_KEY without printing a key
```

- [ ] **Step 2: Run the simulator tests and verify RED**

Run: `python3 -m unittest tests.test_iot_device_sim -v`

Expected: new tests fail because `.env` loading and environment defaults do not exist.

- [ ] **Step 3: Implement minimal `.env` loading and precedence**

In `iot-device-sim.py`, import `os`, `shlex`, `Path`, and `MutableMapping`. Implement a line parser that ignores blank/comment lines, strips an optional `export ` prefix, splits once on `=`, uses `shlex` to unquote a single value, and calls `environ.setdefault(name, value)`. At the start of `main`, load `Path(__file__).resolve().parent / ".env"` when present.

Define credential flags with environment defaults and readable requirements:

```python
parser.add_argument("--device-id", default=os.environ.get("DEVICE_ID"))
parser.add_argument("--key", default=os.environ.get("DEVICE_KEY"), help="Base64 provisioning key")
# after parse_args:
if not args.device_id:
    parser.error("--device-id or DEVICE_ID is required")
if not args.key:
    parser.error("--key or DEVICE_KEY is required")
```

Convert base64 decoding failures into `parser.error("--key/DEVICE_KEY must be valid base64")` so traceback and secret values are not printed.

- [ ] **Step 4: Run simulator tests and verify GREEN**

Run: `python3 -m unittest tests.test_iot_device_sim -v`

Expected: all simulator tests pass.

- [ ] **Step 5: Commit the simulator change**

```bash
git add iot-device-sim.py tests/test_iot_device_sim.py
git commit -m "feat: load simulator credentials from dotenv"
```

### Task 2: Post-Commit Device-Created Event

**Files:**
- Modify: `django/devices/tests/test_nats.py`
- Modify: `django/devices/tests/test_provisioning.py`
- Modify: `django/devices/nats.py`
- Modify: `django/devices/views.py`

**Interfaces:**
- Produces: `DEVICE_CREATED_SUBJECT = "devices.created"`.
- Produces: `device_created_payload(device: Device) -> bytes` containing `DeviceSerializer(device).data` only.
- Produces: `publish_device_created_best_effort(device_id: UUID) -> None`.

- [ ] **Step 1: Write failing event unit tests**

Extend `test_nats.py` with a device-created payload test and best-effort failure test:

```python
def test_device_created_payload_contains_only_public_device_fields(self):
    payload = json.loads(device_created_payload(self.device))
    self.assertEqual(payload, DeviceSerializer(self.device).data)
    self.assertNotIn("key", payload)
    self.assertNotIn("key_ciphertext", payload)
    self.assertNotIn("key_nonce", payload)

@patch("devices.nats._publish", new_callable=AsyncMock)
def test_device_created_publish_failure_is_silently_swallowed(self, publish):
    publish.side_effect = RuntimeError("unavailable")
    self.assertIsNone(publish_device_created_best_effort(self.device.id))
```

- [ ] **Step 2: Write a failing provisioning callback test**

Use `self.captureOnCommitCallbacks(execute=True)` and patch `devices.views.publish_device_created_best_effort`. Assert a successful staff POST schedules exactly one call with the created UUID. Also assert the response still contains the one-time key while the publisher receives only the UUID.

- [ ] **Step 3: Run backend tests and verify RED**

Run: `cd django && python3 manage.py test devices.tests.test_nats devices.tests.test_provisioning -v 2`

Expected: import/assertion failures because the new event functions and callback are absent.

- [ ] **Step 4: Implement event serialization, publishing, and callback**

Refactor the existing common NATS send path only enough to reuse `_publish`. Add:

```python
DEVICE_CREATED_SUBJECT = "devices.created"

def device_created_payload(device: Device) -> bytes:
    return json.dumps(DeviceSerializer(device).data, separators=(",", ":")).encode()

def publish_device_created_best_effort(device_id: UUID) -> None:
    try:
        device = Device.objects.get(id=device_id)
        asyncio.run(_publish(DEVICE_CREATED_SUBJECT, device_created_payload(device)))
    except Exception:
        pass
```

In `DeviceListCreateView.post`, register the callback after `Device.objects.create`:

```python
transaction.on_commit(
    lambda device_id=device.id: publish_device_created_best_effort(device_id)
)
```

- [ ] **Step 5: Run backend tests and verify GREEN**

Run: `cd django && python3 manage.py test devices.tests.test_nats devices.tests.test_provisioning -v 2`

Expected: all selected tests pass.

- [ ] **Step 6: Commit the backend event**

```bash
git add django/devices/nats.py django/devices/views.py django/devices/tests/test_nats.py django/devices/tests/test_provisioning.py
git commit -m "feat: publish device creation notifications"
```

### Task 3: NATS Authorization and Frontend Device Subscription

**Files:**
- Modify: `django/nats_auth/tests/test_authorization.py`
- Modify: `django/nats_auth/views.py`
- Modify: `frontend/src/nats.test.ts`
- Modify: `frontend/src/nats.ts`

**Interfaces:**
- Produces: browser subscribe permissions for `devices.created` and `devices.*.measurements`.
- Produces: `subscribeToDeviceCreations(token, onDeviceCreated, onReconnect, onError): Promise<() => void>`.
- Consumes: a JSON object matching public `Device` fields on `devices.created`; callback is an invalidation signal and receives no state argument.

- [ ] **Step 1: Change the backend permission expectation first**

Update the authorization test's exact response to require:

```python
"sub": {
    "allow": ["devices.created", "devices.*.measurements"],
    "deny": [],
}
```

- [ ] **Step 2: Run authorization tests and verify RED**

Run: `cd django && python3 manage.py test nats_auth.tests.test_authorization -v 2`

Expected: the permission response omits `devices.created`.

- [ ] **Step 3: Add the explicit device-created permission and verify GREEN**

Modify `get_nats_permissions` to return the exact allow list above. Run the command from Step 2 and expect all tests to pass.

- [ ] **Step 4: Write failing frontend NATS tests**

Extend `nats.test.ts` to assert that `subscribeToDeviceCreations`:

```typescript
expect(connection.subscribe).toHaveBeenCalledWith("devices.created");
// a valid public device JSON message invokes onDeviceCreated once
// malformed JSON/public shape invokes onError and not onDeviceCreated
// returned close unsubscribes and closes the connection
// reconnect status invokes onReconnect
```

- [ ] **Step 5: Run the NATS frontend tests and verify RED**

Run: `cd frontend && npm test -- src/nats.test.ts`

Expected: failure because `subscribeToDeviceCreations` is not exported.

- [ ] **Step 6: Implement the focused device-created subscription**

Add a public-device runtime validator (or reuse a type-only import from `api.ts`) and implement the same connection lifecycle/error handling used by `subscribeToMeasurements`, subscribing to `devices.created`. Invoke `onDeviceCreated()` only after valid JSON is decoded. Invoke `onReconnect` on reconnect so the consumer can re-fetch events missed while disconnected.

- [ ] **Step 7: Run NATS tests and verify GREEN**

Run: `cd frontend && npm test -- src/nats.test.ts`

Expected: all NATS tests pass.

- [ ] **Step 8: Commit permissions and subscription support**

```bash
git add django/nats_auth/views.py django/nats_auth/tests/test_authorization.py frontend/src/nats.ts frontend/src/nats.test.ts
git commit -m "feat: subscribe browsers to device creation events"
```

### Task 4: Access-Token Persistence and Authentication Errors

**Files:**
- Create: `frontend/src/session.ts`
- Create: `frontend/src/session.test.ts`
- Modify: `frontend/src/api.ts`
- Modify: `frontend/src/api.test.ts`

**Interfaces:**
- Produces: `ACCESS_TOKEN_STORAGE_KEY = "iot.accessToken"`.
- Produces: `storeAccessToken(token: string): void`, `restoreAccessToken(nowMs?: number): string | null`, and `clearAccessToken(): void`.
- Produces: `ApiError extends Error` with numeric `status` from failed HTTP responses.

- [ ] **Step 1: Write failing session-helper tests**

Create `session.test.ts` with base64url JWT fixtures and assertions that:

```typescript
storeAccessToken("token"); // writes only ACCESS_TOKEN_STORAGE_KEY
localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, expBeforeNowToken);
restoreAccessToken(now); // returns null and removes expired storage
localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, expAfterNowToken);
restoreAccessToken(now); // returns the original current token
localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, "malformed");
restoreAccessToken(now); // returns null and removes malformed storage
clearAccessToken(); // removes storage
```

- [ ] **Step 2: Run session tests and verify RED**

Run: `cd frontend && npm test -- src/session.test.ts`

Expected: module import failure because `session.ts` does not exist.

- [ ] **Step 3: Implement the session helper and verify GREEN**

Decode the JWT's second segment using base64url normalization and `atob`, JSON-parse it, require a finite numeric `exp`, and compare `exp * 1000 > nowMs`. Catch all decode/storage errors, clear invalid storage when possible, and return `null`.

Run the command from Step 2 and expect all tests to pass.

- [ ] **Step 4: Write a failing API status test**

Update `api.test.ts` to make a request return HTTP 401 and assert:

```typescript
await expect(listDevices("expired")).rejects.toMatchObject({
  name: "ApiError",
  status: 401,
});
```

- [ ] **Step 5: Run API tests and verify RED**

Run: `cd frontend && npm test -- src/api.test.ts`

Expected: the existing generic `Error` has no `status`.

- [ ] **Step 6: Implement `ApiError` and verify GREEN**

Export `ApiError`, construct it in the shared `request` helper, and use that helper in `getLatest` while retaining its special 404-to-null behavior. Run the command from Step 5 and expect all tests to pass.

- [ ] **Step 7: Commit session and API foundations**

```bash
git add frontend/src/session.ts frontend/src/session.test.ts frontend/src/api.ts frontend/src/api.test.ts
git commit -m "feat: add persistent access token storage"
```

### Task 5: Restore Sessions and Refresh Device Lists in React

**Files:**
- Modify: `frontend/src/App.test.tsx`
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Consumes: session helpers and `ApiError` from Task 4.
- Consumes: `subscribeToDeviceCreations` from Task 3.
- Produces: startup token validation, persistent successful login, and event-driven authoritative list refresh.

- [ ] **Step 1: Write failing persistent-session component tests**

Mock the session module and add tests that assert:

```typescript
// restored token -> listDevices(restoredToken), signed-in device selector shown
// successful login -> storeAccessToken(access-token)
// restored token rejected with ApiError(401) -> clearAccessToken(), login shown
// malformed/expired storage is represented by restoreAccessToken() returning null
// and listDevices is not called on initial render
```

Mock `subscribeToDeviceCreations` in the hoisted NATS mock so existing tests remain deterministic.

- [ ] **Step 2: Run component tests and verify session RED**

Run: `cd frontend && npm test -- src/App.test.tsx`

Expected: no restore/store calls occur and restored sessions do not load devices.

- [ ] **Step 3: Implement startup restoration and login persistence**

Initialize a startup/loading state. On mount, call `restoreAccessToken`; if it returns a token, call `listDevices` before committing authenticated UI state. On a 401/403 `ApiError`, call a single logout helper that clears storage, token, devices, selection, and measurement state. On successful interactive login, fetch devices first, then store and commit the access token. Restore `FormEvent<HTMLFormElement>` typing rather than retaining `any`.

- [ ] **Step 4: Run component tests and verify session GREEN**

Run: `cd frontend && npm test -- src/App.test.tsx`

Expected: persistent-session tests and existing measurement tests pass.

- [ ] **Step 5: Write failing device-event refresh tests**

Capture the `onDeviceCreated` and `onReconnect` callbacks passed to `subscribeToDeviceCreations`. Assert:

```typescript
// authenticated render starts exactly one global device subscription
// event callback calls listDevices(access-token) and renders the returned device
// reconnect callback performs the same authoritative refresh
// selected device remains selected if still returned
// older overlapping refresh response cannot replace a newer response
// unmount or logout closes the global subscription
// 401 refresh clears persisted/current authentication
```

- [ ] **Step 6: Run component tests and verify event RED**

Run: `cd frontend && npm test -- src/App.test.tsx`

Expected: no global device subscription or event-driven refresh occurs.

- [ ] **Step 7: Implement the global subscription and guarded refresh**

Add a monotonically increasing device-list request generation ref. A shared `refreshDevices(token)` commits only the latest response, preserves a still-present selection, and clears selection/measurement state when absent. A 401/403 invokes the logout helper; other errors set `apiError` and retain the last list. Start `subscribeToDeviceCreations` whenever `accessToken` exists, use `refreshDevices` for both event and reconnect callbacks, and close it in effect cleanup.

- [ ] **Step 8: Run frontend tests and build**

Run:

```bash
cd frontend
npm test
npm run build
```

Expected: all Vitest tests pass and TypeScript/Vite build succeeds without errors.

- [ ] **Step 9: Commit the integrated frontend behavior**

```bash
git add frontend/src/App.tsx frontend/src/App.test.tsx
git commit -m "feat: restore sessions and refresh device lists"
```

### Task 6: README and Environment Example

**Files:**
- Modify: `ReadMe.md`
- Modify: `example.env`

**Interfaces:**
- Documents: `./get-issuer-key.sh`, `DEVICE_ID`, and `DEVICE_KEY`.

- [ ] **Step 1: Update setup documentation**

Replace the inline immutable `nats-box` command with:

```sh
./get-issuer-key.sh
```

State explicitly that the first generated line is `ACCOUNT_SIGNER_SEED`, the second is `ACCOUNT_SIGNER_PUB`, output is also stored under ignored `nats-keys/`, and the seed must not be committed or shared.

- [ ] **Step 2: Update simulator documentation and environment template**

Add blank `DEVICE_ID=` and `DEVICE_KEY=` entries to `example.env`. Change the simulator example to place the provisioned values in `.env` and run:

```sh
.venv/bin/python iot-device-sim.py \
  --url http://localhost/api/device-measurements/ \
  --name temperature \
  --value 21.7
```

Document that `--device-id` and `--key` remain available as overrides and avoid examples that expose real credentials in shell history.

- [ ] **Step 3: Check documentation and compose contracts**

Run:

```bash
rg -n "get-issuer-key|ACCOUNT_SIGNER_(SEED|PUB)|DEVICE_(ID|KEY)" ReadMe.md example.env
sh scripts/test-compose.sh
docker compose config --quiet
```

Expected: all six configuration names are documented and deployment checks exit zero.

- [ ] **Step 4: Commit documentation**

```bash
git add ReadMe.md example.env
git commit -m "docs: explain key helpers and simulator environment"
```

### Task 7: Full Verification

**Files:**
- Verify only; fix failures in the task-owned files above using a new failing regression test when behavior changes.

**Interfaces:**
- Confirms all prior task contracts work together.

- [ ] **Step 1: Run backend verification**

```bash
cd django
python3 manage.py test -v 2
python3 manage.py check
python3 manage.py makemigrations --check
```

Expected: all commands exit zero and no migration changes are generated.

- [ ] **Step 2: Run frontend verification**

```bash
cd frontend
npm test
npm run build
```

Expected: all tests and the production build pass.

- [ ] **Step 3: Run simulator and deployment verification**

```bash
python3 -m unittest tests.test_iot_device_sim -v
sh scripts/test-compose.sh
docker compose config --quiet
```

Expected: all commands exit zero.

- [ ] **Step 4: Inspect the final diff**

Run `git status --short`, `git diff --check`, and `git log --oneline -8`. Confirm only scoped files were changed by this work and all pre-existing user edits remain intact.
