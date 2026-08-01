# Measurement Offset Pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Return authoritative offset-pagination metadata from the measurement API, add numeric and order-selectable pagination to React, and document `generate-encryption-key.py`.

**Architecture:** Django validates two mutually exclusive query modes—offset pagination and NATS gap recovery—and always returns one response envelope. The frontend API validates that envelope; React owns offset/order navigation while keeping displayed pages stable during live notifications.

**Tech Stack:** Python 3.11, Django 5/DRF, PostgreSQL, React 19, TypeScript, Vitest, Testing Library.

## Global Constraints

- Requests never contain `total`; Django computes and returns it.
- Normal requests use `limit`, `offset`, and `order`; remove `before_index`.
- Gap requests retain `after_index`, `through_index`, and `limit`, always return ascending results, and reject explicit `offset` or `order`.
- Every successful list response contains exactly `results`, `total`, `limit`, `offset`, and `order`.
- Page availability comes only from response metadata, never measurement indexes.
- Changing order or device resets offset to 0; reconnect preserves current offset/order.
- Live notifications update latest/gap state but do not rewrite displayed paginated rows.
- Preserve all authentication, provisioning, NATS authorization, and one-time-key behavior.
- Do not add dependencies or perform unrelated refactoring.

---

### Task 1: Backend Pagination Envelope and Query Modes

**Files:**
- Modify: `django/devices/serializers.py`
- Modify: `django/devices/views.py`
- Modify: `django/devices/tests/test_measurement_api.py`

**Interfaces:**
- Produces normal query: `limit: int`, `offset: int`, `order: "asc" | "desc"`.
- Produces gap query: `limit: int`, `after_index: int`, optional `through_index: int`.
- Produces response: `{results, total, limit, offset, order}`.

- [ ] **Step 1: Replace cursor-page tests with failing offset-envelope tests**

Use measurements with non-contiguous indexes to prove indexes do not determine
page availability. Add exact assertions:

```python
response = self.client.get(f"{self.measurements_url()}?limit=2&offset=2&order=desc")
self.assertEqual(response.data["total"], 6)
self.assertEqual(response.data["limit"], 2)
self.assertEqual(response.data["offset"], 2)
self.assertEqual(response.data["order"], "desc")
self.assertEqual([row["entry_index"] for row in response.data["results"]], [4, 3])
```

Cover defaults (`offset=0`, `order=desc`), ascending pages, offset beyond total
returning empty results, and totals scoped to the selected device.

- [ ] **Step 2: Add failing validation and gap-envelope tests**

Assert invalid negative/overflow/non-integer offsets, invalid orders, repeated
parameters, unknown parameters, and `before_index` return 400. Assert explicit
`offset` or `order` combined with `after_index` returns 400 even for `offset=0`
or `order=asc`.

Update the gap test to require:

```python
{
    "results": [measurement_3, measurement_4, measurement_5],
    "total": 3,
    "limit": 10,
    "offset": 0,
    "order": "asc",
}
```

Also prove a smaller limit truncates `results` without changing the matching
range `total`.

- [ ] **Step 3: Run backend tests and verify RED**

Run:

```bash
docker compose up -d postgres django
docker compose exec -T django python manage.py test \
  devices.tests.test_measurement_api --keepdb -v 2
```

Expected: current array response, missing offset/order fields, and accepted
`before_index` fail the new assertions.

- [ ] **Step 4: Implement serializer modes**

In `MeasurementListQuerySerializer`, remove `before_index`, add:

```python
offset = serializers.IntegerField(
    min_value=0, max_value=MAX_ENTRY_INDEX, default=0
)
order = serializers.ChoiceField(choices=("asc", "desc"), default="desc")
```

Use `self.initial_data` in `validate` to distinguish omitted defaults from
explicit pagination parameters. When `after_index` is supplied, reject
`offset` or `order` keys, retain current `through_index` relationships, and set
effective gap metadata in the view. Continue rejecting repeated/unknown keys in
`to_internal_value`.

- [ ] **Step 5: Implement authoritative totals, ordering, and slicing**

After validating the device, define the device queryset once. For a gap query,
apply exclusive/inclusive bounds, call `.count()` before slicing, order by
`entry_index`, and use metadata `offset=0`, `order="asc"`. For a normal query,
count the full device queryset, order by `entry_index` or `-entry_index`, and
slice `[offset:offset + limit]`.

Return:

```python
Response({
    "results": MeasurementSerializer(rows, many=True).data,
    "total": total,
    "limit": limit,
    "offset": effective_offset,
    "order": effective_order,
})
```

