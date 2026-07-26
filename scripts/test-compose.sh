#!/bin/sh
set -eu

rendered=$(docker compose config)
services=$(docker compose config --services | sort)
expected_services=$(printf '%s\n' django nats nats-redirect nginx postgres | sort)

test "$services" = "$expected_services"
printf '%s\n' "$rendered" | grep -q 'nginx:'
printf '%s\n' "$rendered" | grep -q 'django:'
printf '%s\n' "$rendered" | grep -q 'nats-redirect:'
printf '%s\n' "$rendered" | grep -q 'AUTH_SERVER: http://django:8000/api/nats-auth/perms/'
printf '%s\n' "$rendered" | grep -q 'image: nats:2.14-alpine'
printf '%s\n' "$rendered" | grep -q -- '- nc'
printf '%s\n' "$rendered" | grep -q -- '- 127.0.0.1'
printf '%s\n' "$rendered" | grep -q -- '- "4222"'
test "$(printf '%s\n' "$rendered" | grep -c 'published: "80"')" -eq 1
! printf '%s\n' "$rendered" | grep -q 'published: "4222"'
! printf '%s\n' "$rendered" | grep -q 'published: "8080"'

grep -Eq 'auth_users:[[:space:]]*\[[[:space:]]*"auth",[[:space:]]*"publisher"[[:space:]]*\]' nats.conf
grep -Eq 'account:[[:space:]]*AUTH' nats.conf
grep -Eq 'user:[[:space:]]*"publisher"' nats.conf
grep -Eq 'publish:[[:space:]]*\{[[:space:]]*allow:[[:space:]]*\[[[:space:]]*"devices\.\*\.measurements"[[:space:]]*\]' nats.conf
grep -Eq 'subscribe:[[:space:]]*\{[[:space:]]*deny:[[:space:]]*\[[[:space:]]*">"[[:space:]]*\]' nats.conf
grep -Eq 'system_account:[[:space:]]*SYS' nats.conf
grep -Eq 'port:[[:space:]]*8080' nats.conf
grep -Eq 'no_tls:[[:space:]]*true' nats.conf
