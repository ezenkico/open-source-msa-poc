#!/usr/bin/env python3
"""
setup_db.py — Ensure POSTGRES_DB exists, using the same POSTGRES_* env vars
you already use in Django settings and docker-compose for postgres.

Env:
  POSTGRES_HOST=postgres
  POSTGRES_PORT=5432
  POSTGRES_USER=postgres         # superuser created by the postgres image
  POSTGRES_PASSWORD=postgres
  POSTGRES_DB=django_db          # target app DB (same as Django NAME)
"""
import os
import sys
import time
import psycopg

PGHOST = os.getenv("POSTGRES_HOST", "postgres")
PGPORT = int(os.getenv("POSTGRES_PORT", "5432"))
PGUSER = os.getenv("POSTGRES_USER", "base_user")
PGPASS = os.getenv("POSTGRES_PASSWORD", "strongpassword")
APPDB  = os.getenv("POSTGRES_DB", "django_db")

def wait_for_server(timeout=60):
    start = time.time()
    while True:
        try:
            with psycopg.connect(
                host=PGHOST, port=PGPORT, user=PGUSER, password=PGPASS,
                dbname="postgres", connect_timeout=3
            ):
                return
        except Exception as e:
            if time.time() - start > timeout:
                print(f"Timed out waiting for Postgres: {e}", file=sys.stderr)
                sys.exit(1)
            time.sleep(1)

def ensure_db():
    with psycopg.connect(
        host=PGHOST, port=PGPORT, user=PGUSER, password=PGPASS,
        dbname="postgres", autocommit=True
    ) as con:
        with con.cursor() as cur:
            cur.execute("SELECT 1 FROM pg_database WHERE datname = %s", (APPDB,))
            if cur.fetchone():
                print(f"Database '{APPDB}' exists.")
                return
            cur.execute(f'CREATE DATABASE "{APPDB}"')
            print(f"Database '{APPDB}' created.")

if __name__ == "__main__":
    wait_for_server()
    ensure_db()
