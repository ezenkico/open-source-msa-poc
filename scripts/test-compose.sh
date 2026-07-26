#!/bin/sh
set -eu

rendered=$(docker compose config)
printf '%s\n' "$rendered" | grep -q 'nginx:'
printf '%s\n' "$rendered" | grep -q 'django:'
printf '%s\n' "$rendered" | grep -q 'nats-redirect:'
printf '%s\n' "$rendered" | grep -q 'AUTH_SERVER: http://django:8000/api/nats-auth/perms/'
test "$(printf '%s\n' "$rendered" | grep -c 'published: "80"')" -eq 1
! printf '%s\n' "$rendered" | grep -q 'published: "4222"'
! printf '%s\n' "$rendered" | grep -q 'published: "8080"'
