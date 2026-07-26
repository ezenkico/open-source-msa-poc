import hashlib
import hmac


def verify_device_signature(key: bytes, body: bytes, header: str) -> bool:
    prefix = "sha256="
    if not header.startswith(prefix):
        return False
    supplied = header[len(prefix) :]
    if len(supplied) != 64:
        return False
    expected = hmac.new(key, body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, supplied.lower())
