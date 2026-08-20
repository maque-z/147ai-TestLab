import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

import bcrypt
from jose import JWTError, jwt

from .config import settings

logger = logging.getLogger(__name__)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    try:
        return bcrypt.checkpw(
            plain_password.encode("utf-8"), hashed_password.encode("utf-8")
        )
    except Exception:
        # A malformed hash in the database is a data problem, not a reason to
        # return 500 from the login route. Treat it as "does not match".
        logger.warning("bcrypt verification failed — malformed hash in database")
        return False


def get_password_hash(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    # timezone-aware: datetime.utcnow() is deprecated in 3.12 and produces a
    # naive value that python-jose encodes against a different reference.
    now = datetime.now(timezone.utc)
    # `iat` is what makes these tokens revocable. deps.get_current_user compares
    # it against the account's password_changed_at, so a password reset (or any
    # future event that bumps that column) invalidates every token minted before
    # it — without the server having to store a single session.
    #
    # python-jose converts a datetime in `iat`/`exp`/`nbf` via
    # timegm(value.utctimetuple()), which drops sub-second precision. The claim
    # therefore lands as whole seconds; deps compensates. See RFC 7519 §4.1.6.
    to_encode["iat"] = now
    to_encode["exp"] = now + (
        expires_delta or timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    )
    to_encode.setdefault("type", "access")
    return jwt.encode(to_encode, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def decode_token(token: str) -> Optional[dict]:
    """Decode and validate a token, or None if it is not a usable access token.

    Signature and expiry are checked by python-jose. The explicit algorithm list
    matters: passing the header's own alg would let a caller downgrade to "none".
    """
    try:
        payload = jwt.decode(
            token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM]
        )
    except JWTError:
        return None

    if payload.get("type") != "access":
        return None
    return payload
