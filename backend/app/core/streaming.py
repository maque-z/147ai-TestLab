"""Heartbeat-framed responses for the long upstream calls.

Why this exists: a generation takes 60-120s, and for that entire time a plain
JSON response sends nothing at all. Any device on the path that reaps idle
connections — a TUN proxy, a carrier NAT, a load balancer — cannot tell such a
connection apart from a dead one, so it closes it. That is not hypothetical: it
was observed as nginx logging 499 (client went away, 0 bytes sent) on every
generate request at the 60s mark, with the container healthy and still mid-call.

So the body is framed as newline-delimited JSON instead: a bare "\n" every few
seconds while the upstream call runs, then exactly one JSON line carrying the
result. The connection is never idle, so nothing on the path has a reason to
reap it.

The cost, and it is unavoidable: **an HTTP status code is committed the moment
the first byte leaves**, and that now happens long before the upstream answers.
Errors raised after that point therefore cannot be a 4xx/5xx — they travel in
the final line as ``{"ok": false, "status": ..., "detail": ...}`` and the
frontend re-raises them shaped like the axios error they used to be.

Everything that can fail *before* the upstream call — auth, param validation,
an unconfigured api_key, an oversized upload — deliberately stays outside this
wrapper and still raises HTTPException, because those paths answer in
milliseconds and a real status code is strictly better where one is available.
"""

import asyncio
import json
import logging
from typing import Any, AsyncIterator, Awaitable

from fastapi import HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

logger = logging.getLogger(__name__)

# Well under any idle timeout worth defending against. The observed reaper fired
# at 60s; 10s leaves a 6x margin, and the whole cost of being wrong in this
# direction is one byte.
HEARTBEAT_INTERVAL = 10.0

# Not application/json, and that is load-bearing: nginx's `gzip_types` lists
# application/json, and the gzip filter can hold a 1-byte write in its own
# buffer — which would defeat the heartbeat while looking like it works. No
# gzip_types list includes x-ndjson, so this sidesteps the filter entirely.
# The framing genuinely is newline-delimited JSON, so the type is also honest.
MEDIA_TYPE = "application/x-ndjson"


def _line(**fields: Any) -> bytes:
    """One NDJSON frame. ensure_ascii off so error text stays readable on the wire."""
    return (json.dumps(fields, ensure_ascii=False) + "\n").encode("utf-8")


async def _frames(work: Awaitable[BaseModel], interval: float) -> AsyncIterator[bytes]:
    """Heartbeats until `work` settles, then one terminal frame.

    asyncio.wait is used rather than wait_for because a timeout here means "still
    running, send a heartbeat" — wait_for would cancel the very call being waited
    on.
    """
    task = asyncio.ensure_future(work)
    try:
        while True:
            done, _ = await asyncio.wait({task}, timeout=interval)
            if done:
                break
            # NDJSON readers skip blank lines, so this is invisible to the parser
            # on the other end while still being real traffic on the socket.
            yield b"\n"

        try:
            result = task.result()
        # CancelledError is a BaseException, so it is not caught here and
        # propagates — which is correct: the only thing that cancels this task is
        # the `finally` below, i.e. the client already hung up.
        except HTTPException as exc:
            yield _line(ok=False, status=exc.status_code, detail=str(exc.detail))
        except Exception as exc:
            logger.exception("Unhandled error while streaming a generation")
            yield _line(
                ok=False,
                status=500,
                detail=str(exc) or exc.__class__.__name__,
            )
        else:
            yield _line(ok=True, data=result.model_dump(mode="json"))
    finally:
        # The client hung up, or a single card was stopped from the UI. Cancel the
        # upstream call rather than letting it run to completion — and bill — into
        # a socket nobody is reading.
        if not task.done():
            task.cancel()


def heartbeat_response(
    work: Awaitable[BaseModel], *, interval: float = HEARTBEAT_INTERVAL
) -> StreamingResponse:
    """Stream `work`'s result, keeping the connection warm until it lands.

    `work` must resolve to a pydantic model; it is serialised into the terminal
    frame. Raising HTTPException from it is supported and is the normal way to
    report an upstream failure.
    """
    return StreamingResponse(
        _frames(work, interval),
        media_type=MEDIA_TYPE,
        headers={
            # nginx honours this per-response. Without it, `proxy_buffering on`
            # would hold the heartbeats in a proxy buffer until the whole body is
            # ready, which defeats the entire mechanism while appearing to work
            # in local tests that have no proxy. The deployed snippet sets
            # `proxy_buffering off` for /api/ too; this makes a forgotten config
            # a non-event rather than a silent regression.
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-store",
        },
    )
