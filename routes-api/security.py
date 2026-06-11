"""Bringaterv API – jelszó hash és JWT token kezelés."""

from datetime import datetime, timedelta, timezone

from config import JWT_EXPIRY_DAYS, JWT_SECRET

try:
    import jwt as pyjwt
    import bcrypt
except ImportError as exc:
    raise ImportError(
        "PyJWT és bcrypt szükséges. Telepítsd: pip install PyJWT bcrypt"
    ) from exc


def _hash_pw(plain: str) -> str:
    return bcrypt.hashpw(plain.encode(), bcrypt.gensalt()).decode()


def _check_pw(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode(), hashed.encode())


def _make_token(user_id: str, email: str, role: str) -> str:
    return pyjwt.encode(
        {
            "sub":   user_id,
            "email": email,
            "role":  role,
            "iat":   datetime.now(timezone.utc),
            "exp":   datetime.now(timezone.utc) + timedelta(days=JWT_EXPIRY_DAYS),
        },
        JWT_SECRET,
        algorithm="HS256",
    )


def _decode_token(token: str) -> dict:
    return pyjwt.decode(token, JWT_SECRET, algorithms=["HS256"])