- [ ] **Step 6: Run backend suite and checks**

```bash
docker compose exec -T django python manage.py test --keepdb -v 2
docker compose exec -T django python manage.py check
docker compose exec -T django python manage.py makemigrations --check
```

Expected: all tests pass and no migrations are created.

- [ ] **Step 7: Commit backend pagination**

```bash
git add django/devices/serializers.py django/devices/views.py django/devices/tests/test_measurement_api.py
git commit -m "feat: add measurement offset pagination"
```

### Task 2: Frontend Measurement Envelope Contract

**Files:**
- Modify: `frontend/src/api.ts`
- Modify: `frontend/src/api.test.ts`
- Modify: `frontend/src/App.test.tsx` (envelope-shaped mocks only)

**Interfaces:**
- Produces: `MeasurementOrder = "asc" | "desc"`.
- Produces:

```typescript
export type MeasurementPage = {
  results: Measurement[];
  total: number;
  limit: number;
  offset: number;
  order: MeasurementOrder;
};
```

- Changes: `getMeasurements(...): Promise<MeasurementPage>`.

- [ ] **Step 1: Write failing envelope request/response tests**

Assert normal calls preserve the supplied query exactly and return a validated
page. Assert gap calls return the same envelope. Include a valid response with
non-contiguous indexes.

- [ ] **Step 2: Write failing runtime-validation tests**

Reject non-object payloads, non-array `results`, malformed measurement fields,
negative/non-integer `total`, invalid `limit`, negative/non-integer `offset`,
and order values other than `asc`/`desc`. Require numeric fields to be safe
integers and `limit >= 1`.

- [ ] **Step 3: Run API tests and verify RED**

Run: `cd frontend && npm test -- src/api.test.ts`

Expected: current function returns an unchecked array and new type imports fail.

- [ ] **Step 4: Implement envelope parsing**

Add private runtime parsers for a `Measurement` and `MeasurementPage`. Reuse the
existing request helper and return only a fully validated object:

```typescript
export async function getMeasurements(
  deviceId: string,
  accessToken: string,
  query: string,
): Promise<MeasurementPage> {
  const response = await request(`/api/devices/${deviceId}/measurements/?${query}`, {
    headers: bearer(accessToken),
  });
  return parseMeasurementPage(await response.json());
}
```

- [ ] **Step 5: Run API/full frontend tests and build**

```bash
cd frontend
npm test -- src/api.test.ts
npm test
npm run build
```

Expected: all commands pass after downstream test mocks are updated only as
needed to return envelope fixtures; do not implement App pagination in this task.

- [ ] **Step 6: Commit API envelope**

```bash
git add frontend/src/api.ts frontend/src/api.test.ts frontend/src/App.test.tsx
git commit -m "feat: validate measurement page responses"
```

