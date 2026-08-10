"""In-memory login throttle — per-IP sliding window, then a lockout.

State lives in process memory and resets on restart. For a single-process
deployment that is an accepted trade-off: a restart clears an active lockout,
but a restart is also not something a remote caller can trigger.

The two knobs do different jobs, and the distinction is the whole point:

- ``LOGIN_WINDOW_SECONDS`` / ``LOGIN_MAX_ATTEMPTS`` decide *when* an IP has tried
  too often. Attempts older than the window are forgotten, so occasional typos
  spread over an afternoon never accumulate into a block.
- ``LOGIN_LOCKOUT_SECONDS`` is how long the block then lasts. It is deliberately
  longer than the window — once the limit is hit, simply waiting for the window
  to slide must not be enough, or the limit would only cap the request *rate*
  rather than the total number of guesses.

Retry-After is computed from the lockout deadline actually being enforced, so
the value handed to the client is the real wait, not an estimate.
"""

import logging
import math
import threading
import time

from .config import settings

logger = logging.getLogger(__name__)

# Upper bound on tracked addresses. Without one, a caller rotating source
# addresses (or plain traffic over a long uptime) grows this table forever.
_MAX_TRACKED_IPS = 20_000


class _Bucket:
    __slots__ = ("attempts", "locked_until")

    def __init__(self) -> None:
        self.attempts: list[float] = []
        self.locked_until: float = 0.0

    def last_seen(self) -> float:
        recent = self.attempts[-1] if self.attempts else 0.0
        return max(recent, self.locked_until)

    def constrains_nothing(self, now: float) -> bool:
        """True when dropping this entry would change no future decision."""
        return not self.attempts and self.locked_until <= now


_buckets: dict[str, _Bucket] = {}

# Guards _buckets and the fields of the buckets in it. Read-modify-write on an
# attempt list is not atomic, and uvicorn dispatches sync endpoints to a
# threadpool, so two logins really can interleave here.
_lock = threading.Lock()


def _forget_old_attempts(bucket: _Bucket, now: float) -> None:
    """Drop attempts that have aged out of the window. Caller holds _lock."""
    cutoff = now - settings.LOGIN_WINDOW_SECONDS
    bucket.attempts = [t for t in bucket.attempts if t > cutoff]


def _prune(now: float) -> None:
    """Keep the table bounded. Caller holds _lock."""
    if len(_buckets) < _MAX_TRACKED_IPS:
        return

    for ip in [ip for ip, b in _buckets.items() if b.constrains_nothing(now)]:
        del _buckets[ip]

    if len(_buckets) < _MAX_TRACKED_IPS:
        return

    # Everything left is still live, so something has to give. Drop the least
    # recently active quarter: the cost of forgetting an old bucket is at worst
    # a few extra attempts for that address, and keeping the newest entries is
    # what preserves the lockouts that were set most recently.
    ordered = sorted(_buckets.items(), key=lambda kv: kv[1].last_seen())
    for ip, _ in ordered[: max(1, len(_buckets) // 4)]:
        del _buckets[ip]
    logger.warning(
        "Login throttle table reached %d entries; pruned to %d.",
        _MAX_TRACKED_IPS, len(_buckets),
    )


def check_rate_limit(ip: str) -> tuple[bool, int]:
    """Return ``(allowed, retry_after_seconds)``.

    ``retry_after_seconds`` is 0 when allowed, and otherwise the real remaining
    lockout in seconds — safe to hand straight to a Retry-After header.
    """
    now = time.monotonic()
    with _lock:
        bucket = _buckets.get(ip)
        if bucket is None:
            return True, 0

        if bucket.locked_until > now:
            return False, max(1, math.ceil(bucket.locked_until - now))

        _forget_old_attempts(bucket, now)
        return True, 0


def record_attempt(ip: str) -> None:
    """Record one login attempt, and start a lockout if this one crosses the
    limit. Call for every attempt, successful or not."""
    now = time.monotonic()
    with _lock:
        _prune(now)

        bucket = _buckets.get(ip)
        if bucket is None:
            bucket = _buckets[ip] = _Bucket()

        _forget_old_attempts(bucket, now)
        bucket.attempts.append(now)

        if len(bucket.attempts) >= settings.LOGIN_MAX_ATTEMPTS:
            bucket.locked_until = now + settings.LOGIN_LOCKOUT_SECONDS
            # Cleared so the lockout expiring leaves a clean slate rather than a
            # bucket that is still at the limit and re-locks on the next try.
            bucket.attempts.clear()
            logger.warning(
                "Login locked out %s for %ds after %d attempts within %ds.",
                ip, settings.LOGIN_LOCKOUT_SECONDS,
                settings.LOGIN_MAX_ATTEMPTS, settings.LOGIN_WINDOW_SECONDS,
            )


def clear_attempts(ip: str) -> None:
    """Forget an address's history after it authenticates successfully."""
    with _lock:
        _buckets.pop(ip, None)
