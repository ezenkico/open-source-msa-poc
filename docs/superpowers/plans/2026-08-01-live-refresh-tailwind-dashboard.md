# Live Refresh and Tailwind Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refresh the authoritative current measurement page and page count after NATS measurement bursts, and present the application as a responsive Tailwind-powered operational dashboard.

**Architecture:** A focused `useDebouncedCallback` hook owns the 250 ms timer lifecycle. `App` keeps the existing page request-generation guards and invokes the hook from measurement notifications to reload the current latest value and page metadata. Tailwind CSS v4 is integrated through its Vite plugin, then existing semantic React markup is reorganized into a responsive dashboard without changing API, permission, session, or NATS interfaces.

**Tech Stack:** React 19, TypeScript 5.9, Vite 7, Vitest, Testing Library, Tailwind CSS v4, `@tailwindcss/vite`, NATS WebSocket client.

## Global Constraints

- Debounce live refreshes by exactly 250 ms; every notification updates the latest-value state immediately.
- Refresh the selected page for every offset and both `asc` and `desc` orderings.
- An authoritative refresh replaces rows and response metadata including `total`.
- Cancel pending refreshes on device change, sign-out, session expiration, and unmount.
- Stale successes and failures must not mutate current data or errors.
- Current failures preserve the last successful page and a later notification may retry.
- Preserve authentication persistence, permissions, provisioning, pagination, API contracts, semantic labels, keyboard behavior, focus visibility, and accessible roles.
- Use Tailwind's Vite plugin and utility classes; add no component library or icon package.
- Do not add charts, theme configuration UI, polling, or NATS/API format changes.

---

### Task 1: Debounced Callback Lifecycle

**Files:**
- Create: `frontend/src/useDebouncedCallback.ts`
- Create: `frontend/src/useDebouncedCallback.test.tsx`

**Interfaces:**
- Produces: `useDebouncedCallback(callback: () => void, delayMs: number, resetKeys: readonly unknown[]): { schedule: () => void; cancel: () => void }`.
- Guarantee: repeated `schedule()` calls restart one timer; `cancel()`, reset-key changes, and unmount clear it; the timer invokes the latest callback closure.

- [ ] **Step 1: Write failing timer tests**

Create a small harness that exposes Schedule and Cancel buttons and records the callback. Use `vi.useFakeTimers()` and assert:

```tsx
fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
act(() => vi.advanceTimersByTime(200));
fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
act(() => vi.advanceTimersByTime(249));
expect(callback).not.toHaveBeenCalled();
act(() => vi.advanceTimersByTime(1));
expect(callback).toHaveBeenCalledOnce();
```

Add separate tests proving Cancel prevents invocation, rerendering with a changed reset key cancels pending work, unmount cancels pending work, and a rerendered callback is the one invoked.

- [ ] **Step 2: Verify RED**

Run:

```bash
cd frontend
npm test -- src/useDebouncedCallback.test.tsx
```

Expected: failure because `useDebouncedCallback.ts` does not exist.

- [ ] **Step 3: Implement the minimal hook**

Use refs for the latest callback and timeout handle. `schedule` clears the old handle before setting `window.setTimeout`; `cancel` clears and nulls it. One cleanup effect depends on `[cancel, ...resetKeys]`, while the callback-ref update does not restart timers.

- [ ] **Step 4: Verify GREEN**

Run the focused hook suite and `npm run build`. Expected: all hook tests pass and TypeScript accepts the public signature.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/useDebouncedCallback.ts frontend/src/useDebouncedCallback.test.tsx
git commit -m "feat: add debounced callback hook"
```

---

### Task 2: Authoritative Live Measurement Refresh

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/App.test.tsx`
- Modify: `frontend/src/measurementState.ts`
- Modify: `frontend/src/measurementState.test.ts`

**Interfaces:**
- Consumes: `useDebouncedCallback(callback, 250, [accessToken, deviceId])` from Task 1.
- Existing page loader: `loadMeasurementPage(deviceId, token, offset, order, selectionGeneration)`.
- Produces: NATS notification behavior that updates `latest` immediately and schedules one authoritative latest/page refresh per burst.

- [ ] **Step 1: Replace stable-row expectations with failing authoritative-refresh tests**

In `App.test.tsx`, enable fake timers only inside a dedicated live-refresh describe block and restore real timers afterward. Add tests that:

- deliver one notification, advance 249 ms, and observe no page reload;
- advance the final 1 ms and expect `getLatest(deviceId, token)` plus `getMeasurements(deviceId, token, "limit=50&offset=0&order=desc")`;
- deliver three notifications inside 250 ms and expect only one additional refresh;
- navigate to offset 50/order `asc`, notify, and expect that exact current query;
- return a page with a larger `total` and assert changed rows plus `Page 2 of 4`;
- return an invalidated offset and assert the existing one-shot correction query;
- reject a current refresh and assert previous rows/page remain, the error is visible, and a later notification retries;
- resolve an old refresh after changing devices/order and assert its success or failure is ignored;
- schedule and then change device, sign out, or unmount and assert no delayed request occurs.

