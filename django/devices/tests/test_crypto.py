import base64
from unittest.mock import patch

from django.test import SimpleTestCase, override_settings

from devices.crypto import (
    decrypt_device_key,
    encode_device_key,
    encrypt_device_key,
    generate_device_key,
)


MASTER_KEY = base64.b64encode(b"m" * 32).decode()


@override_settings(DEVICE_KEY_ENCRYPTION_KEY=MASTER_KEY)
class DeviceCryptoTests(SimpleTestCase):
    def test_round_trip_uses_distinct_nonce_each_time(self):
        key = generate_device_key()
        first_ciphertext, first_nonce = encrypt_device_key(key)
        second_ciphertext, second_nonce = encrypt_device_key(key)

        self.assertEqual(len(key), 32)
        self.assertNotEqual(first_nonce, second_nonce)
        self.assertEqual(decrypt_device_key(first_ciphertext, first_nonce), key)
        self.assertEqual(decrypt_device_key(second_ciphertext, second_nonce), key)
        self.assertEqual(base64.b64decode(encode_device_key(key)), key)

    @patch("devices.crypto.base64.b64decode", side_effect=ValueError)
    def test_invalid_master_key_fails_closed(self, _decode):
        with self.assertRaisesMessage(ValueError, "DEVICE_KEY_ENCRYPTION_KEY"):
            encrypt_device_key(b"k" * 32)
