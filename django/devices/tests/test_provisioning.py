import base64
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import override_settings
from rest_framework.test import APITestCase

from devices.crypto import decrypt_device_key
from devices.models import Device


MASTER_KEY = base64.b64encode(b"m" * 32).decode()


@override_settings(DEVICE_KEY_ENCRYPTION_KEY=MASTER_KEY)
class DeviceProvisioningTests(APITestCase):
    def setUp(self):
        self.staff = get_user_model().objects.create_user(
            username="staff", password="password", is_staff=True
        )
        self.user = get_user_model().objects.create_user(
            username="user", password="password"
        )

    def test_staff_creates_device_and_receives_plaintext_key_once(self):
        self.client.force_authenticate(self.staff)
        response = self.client.post("/api/devices/", {"name": "simulator"})
        self.assertEqual(response.status_code, 201)
        device = Device.objects.get(id=response.data["id"])
        returned_key = base64.b64decode(response.data["key"])
        self.assertEqual(
            decrypt_device_key(device.key_ciphertext, device.key_nonce),
            returned_key,
        )
        self.assertNotIn(returned_key, bytes(device.key_ciphertext))

        listing = self.client.get("/api/devices/")
        self.assertNotIn("key", listing.data[0])

    @patch("devices.views.publish_device_created_best_effort")
    def test_staff_provisioning_schedules_device_created_event(self, publish):
        self.client.force_authenticate(self.staff)

        with self.captureOnCommitCallbacks(execute=True) as callbacks:
            response = self.client.post("/api/devices/", {"name": "simulator"})

        self.assertEqual(response.status_code, 201)
        self.assertIn("key", response.data)
        self.assertEqual(len(callbacks), 1)
        publish.assert_called_once_with(Device.objects.get(id=response.data["id"]).id)

    def test_non_staff_cannot_create_or_rotate(self):
        self.client.force_authenticate(self.user)
        create = self.client.post("/api/devices/", {"name": "blocked"})
        self.assertEqual(create.status_code, 403)

        device = Device.objects.create(
            name="existing", key_ciphertext=b"ciphertext", key_nonce=b"nonce"
        )
        old_ciphertext = bytes(device.key_ciphertext)
        old_nonce = bytes(device.key_nonce)
        rotate = self.client.post(f"/api/devices/{device.id}/rotate-key/")
        self.assertEqual(rotate.status_code, 403)
        device.refresh_from_db()
        self.assertEqual(bytes(device.key_ciphertext), old_ciphertext)
        self.assertEqual(bytes(device.key_nonce), old_nonce)

    def test_non_staff_can_list_devices_without_keys(self):
        Device.objects.create(
            name="existing", key_ciphertext=b"ciphertext", key_nonce=b"nonce"
        )
        self.client.force_authenticate(self.user)

        listing = self.client.get("/api/devices/")

        self.assertEqual(listing.status_code, 200)
        self.assertEqual(listing.data[0]["name"], "existing")
        self.assertNotIn("key", listing.data[0])

    def test_rotation_replaces_key_and_nonce(self):
        self.client.force_authenticate(self.staff)
        created = self.client.post("/api/devices/", {"name": "simulator"})
        device = Device.objects.get(id=created.data["id"])
        old_ciphertext = bytes(device.key_ciphertext)
        old_nonce = bytes(device.key_nonce)

        rotated = self.client.post(f"/api/devices/{device.id}/rotate-key/")
        self.assertEqual(rotated.status_code, 200)
        device.refresh_from_db()
        self.assertNotEqual(bytes(device.key_ciphertext), old_ciphertext)
        self.assertNotEqual(bytes(device.key_nonce), old_nonce)
        self.assertNotEqual(rotated.data["key"], created.data["key"])