Use deferred promises in the existing test style so request ordering is explicit.

- [ ] **Step 2: Verify RED**

Run:

```bash
cd frontend
npm test -- src/App.test.tsx src/measurementState.test.ts
```

Expected: new assertions fail because notifications currently update latest/gap state without reloading the authoritative page or total.

- [ ] **Step 3: Simplify notification state semantics**

Keep `mergeNotification` responsible for immediate latest-value and missing-range tracking only. Preserve its monotonic entry-index and gap-coalescing rules. Update tests to state explicitly that displayed rows remain unchanged only during the 250 ms debounce window; the subsequent authoritative page response owns row replacement.

- [ ] **Step 4: Add the debounced authoritative loader**

In `App`, define a current-state callback that captures refs at invocation time:

```tsx
const refreshSelectedMeasurements = useCallback(() => {
  const selectedDeviceId = selectedDeviceIdRef.current;
  const selectedOffset = offsetRef.current;
  const selectedOrder = orderRef.current;
  const generation = selectionGeneration.current;
  if (!accessToken || !selectedDeviceId) return;
  void Promise.all([
    getLatest(selectedDeviceId, accessToken),
    loadMeasurementPage(selectedDeviceId, accessToken, selectedOffset, selectedOrder, generation),
  ]).then(([latest, page]) => {
    if (page && selectionGeneration.current === generation) {
      setMeasurementState((current) => ({ ...current, latest }));
    }
  });
}, [accessToken, loadMeasurementPage]);
```

Route errors through the existing current-request guard rather than adding an unguarded `.catch`. Create the hook with 250 ms and reset keys for session/device selection. Call `schedule()` after every accepted post-initialization notification. Keep queued pre-initialization notifications and reconnect behavior intact.

- [ ] **Step 5: Verify GREEN and race behavior**

Run the focused suites repeatedly with `--repeat=3` if supported, otherwise run them three times, followed by the full frontend suite and build. Expected: every timer, metadata, cancellation, correction, and stale-response test passes without act warnings.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/App.tsx frontend/src/App.test.tsx frontend/src/measurementState.ts frontend/src/measurementState.test.ts
git commit -m "fix: refresh measurement pages from live events"
```

---

### Task 3: Tailwind Vite Foundation

**Files:**
- Modify: `frontend/package.json`
- Modify: `frontend/package-lock.json`
- Modify: `frontend/vite.config.ts`
- Modify: `frontend/src/styles.css`
- Create: `frontend/src/styles.test.ts`

**Interfaces:**
- Produces: Tailwind v4 processing through `@tailwindcss/vite` and global dashboard theme tokens/base rules.
- Consumes: current `main.tsx` import of `./styles.css`; no import path change.

- [ ] **Step 1: Add a failing build-contract test**

Create `styles.test.ts` that reads `vite.config.ts` and `styles.css` and asserts the configuration contains `tailwindcss()` and the stylesheet begins with `@import "tailwindcss";`. This test is intentionally a narrow build contract; visual semantics remain component tests.

- [ ] **Step 2: Verify RED**

Run `npm test -- src/styles.test.ts`. Expected: both Tailwind integration assertions fail.

- [ ] **Step 3: Install and configure Tailwind**

From `frontend`, run:

```bash
npm install --save-dev tailwindcss @tailwindcss/vite
```

Import `tailwindcss` from `@tailwindcss/vite` and add `tailwindcss()` after `react()` in the Vite plugin array, following Tailwind's official Vite integration. Add `@import "tailwindcss";` to `styles.css`.

- [ ] **Step 4: Define global canvas and reusable focus behavior**

Keep CSS small: establish dark `color-scheme`, body/root minimum height, an antialiased system font stack, selection colors, and reduced-motion behavior. Component appearance must stay in Tailwind class strings rather than recreated CSS selectors.

- [ ] **Step 5: Verify GREEN**

Run the focused style test, full frontend tests, and `npm run build`. Inspect built CSS to confirm Tailwind utilities are emitted.

- [ ] **Step 6: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/vite.config.ts frontend/src/styles.css frontend/src/styles.test.ts
git commit -m "build: add Tailwind CSS to frontend"
```

---

