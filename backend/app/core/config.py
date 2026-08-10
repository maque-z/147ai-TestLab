import logging
import secrets
from pathlib import Path

from pydantic_settings import BaseSettings

logger = logging.getLogger(__name__)

# Values that must never be used to sign tokens. A JWT signed with a key that is
# published in the repo can be forged by anyone who has read it, which makes the
# password check irrelevant: an attacker mints their own valid token instead.
_WEAK_SECRETS = {
    "",
    "change-me-in-production",
    "change-this-to-a-long-random-string",
    "secret",
    "changeme",
}

# Persisted next to the database so tokens survive a restart. Regenerating on
# every boot would sign out every user whenever the container restarts.
_KEY_FILE = Path("data/.secret_key")


def _resolve_secret_key(configured: str) -> str:
    """Return a signing key that is not a published constant.

    An explicit SECRET_KEY from the environment always wins — that is the
    production path. When it is missing or is one of the placeholder values, a
    random key is generated and persisted, so a fresh deploy is never
    accidentally left signing tokens with a value from source control.
    """
    if configured and configured not in _WEAK_SECRETS:
        return configured

    try:
        if _KEY_FILE.exists():
            existing = _KEY_FILE.read_text(encoding="utf-8").strip()
            if existing and existing not in _WEAK_SECRETS:
                return existing

        generated = secrets.token_urlsafe(64)
        _KEY_FILE.parent.mkdir(parents=True, exist_ok=True)
        _KEY_FILE.write_text(generated, encoding="utf-8")
        # 0600 where the platform honours it; harmless no-op on Windows.
        try:
            _KEY_FILE.chmod(0o600)
        except OSError:
            pass
        logger.warning(
            "SECRET_KEY was unset or a placeholder. Generated a random key at %s. "
            "Set SECRET_KEY in the environment for production deployments.",
            _KEY_FILE,
        )
        return generated
    except OSError as exc:
        # Read-only filesystem: still refuse to fall back to the published
        # constant. A per-process key logs everyone out on restart, which is
        # disruptive but not a security hole.
        logger.error(
            "Could not persist a generated SECRET_KEY (%s). Using a per-process "
            "key; all sessions will be invalidated on restart.", exc,
        )
        return secrets.token_urlsafe(64)


class Settings(BaseSettings):
    SECRET_KEY: str = ""
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24 * 7  # 7 days
    DATABASE_URL: str = "sqlite:///./data/lab.db"

    # Seeded on startup when absent. Registration is closed, so without this
    # there would be no way into a fresh deployment.
    DEFAULT_USERNAME: str = "147ai"
    DEFAULT_PASSWORD: str = ""

    # Login throttling, per client IP. MAX_ATTEMPTS within WINDOW_SECONDS trips a
    # lockout lasting LOCKOUT_SECONDS. The lockout is longer than the window on
    # purpose — otherwise waiting for the window to slide would be enough, and
    # the limit would cap the guess rate rather than the number of guesses.
    LOGIN_MAX_ATTEMPTS: int = 8
    LOGIN_WINDOW_SECONDS: int = 300
    LOGIN_LOCKOUT_SECONDS: int = 900

    # Browser origins allowed to call the API. Same-origin deployments (nginx
    # serving dist/ and proxying /api/) need no entry here.
    CORS_ORIGINS: str = "http://localhost:5173,http://127.0.0.1:5173,http://127.0.0.1:8080"

    class Config:
        env_file = ".env"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]


settings = Settings()
# Resolved once at import so every module sees the same key.
settings.SECRET_KEY = _resolve_secret_key(settings.SECRET_KEY)
