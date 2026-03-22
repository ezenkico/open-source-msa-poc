#!/bin/sh
set -e

# Install deps in one go (faster layer, fewer resolver runs)
echo Installing libraries
python -m pip install --no-cache-dir \
  "Django>=5" "uvicorn>=0.30" "psycopg[binary]>=3.2" "whitenoise>=6.7" "djangorestframework>=3.15" "djangorestframework-simplejwt" "mozilla-django-oidc" "nats-py" "nkeys" "pynacl"

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
if [ "$DJANGO_SUPERUSER_USERNAME" ]; then
  python manage.py createsuperuser \
    --noinput \
    --username "$DJANGO_SUPERUSER_USERNAME" \
    --email "$DJANGO_SUPERUSER_EMAIL" || true
fi

WORKERS=$(nproc)

echo Workers: $WORKERS

# Launch Django via Uvicorn (ASGI)
echo Launching
exec python -m uvicorn testsite.asgi:application --host 0.0.0.0 --port 8000 --workers $WORKERS