### Task 4: Responsive Operational Dashboard

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/App.test.tsx`
- Modify: `frontend/src/DeviceProvisioning.tsx`
- Modify: `frontend/src/DeviceProvisioning.test.tsx`
- Create: `frontend/src/ui.tsx`
- Create: `frontend/src/ui.test.tsx`

**Interfaces:**
- Produces presentational primitives `Panel`, `StatusBadge`, `Button`, and `Field` with `className`, children, and native element props passed through.
- Preserves all existing accessible names: `Selected device`, `Measurement order`, `Previous`, `Next`, `Add device`, `Sign in`, and alert/status roles.

- [ ] **Step 1: Add failing semantic layout tests**

Add assertions for stable user-facing landmarks rather than Tailwind implementation strings:

- unauthenticated view has a named sign-in region and no dashboard navigation;
- authenticated view has a banner, navigation labelled `Devices`, main region, live connection status, selected device name and full ID;
- measurement history remains a named region with ordering and pagination controls;
- loading and empty states remain understandable;
- provisioning credentials retain copy buttons, warning copy, alert/status behavior, and permission gating.

Add focused primitive tests proving native props, disabled state, accessible labels, and custom classes pass through.

- [ ] **Step 2: Verify RED**

Run `npm test -- src/ui.test.tsx src/App.test.tsx src/DeviceProvisioning.test.tsx`. Expected: new landmarks and dashboard copy are absent.

- [ ] **Step 3: Implement restrained UI primitives**

Create typed primitives with fixed dark-dashboard Tailwind classes and `className` composition. Do not create a general design-system abstraction or variant framework. Buttons need primary, secondary, and danger appearances; badges need live, warning, and neutral appearances.

- [ ] **Step 4: Restyle authentication and application shell**

Build a full-height slate canvas. The signed-out state is a centered two-column/card composition with concise IoT telemetry copy and a labelled sign-in panel. The signed-in shell has a sticky/translucent banner containing product identity, connection badge, user/session state, and sign-out.

- [ ] **Step 5: Build responsive device and measurement workspace**

Use a responsive grid with a device navigation panel and main workspace. Render device names and full IDs with visible selection. Place latest value, device identity, connection state, and total measurement count in cards. Make measurement order and refresh/loading feedback visible in the history header. Wrap the table in horizontal overflow, use readable tabular numerals, zebra/hover states, and an explicit empty row. Keep numeric pagination below the table.

- [ ] **Step 6: Restyle provisioning without changing behavior**

Use the same primitives for the Add device form and one-time credentials panel. Give the secret warning strong amber treatment, render values in selectable monospace blocks, preserve Copy ID/Copy key/Dismiss semantics, and retain permission/authentication callbacks unchanged.

- [ ] **Step 7: Verify GREEN and responsive build**

Run the three focused component suites, the full frontend suite, and production build. Inspect the app at desktop and narrow viewport widths using the available browser/manual preview; confirm no horizontal page overflow except inside the table container and every keyboard focus state remains visible.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/App.tsx frontend/src/App.test.tsx frontend/src/DeviceProvisioning.tsx frontend/src/DeviceProvisioning.test.tsx frontend/src/ui.tsx frontend/src/ui.test.tsx
git commit -m "feat: redesign frontend as telemetry dashboard"
```

---

### Task 5: Full Verification and Documentation Alignment

**Files:**
- Modify: `ReadMe.md`
- Modify: `scripts/test-compose.sh`
- Verify all application files.

**Interfaces:**
- Confirms the assembled feature against the approved design and all existing service contracts.

- [ ] **Step 1: Check README behavior wording**

The current README says a full history page remains fixed. Add a failing assertion to `scripts/test-compose.sh` that requires wording describing debounced authoritative refresh and updated page totals, then replace the stale sentence in `ReadMe.md`. Run the documentation test RED then GREEN and commit only those two files as `docs: explain live measurement refresh`.

- [ ] **Step 2: Run full frontend verification**

```bash
cd frontend
npm test
npm run build
```

- [ ] **Step 3: Run backend and simulator verification**

```bash
docker compose up --build -d postgres django
docker compose exec -T django python manage.py test --keepdb -v 2
docker compose exec -T django python manage.py check
docker compose exec -T django python manage.py makemigrations --check
.venv/bin/python -m unittest tests.test_iot_device_sim -v
```

- [ ] **Step 4: Run deployment and scope checks**

```bash
sh scripts/test-compose.sh
sh -n get-issuer-key.sh
docker compose config --quiet
git diff --check
git status --short
git log --oneline -12
```

Confirm no secrets, generated build output, unrelated files, or package-manager artifacts outside `frontend/package-lock.json` are committed.

- [ ] **Step 5: Request final whole-branch review**

Review the complete diff against the approved specification, paying special attention to timer cleanup, stale requests, page totals, invalidated offsets, session/device lifecycle, responsive overflow, permissions, accessibility, and dependency scope. Fix every Critical or Important issue test-first and repeat all verification commands.
