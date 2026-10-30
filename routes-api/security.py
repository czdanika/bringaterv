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


def password_problem(pw: str) -> str | None:
    """Jelszóerősség: legalább 8 karakter, nagybetű, szám és speciális karakter.
    Visszaadja a hibaüzenetet, vagy None-t, ha megfelel."""
    missing = []
    if len(pw) < 8: missing.append("legalább 8 karakter")
    if not any(c.isupper() for c in pw): missing.append("egy nagybetű")
    if not any(c.isdigit() for c in pw): missing.append("egy szám")
    if not any(not c.isalnum() and not c.isspace() for c in pw): missing.append("egy speciális karakter (pl. ! ? # - _)")
    return ("A jelszóhoz még kell: " + ", ".join(missing) + ".") if missing else None


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


def _make_impersonation_token(user_id: str, email: str, role: str, admin_id: str, hours: int = 2) -> str:
    """Admin „belépés a felhasználó nevében”: rövid életű, az admin azonosítóját (imp) is hordozza."""
    now = datetime.now(timezone.utc)
    return pyjwt.encode({"sub": user_id, "email": email, "role": role, "imp": admin_id,
                         "iat": now, "exp": now + timedelta(hours=hours)}, JWT_SECRET, algorithm="HS256")


def _decode_token(token: str) -> dict:
    return pyjwt.decode(token, JWT_SECRET, algorithms=["HS256"])
