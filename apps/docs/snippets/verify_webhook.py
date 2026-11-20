import hashlib
import hmac
import time


def verify_usher_webhook(secret: str, body: bytes, header: str | None, tolerance: int = 300) -> bool:
    """Check the Usher-Signature header: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`."""
    if not header:
        return False
    parts = dict(p.split("=", 1) for p in header.split(",") if "=" in p)
    t, signature = parts.get("t", ""), parts.get("v1", "")
    if not t.isdigit() or abs(time.time() - int(t)) > tolerance:
        return False
    expected = hmac.new(secret.encode(), t.encode() + b"." + body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)


# Django: verify_usher_webhook(SECRET, request.body, request.headers.get("Usher-Signature"))
# Flask:  verify_usher_webhook(SECRET, request.get_data(), request.headers.get("Usher-Signature"))
