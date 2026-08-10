"""In-memory login throttle — per-IP sliding window + lockout.

Stored in process memory, so it resets on restart. That is acceptable for a
single-process deployment: a restart after too many attempts is exactly what an
attacker learns from a lockout, and the cost to us is zero.

Thread-safety comes from Python's GIL holding across dict reads and list
appends; no explicit lock is needed for CPython.
"""

import time
from collections import defaultdict

from .config import settings


class _IPBucket:
    __slots__ = ("attempts",)

    def __init__(self) -> None:
        self.attempts: list[float] = []


_buckets: dict[str, _IPBucket] = defaultdict(_IPBucket)


def _evict(bucket: _IPBucket, now: float) -> None:
    cutoff = now - settings.LOGIN_WINDOW_SECONDS
    bucket.attempts = [t for t in bucket.attempts if t > cutoff]


def check_rate_limit(ip: str) -> tuple[bool, int]:
    """Return ``(allowed, retry_after_seconds)``.

    ``allowed`` is False when the IP must wait; ``retry_after_seconds`` is how
    long it must wait before the next attempt will be accepted (0 when allowed).
    """
    now = time.monotonic()
    bucket = _buckets[ip]
    _evict(bucket, now)

    if len(bucket.attempts) >= settings.LOGIN_MAX_ATTEMPTS:
        oldest = bucket.attempts[0]
        retry_after = int(settings.LOGIN_LOCKOUT_SECONDS - (now - oldest)) + 1
        return False, max(retry_after, 1)

    return True, 0


def record_attempt(ip: str) -> None:
    """Record one login attempt (call regardless of success or failure)."""
    now = time.monotonic()
    bucket = _buckets[ip]
    _evict(bucket, now)
    bucket.attempts.append(now)


def clear_attempts(ip: str) -> None:
    """Clear the failure history for an IP after a successful login."""
    if ip in _buckets:
        _buckets[ip].attempts.clear()
