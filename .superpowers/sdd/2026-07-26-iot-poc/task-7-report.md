# Task 7 Report: Minimal Static React Application

## Status

Implemented and verified; committed with the Task 7 commit below.

## Files

- `frontend/package.json` and `frontend/package-lock.json` — locked Vite/React/NATS WebSocket client dependencies.
- `frontend/src/api.ts` — typed relative Django API adapter with Bearer authorization and status-bearing errors.
- `frontend/src/nats.ts` — `/nats` WebSocket NATS subscription, measurement validation, reconnect callback, and cleanup.
- `frontend/src/measurementState.ts` — deterministic latest/table/gap state transition.
- `frontend/src/App.tsx` — accessible login, device selection, authoritative paging/reload, and minimal measurement UI.
- `frontend/src/*.test.ts*` and `frontend/src/test/setup.ts` — state and component behavior coverage.
- `frontend/index.html`, `frontend/src/main.tsx`, `frontend/src/styles.css`, and TypeScript/Vite configuration — static application shell and build setup.
- `frontend/.gitignore` — excludes generated dependencies, build output, and TypeScript build artifacts.

## Commit

`feat: add static real-time React client`

## Red-Green Evidence

- Red: `npm test` initially failed because `src/measurementState.ts` did not exist.
- Green: `npm test -- src/measurementState.test.ts` passed 3 state-transition tests after the pure state transition was added.
- Red: `npm test -- src/App.test.tsx` initially failed because `src/App.tsx` did not exist.
- Green: `npm test -- src/App.test.tsx` passed 4 component tests for login/loading, full-table freezing, gap range fetching, selection cleanup, and reconnect reload.
- Final: `npm test` passed 7 tests; `npm run build` completed and produced `frontend/dist/`.

## Concerns

- The plan's dependency list omitted `@types/node`, required by Vite 7's TypeScript configuration; the smallest compatible addition (`^24.0.0`) was made and locked. `vite.config.ts` uses `vitest/config` so the Vitest `test` property is typed.
- `nats.ws@1.30.3` emits npm's upstream deprecation warning, but it is the exact required dependency from the task brief.
- `getLatest` maps the documented empty-device 404 to `null`, matching its required return type; other non-2xx responses become errors containing the HTTP status.
