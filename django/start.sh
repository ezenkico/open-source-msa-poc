#!/bin/sh
set -e

# Wait for DB and ensure POSTGRES_DB exists (idempotent)
echo "Setting up database"
python setup-database.py

# Run migrations
echo "Migrating setup"
python manage.py migrate --noinput
python manage.py collectstatic --noinput


# (optional) create initial migrations for your apps
# python manage.py makemigrations

# Setup initial user
echo Setup initial user
if [ -n "${DJANGO_SUPERUSER_USERNAME:-}" ]; then
  python manage.py createsuperuser \
    --noinput \
    --username "$DJANGO_SUPERUSER_USERNAME" \
    --email "${DJANGO_SUPERUSER_EMAIL:-}" || true
fi

WORKERS=${UVICORN_WORKERS:-1}

echo Workers: $WORKERS

# Launch Django via Uvicorn (ASGI)
echo Launching
exec python -m uvicorn testsite.asgi:application --host 0.0.0.0 --port 8000 --workers "$WORKERS"
