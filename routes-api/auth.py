"""Bringaterv API – auth dekorátorok (JWT ellenőrzés, admin jogkör)."""

from functools import wraps

import jwt as pyjwt
from flask import abort, g, request

from db import _db
from security import _decode_token


def require_auth(f):
    """JWT ellenőrzés."""
    @wraps(f)
    def wrapper(*args, **kwargs):
        header = request.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            abort(401, description="Hiányzó token")
        try:
            payload = _decode_token(header[7:])
        except pyjwt.ExpiredSignatureError:
            abort(401, description="Lejárt token")
        except pyjwt.InvalidTokenError:
            abort(401, description="Érvénytelen token")
        with _db() as conn:
            user = conn.execute(
                "SELECT * FROM users WHERE id = ? AND active = 1", (payload["sub"],)
            ).fetchone()
        if not user:
            abort(401, description="Ismeretlen vagy tiltott felhasználó")
        g.user = dict(user)
        return f(*args, **kwargs)
    return wrapper


def require_admin(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if g.user.get("role") != "admin":
            abort(403, description="Admin jogkör szükséges")
        return f(*args, **kwargs)
    return wrapper