### Task 3: Frontend Numeric Pagination and Ordering

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/App.test.tsx`
- Modify: `frontend/src/measurementState.ts`
- Modify: `frontend/src/measurementState.test.ts`

**Interfaces:**
- Consumes: `MeasurementPage` and `MeasurementOrder` from Task 2.
- Produces: numeric page state derived from authoritative response metadata.

- [ ] **Step 1: Write failing page-control tests**

Add envelope fixtures and assert:

- `offset=0,total=120,limit=50` displays `Page 1 of 3` and disables Previous;
- Next requests `limit=50&offset=50&order=desc`;
- page 2 displays `Page 2 of 3` and enables both controls;
- Previous requests offset 0;
- last page disables Next using metadata even when its lowest index is greater
  than 1;
- an empty response displays `Page 1 of 1` with both controls disabled; and
- controls are disabled while a page request is pending.

- [ ] **Step 2: Write failing ordering/reset tests**

Assert a labelled ordering select offers `Newest first`/`Oldest first`.
Changing from desc to asc resets to and requests offset 0. Changing devices also
requests offset 0 while retaining order. Reconnect reloads the current offset
and order.

- [ ] **Step 3: Write failing stale/error/correction tests**

Assert older page successes/failures cannot replace/report over newer device,
offset, or order selections. A current failure retains the last successful page
and reports an error. An empty out-of-range page with a smaller authoritative
total requests exactly the last valid offset once and commits only that guarded
response.

- [ ] **Step 4: Write failing stable-live-page tests**

Change measurement-state behavior so notifications update `latest` and missing
range but not `rows`. Gap recovery consumes `page.results`, clears the matching
missing range, and leaves rows unchanged. Cover notification gaps and a full or
partial displayed page in both orders.

- [ ] **Step 5: Run focused tests and verify RED**

```bash
cd frontend
npm test -- src/measurementState.test.ts src/App.test.tsx
```

Expected: array assumptions, index-based Previous enablement, missing controls,
and row mutation fail.

- [ ] **Step 6: Implement pagination state and page loading**

Add `offset`, `order`, `measurementPage`, `isPageLoading`, and a page-request
generation. Query `limit=${PAGE_SIZE}&offset=${offset}&order=${order}`. Commit
only when device/selection/page generations match. Derive:

```typescript
const currentPage = Math.floor(page.offset / page.limit) + 1;
const totalPages = Math.max(1, Math.ceil(page.total / page.limit));
const hasPrevious = page.offset > 0;
const hasNext = page.offset + page.results.length < page.total;
```

Previous uses `Math.max(0, page.offset - page.limit)`; Next uses
`page.offset + page.limit`. Render `Page X of Y` and disable controls while
loading or at their metadata boundary.

- [ ] **Step 7: Implement ordering, reconnect, and correction**

Ordering changes reset offset to 0. Device changes reset offset to 0 but retain
order. Reconnect calls the loader with current offset/order refs. If a successful
page is empty with `offset >= total` and `total > 0`, calculate and request the
last valid offset; never display the invalid page or loop.

- [ ] **Step 8: Preserve stable live rows and adapt gap recovery**

Update the notification helper to preserve `rows`, update `latest`, and retain
gap detection. Gap recovery reads `page.results` for contract completion, then
clears only the still-matching missing range. Do not use entry indexes for page
buttons.

- [ ] **Step 9: Run frontend verification**

```bash
cd frontend
npm test
npm run build
```

Expected: all tests/build pass, including provisioning/auth/NATS regressions.

- [ ] **Step 10: Commit frontend pagination**

```bash
git add frontend/src/App.tsx frontend/src/App.test.tsx frontend/src/measurementState.ts frontend/src/measurementState.test.ts
git commit -m "feat: add numeric measurement pagination"
```

### Task 4: Encryption-Key README Contract

**Files:**
- Modify: `ReadMe.md`
- Modify: `scripts/test-compose.sh`

**Interfaces:**
- Documents: `python3 generate-encryption-key.py` for `DEVICE_KEY_ENCRYPTION_KEY`.

- [ ] **Step 1: Add failing documentation assertions**

Extend `scripts/test-compose.sh` to require the README contains
`generate-encryption-key.py`, `DEVICE_KEY_ENCRYPTION_KEY`, `DEVICE_KEY`, and
language distinguishing the server encryption key from the per-device key.
Run `sh scripts/test-compose.sh` and verify it fails on missing documentation.

- [ ] **Step 2: Update README setup guidance**

Replace the generic OpenSSL encryption-key example with:

```sh
python3 generate-encryption-key.py
```

State that its base64 output goes into `DEVICE_KEY_ENCRYPTION_KEY`, is a
server-side 32-byte AES-256 key-encryption key, must remain secret, and must
never be used as simulator `DEVICE_KEY`. Explain that `DEVICE_KEY` is returned
once per provisioned device.

- [ ] **Step 3: Run documentation/deployment checks**

```bash
sh scripts/test-compose.sh
docker compose config --quiet
git diff --check -- ReadMe.md scripts/test-compose.sh
```

Expected: all commands exit zero.

- [ ] **Step 4: Commit documentation**

```bash
git add ReadMe.md scripts/test-compose.sh
git commit -m "docs: explain encryption key generator"
```

### Task 5: Full Verification

**Files:**
- Verify only.

- [ ] **Step 1: Run backend verification**

```bash
docker compose up --build -d postgres django
docker compose exec -T django python manage.py test --keepdb -v 2
docker compose exec -T django python manage.py check
docker compose exec -T django python manage.py makemigrations --check
```

- [ ] **Step 2: Run frontend verification**

```bash
cd frontend
npm test
npm run build
```

- [ ] **Step 3: Run simulator and deployment verification**

```bash
.venv/bin/python -m unittest tests.test_iot_device_sim -v
sh scripts/test-compose.sh
sh -n get-issuer-key.sh
docker compose config --quiet
```

- [ ] **Step 4: Inspect final scope**

Run `git status --short`, `git diff --check`, and `git log --oneline -10`.
Confirm no unrelated files or secret-bearing outputs are present.
