from datetime import timedelta

import jwt
from django.conf import settings
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APITestCase
from rest_framework_simplejwt.tokens import AccessToken


class NatsAuthorizationTests(APITestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(
            username="browser", password="password"
        )

    def test_nats_token_is_short_lived_and_authorizes_subscribe_only(self):
        self.client.force_authenticate(self.user)
        token_response = self.client.get("/api/nats-auth/token/")
        self.assertEqual(token_response.status_code, 200)

        payload = jwt.decode(
            token_response.data["token"],
            settings.SIMPLE_JWT["SIGNING_KEY"],
            algorithms=[settings.SIMPLE_JWT["ALGORITHM"]],
        )
        self.assertEqual(payload["token_type"], "nats")
        self.assertEqual(payload["exp"] - payload["iat"], 5 * 60)

        self.client.force_authenticate(user=None)
        permission_response = self.client.get(
            "/api/nats-auth/perms/",
            HTTP_AUTHORIZATION=f"Bearer {token_response.data['token']}",
        )
        self.assertEqual(permission_response.status_code, 200)
        self.assertEqual(
            permission_response.data,
            {
                "account": "APP",
                "pub": {"allow": [], "deny": ["devices.>"]},
                "sub": {
                    "allow": ["devices.*.measurements"],
                    "deny": [],
                },
            },
        )

    def test_normal_access_token_is_not_a_nats_token(self):
        login = self.client.post(
            "/api/auth/jwt/",
            {"username": "browser", "password": "password"},
        )
        response = self.client.get(
            "/api/nats-auth/perms/",
            HTTP_AUTHORIZATION=f"Bearer {login.data['access']}",
        )
        self.assertEqual(response.status_code, 401)

    def test_invalid_and_expired_tokens_are_denied(self):
        invalid_response = self.client.get(
            "/api/nats-auth/perms/",
            HTTP_AUTHORIZATION="Bearer invalid",
        )
        self.assertEqual(invalid_response.status_code, 401)

        expired_token = AccessToken.for_user(self.user)
        expired_token["token_type"] = "nats"
        expired_token.set_exp(
            from_time=timezone.now(), lifetime=timedelta(seconds=-1)
        )
        expired_response = self.client.get(
            "/api/nats-auth/perms/",
            HTTP_AUTHORIZATION=f"Bearer {expired_token}",
        )
        self.assertEqual(expired_response.status_code, 401)
