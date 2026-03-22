#!/usr/bin/env python3
import requests
import re
import json

BASE_URL = "http://localhost:8000"
USERNAME = "admin"
PASSWORD = "admin"

# --- Health Check ---
print("=== Health Check ===")
resp = requests.get(
    f"{BASE_URL}/healthz"
)
print(resp.status_code)

# --- JWT LOGIN TEST ---
print("=== JWT login test ===")
resp = requests.post(
    f"{BASE_URL}/api/auth/jwt/",
    headers={"Content-Type": "application/json"},
    data=json.dumps({"username": USERNAME, "password": PASSWORD}),
)
print("JWT login:", resp.status_code)
data = resp.json()
print(json.dumps(data, indent=2))

# Use access token if present
if "access" in data:
    headers = {"Authorization": f"Bearer {data['access']}"}
    resp = requests.get(f"{BASE_URL}/api/temperature/latest/", headers=headers)
    print("Latest temperature (JWT):", resp.status_code)
    print(resp.text)
else:
    print("No access token returned.")
