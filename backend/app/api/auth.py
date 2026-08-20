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
from ..schemas.user import (
    LoginRequest,
    TokenResponse,
    UserCreate,
    UserOut,
    UserRegister,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/auth", tags=["auth"])

# One message for both "no such user" and "wrong password". Distinguishing them
# would let an attacker enumerate valid usernames.
_BAD_CREDENTIALS = "用户名或密码错误"

# Registration counts into its own throttle bucket, not the login one.
#
# throttle._buckets is keyed by an arbitrary string, so a prefix is all that is
# needed. They must stay separate because a successful login calls
# clear_attempts(ip), which pops the whole bucket — sharing it would let
# "register, log in, register, log in" reset the counter after every account and
# defeat the registration limit entirely, at two requests per account.
#
# The trade-off accepted here: registration floods no longer lock out logins from
# the same address. The two surfaces are metered independently, which is correct.
_REGISTER_BUCKET = "register:"


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

    # Checked here as well as in deps.get_current_user, and on purpose. Without
    # it a disabled account still receives 200 and a freshly minted token — whose
    # `iat` is current, so it clears the password_changed_at check — and only
    # then fails on every subsequent request. That reads as "I can log in but
    # nothing works", which looks like an outage rather than a disabled account.
    #
    # Deliberately not the _BAD_CREDENTIALS message: that wording exists to stop
    # username enumeration, and reaching this line means the caller already
    # supplied the correct username *and* password. Staying vague past that point
    # protects nothing and just makes the user retry.
    if not user.is_active:
        logger.info("Login refused for disabled account %r from %s", user.username, ip)
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="账号已被禁用，请联系管理员",
        )

    clear_attempts(ip)
    token = create_access_token(
        {"sub": user.username},
        expires_delta=timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES),
    )
    logger.info("Successful login for %r from %s", user.username, ip)
    return TokenResponse(access_token=token, user=UserOut.model_validate(user))


@router.post("/register", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
def register(body: UserRegister, request: Request, db: Session = Depends(get_db)):
    """Create an account and log it straight in.

    A new account starts with no config row of its own, so it cannot call the
    image endpoints until its owner supplies a baseurl and api_key — nothing here
    grants access to the operator's upstream quota.
    """
    if not settings.ALLOW_REGISTRATION:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="注册已关闭，请联系管理员",
        )

    ip = _client_ip(request)
    bucket = _REGISTER_BUCKET + ip

    allowed, retry_after = check_rate_limit(bucket)
    if not allowed:
        logger.warning("Registration throttled for %s", ip)
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"注册尝试过于频繁，请 {retry_after} 秒后再试",
            headers={"Retry-After": str(retry_after)},
        )

    # Recorded before the attempt resolves, and never cleared on success. Unlike
    # login — where success proves the caller owns the account and clearing is
    # fair — success here *is* the action being limited, so clearing would leave
    # the cap applying only to failed registrations.
    record_attempt(bucket)

    try:
        user = user_crud.create_user(
            db, UserCreate(username=body.username, password=body.password)
        )
    except user_crud.UsernameTaken:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="用户名已被占用",
        )

    token = create_access_token(
        {"sub": user.username},
        expires_delta=timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES),
    )
    logger.info("Registered new account %r from %s", user.username, ip)
    return TokenResponse(access_token=token, user=UserOut.model_validate(user))


@router.get("/me", response_model=UserOut)
def get_me(current_user=Depends(get_current_user)):
    """Token validity probe. The frontend calls this on boot: a persisted token
    that no longer verifies has to be discarded before the UI trusts it."""
    return current_user
