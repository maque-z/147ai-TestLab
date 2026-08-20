"""Request dependencies.

The rule this file exists to enforce: **no pooled database connection is held
across an upstream image request.** A generation takes 60-120s, and SQLAlchemy
keeps a connection checked out from the first query until the session closes —
not until the query returns. With `Depends(get_db)` on an endpoint, that
connection stays checked out for the whole upstream call, so the pool caps how
many generations can be in flight at once. The frontend fires up to 50; the pool
holds 40; requests past that used to fail on pool checkout after 30s and surface
as an upstream error, which is the one thing this tool must not get wrong.

So every dependency here owns a short-lived session and closes it before
returning. What comes back is either a detached ORM instance whose columns are
already loaded, or a plain frozen snapshot — nothing that needs a live session.
"""

from dataclasses import dataclass
from datetime import timezone

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .database import SessionLocal
from .security import decode_token
from ..crud import user as user_crud

security = HTTPBearer()


def _issued_before_password_change(iat, password_changed_at) -> bool:
    """True when this token predates the account's last password change.

    The one-second trap this exists to avoid: `iat` is whole seconds by RFC 7519,
    while password_changed_at is a microsecond-precision datetime. An admin who
    resets a password at 10:00:00.500 and a user who logs in at 10:00:00.700 would
    otherwise produce a token whose iat (10:00:00) is *below* the stored value —
    the token would be rejected the instant it was issued, and the account would
    look permanently unable to log in.

    Flooring the stored value to the same whole second removes that. The cost is
    that a token minted earlier in the same second as the reset survives one extra
    check; that window is meaningless, whereas "user can never log in" is a real
    outage.

    A token with no `iat` at all predates this feature entirely, so it is treated
    as too old — those tokens are already invalid for other reasons after the
    upgrade, and refusing them costs one re-login.
    """
    if password_changed_at is None:
        return False
    if iat is None:
        return True

    # Stored naive: SQLite drops the offset on write, so what comes back is a
    # naive value that is already UTC. Rows written by the ORM default before a
    # refresh can still be aware, so normalise rather than assume.
    changed = password_changed_at
    if changed.tzinfo is None:
        changed = changed.replace(tzinfo=timezone.utc)

    return int(iat) < int(changed.timestamp())


def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
):
    """The authenticated user, as a detached instance.

    Uses its own session rather than `Depends(get_db)` so the connection is back
    in the pool before the endpoint body runs. The returned object is therefore
    detached, which is fine because the lookup below loads every column and none
    are deferred — and it is only ever read for `id` and `username`. It is
    deliberately not usable for writes; endpoints that write take their own
    session via `Depends(get_db)`.
    """
    payload = decode_token(credentials.credentials)
    if payload is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication credentials"
        )

    username: str = payload.get("sub")
    if username is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token payload"
        )

    db = SessionLocal()
    try:
        user = user_crud.get_user_by_username(db, username=username)
    finally:
        db.close()

    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found"
        )

    # Both checks below reuse the row already fetched above — no extra round trip.
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="账号已被禁用",
        )

    if _issued_before_password_change(payload.get("iat"), user.password_changed_at):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="密码已变更，请重新登录",
        )

    return user


def get_current_admin(current_user=Depends(get_current_user)):
    """The authenticated user, refused unless they are an administrator.

    Layered on get_current_user rather than repeating the lookup: that dependency
    already fetched the row with every column loaded, so reading is_admin here
    costs nothing. It is also the single place where is_active and token age are
    enforced, and admin routes must not bypass either.
    """
    if not current_user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="需要管理员权限",
        )
    return current_user


@dataclass(frozen=True)
class UpstreamConfig:
    """Everything needed to call an upstream, copied out of the database.

    A plain snapshot rather than the ORM row: the row belongs to a session, and
    holding one open across the upstream call is exactly what this module exists
    to prevent. Frozen because it is read-only by the time it gets here — an
    endpoint that mutated it would be writing to a copy and silently losing it.
    """
    baseurl: str
    api_key: str
    model_id: str
    timeout: int


def snapshot_config(cfg, *, key_hint: str = "API Key") -> UpstreamConfig:
    """Validate a config row and copy it into an UpstreamConfig.

    Both surfaces check the same two fields, so the messages live here rather
    than being written twice. An unconfigured deploy has to fail here: an empty
    baseurl reaches httpx as a relative URL and comes back as a 502 wrapping an
    internal exception string, which reads like the upstream is broken.
    """
    if not cfg.api_key:
        raise HTTPException(status_code=400, detail=f"请先在配置中填写 {key_hint}")
    if not cfg.baseurl:
        raise HTTPException(status_code=400, detail="请先在配置中填写 Base URL")
    return UpstreamConfig(
        baseurl=cfg.baseurl,
        api_key=cfg.api_key,
        model_id=cfg.model_id or "",
        # A null timeout would hand httpx "wait forever" and pin a worker on a
        # hung upstream. Falls back to the column default.
        timeout=cfg.timeout or 480,
    )


def get_image_config(current_user=Depends(get_current_user)) -> UpstreamConfig:
    """The gpt-image connection settings, with the session already closed."""
    db = SessionLocal()
    try:
        cfg = user_crud.get_image_config(db, current_user.id)
        return snapshot_config(cfg)
    finally:
        db.close()


def get_banana_config(current_user=Depends(get_current_user)) -> UpstreamConfig:
    """The Gemini connection settings, with the session already closed."""
    db = SessionLocal()
    try:
        cfg = user_crud.get_banana_config(db, current_user.id)
        return snapshot_config(cfg)
    finally:
        db.close()
