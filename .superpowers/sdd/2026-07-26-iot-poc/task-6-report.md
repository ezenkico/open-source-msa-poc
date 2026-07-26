# Task 6 Report: Contract-Compliant Browser NATS Authorization

## Status

Completed. Browser-authenticated users can obtain a five-minute NATS token,
and the redirect callback independently validates its Bearer token before
returning the exact authorization JSON required by the integration contract.

## Files

- `django/nats_auth/views.py` — keeps five-minute `token_type: nats` issuance;
  disables global authentication only on the `AllowAny` callback so it can
  validate the raw Bearer JWT itself; returns the exact `APP` account,
  publish-deny, and measurement-subscribe permissions.
- `django/nats_auth/tests.py` — deleted before package creation so Django test
  discovery resolves the new package correctly.
- `django/nats_auth/tests/__init__.py` — test package marker.
- `django/nats_auth/tests/test_authorization.py` — route-level contract tests
  for five-minute NATS issuance, exact permissions, and regular, invalid, and
  expired-token denial.

`django/nats_auth/urls.py` already registered the required `token/` and
`perms/` routes beneath `/api/nats-auth/`, so it needed no change.

## TDD Evidence

- Red: the new suite initially failed with 403 responses for custom NATS and
  invalid Bearer values. This exposed global JWT authentication intercepting
  the callback before its required self-validation.
- Green: adding `@authentication_classes([])` only to the `AllowAny` callback
  allowed its existing signature, expiry, and `token_type` checks to execute;
  replacing the response payload made the three authorization tests pass.

## Verification

- `POSTGRES_HOST=localhost POSTGRES_DB=django ../.venv/bin/python manage.py test nats_auth.tests.test_authorization -v 2` — 3 tests passed.
- `POSTGRES_HOST=localhost POSTGRES_DB=django ../.venv/bin/python manage.py test -v 2` — 37 tests passed.
- `POSTGRES_HOST=localhost POSTGRES_DB=django ../.venv/bin/python manage.py check` — passed.
- `POSTGRES_HOST=localhost POSTGRES_DB=django ../.venv/bin/python manage.py makemigrations --check` — passed with no changes detected.
- `git diff --check` — passed.
- Independent review found no Critical, Important, or Minor issues and judged
  the implementation ready to merge.

## Notes

- Request tests emit the existing warning that `django/staticfiles/` is
  absent; it did not affect test outcomes.
- The pre-existing untracked `.venv/` remains excluded from the commit.
