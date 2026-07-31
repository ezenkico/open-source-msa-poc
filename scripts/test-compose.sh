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

grep -Eq 'location[[:space:]]+/admin/[[:space:]]*\{' nginx/default.conf
grep -A8 -E 'location[[:space:]]+/admin/[[:space:]]*\{' nginx/default.conf |
  grep -q 'proxy_pass http://django:8000'
grep -Eq 'location[[:space:]]+/static/[[:space:]]*\{' nginx/default.conf
grep -A8 -E 'location[[:space:]]+/static/[[:space:]]*\{' nginx/default.conf |
  grep -q 'proxy_pass http://django:8000'
grep -Eq 'location[[:space:]]+/[[:space:]]*\{' nginx/default.conf
grep -A3 -E 'location[[:space:]]+/[[:space:]]*\{' nginx/default.conf |
  grep -q 'try_files \$uri /index.html'

grep -Eq 'auth_users:[[:space:]]*\[[[:space:]]*"auth",[[:space:]]*"publisher"[[:space:]]*\]' nats.conf
grep -Eq 'account:[[:space:]]*AUTH' nats.conf
grep -Eq 'user:[[:space:]]*"publisher"' nats.conf
grep -Eq 'publish:[[:space:]]*\{[[:space:]]*allow:[[:space:]]*\[[[:space:]]*"devices\.created",[[:space:]]*"devices\.\*\.measurements"[[:space:]]*\]' nats.conf
grep -Eq 'subscribe:[[:space:]]*\{[[:space:]]*deny:[[:space:]]*\[[[:space:]]*">"[[:space:]]*\]' nats.conf
grep -Eq 'system_account:[[:space:]]*SYS' nats.conf
grep -Eq 'port:[[:space:]]*8080' nats.conf
grep -Eq 'no_tls:[[:space:]]*true' nats.conf

grep -q './get-issuer-key.sh' ReadMe.md
test -x get-issuer-key.sh
head -n 1 get-issuer-key.sh | grep -qx '#!/bin/sh'
grep -Fq -- '-v "$PWD/nats-keys:/work"' get-issuer-key.sh
grep -Fq -- '-w /work' get-issuer-key.sh
grep -Eq '\./nsc[[:space:]]+generate[[:space:]]+nkey[[:space:]]+--account[[:space:]]*>[[:space:]]*account-issuer\.txt' get-issuer-key.sh
grep -A1 'first generated line' ReadMe.md | grep -q 'ACCOUNT_SIGNER_SEED'
grep -A1 'the second is' ReadMe.md | grep -q 'ACCOUNT_SIGNER_PUB'
grep -q 'nats-keys' ReadMe.md
grep -qx 'nats-keys' .gitignore
grep -qx 'nats-keys' .dockerignore
test ! -e setup-nkey.sh
