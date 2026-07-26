import base64
import secrets

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from django.conf import settings


def _master_key() -> bytes:
    try:
        key = base64.b64decode(
            settings.DEVICE_KEY_ENCRYPTION_KEY, validate=True
        )
    except Exception as exc:
        raise ValueError("DEVICE_KEY_ENCRYPTION_KEY must be valid base64") from exc
    if len(key) != 32:
        raise ValueError("DEVICE_KEY_ENCRYPTION_KEY must decode to 32 bytes")
    return key


def generate_device_key() -> bytes:
    return secrets.token_bytes(32)


def encode_device_key(key: bytes) -> str:
    return base64.b64encode(key).decode("ascii")


def encrypt_device_key(key: bytes) -> tuple[bytes, bytes]:
    nonce = secrets.token_bytes(12)
    return AESGCM(_master_key()).encrypt(nonce, key, None), nonce


def decrypt_device_key(ciphertext: bytes, nonce: bytes) -> bytes:
    return AESGCM(_master_key()).decrypt(nonce, ciphertext, None)
