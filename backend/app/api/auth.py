import logging
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from ..core.config import settings
from ..core.database import get_db
from ..core.deps import get_current_user
from ..core.security import create_access_token, verify_password
from ..core.throttle import check_rate_limit, clear_attempts, record_attempt
from ..crud import user as user_crud
from ..schemas.user import LoginRequest, TokenResponse, UserCreate, UserOut

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/auth", tags=["auth"])

# One message for both "no such user" and "wrong password". Distinguishing them
# would let an attacker enumerate valid usernames.
_BAD_CREDENTIALS = "用户名或密码错误"


def _client_ip(request: Request) -> str:
    """Best-effort client IP for throttling.

    X-Forwarded-For is only trusted for its first entry, and only because this
    app is expected to sit behind a reverse proxy that sets it. It is used for
    rate-limit bucketing only — never for authorisation.
    """
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


@router.post("/login", response_model=TokenResponse)
def login(body: LoginRequest, request: Request, db: Session = Depends(get_db)):
    ip = _client_ip(request)

    allowed, retry_after = check_rate_limit(ip)
    if not allowed:
        logger.warning("Login throttled for %s", ip)
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"登录尝试过于频繁，请 {retry_after} 秒后再试",
            headers={"Retry-After": str(retry_after)},
        )

    record_attempt(ip)

    user = user_crud.get_user_by_username(db, body.username)
    # verify_password is called even when the user is missing, against a dummy
    # hash, so a wrong username and a wrong password take the same time. Skipping
    # it for unknown users makes them distinguishable by response latency.
    if user is None:
        verify_password(body.password, "$2b$12$" + "x" * 53)
        logger.info("Failed login for unknown user %r from %s", body.username, ip)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail=_BAD_CREDENTIALS
        )

    if not verify_password(body.password, user.hashed_password):
        logger.info("Failed login for %r from %s", body.username, ip)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail=_BAD_CREDENTIALS
        )

    clear_attempts(ip)
    token = create_access_token(
        {"sub": user.username},
        expires_delta=timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES),
    )
    logger.info("Successful login for %r from %s", user.username, ip)
    return TokenResponse(access_token=token, user=UserOut.model_validate(user))


@router.post("/register", response_model=TokenResponse)
def register(body: UserCreate, db: Session = Depends(get_db)):
    """Closed. Kept as a route so the client gets this message rather than a 404
    that reads like a deployment fault."""
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="暂未开放注册功能，请用账号登录",
    )


@router.get("/me", response_model=UserOut)
def get_me(current_user=Depends(get_current_user)):
    """Token validity probe. The frontend calls this on boot: a persisted token
    that no longer verifies has to be discarded before the UI trusts it."""
    return current_user
