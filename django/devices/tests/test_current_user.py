from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase


class CurrentUserCapabilityTests(APITestCase):
    def setUp(self):
        self.staff = get_user_model().objects.create_user(
            username="staff", password="password", is_staff=True
        )
        self.user = get_user_model().objects.create_user(
            username="user", password="password"
        )

    def test_staff_can_add_devices(self):
        self.client.force_authenticate(self.staff)

        response = self.client.get("/api/auth/me/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, {"can_add_devices": True})

    def test_non_staff_cannot_add_devices(self):
        self.client.force_authenticate(self.user)

        response = self.client.get("/api/auth/me/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, {"can_add_devices": False})

    def test_unauthenticated_request_is_rejected(self):
        response = self.client.get("/api/auth/me/")

        self.assertEqual(response.status_code, 401)
