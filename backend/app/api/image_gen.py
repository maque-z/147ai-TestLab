import base64
import ipaddress
import logging
import re
import time
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy.orm import Session

from ..core.database import get_db
from ..core.deps import UpstreamConfig, get_current_user, get_image_config
# The two generation endpoints answer as a heartbeat stream rather than a plain
# JSON body — an idle 60-120s connection gets reaped by proxies on the path.
# See core/streaming.py for what that costs and why it is framed this way.
from ..core.streaming import heartbeat_response
# Byte-level inspection lives in core/ because the Gemini endpoint needs the same
# checks: both upstreams declare a format that can disagree with the bytes sent.
from ..core.imaging import (
    b64_byte_size,
    detect_format,
    has_alpha_channel,
    image_dimensions,
)
from ..crud import user as user_crud
from ..schemas.image_config import MAX_MODEL_LEN, ImageConfigOut, ImageConfigUpdate
from ..schemas.image_gen import (
    COMPRESSION_MAX,
    COMPRESSION_MIN,
    MAX_PARAM_LEN,
    MAX_PROMPT_LEN,
    N_MAX,
    N_MIN,
    GenerateRequest,
    GenerateResponse,
    GeneratedImage,
    UpstreamSnapshot,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/image-gen", tags=["image-gen"])

# Limits published for the edits endpoint. Checked here so an oversized upload
# fails immediately with a readable message instead of after a long round trip.
MAX_IMAGES = 16
MAX_IMAGE_BYTES = 50 * 1024 * 1024
MAX_MASK_BYTES = 4 * 1024 * 1024
ALLOWED_INPUT_FORMATS = ("png", "jpeg", "webp")


# ── Raw-exchange capture ─────────────────────────────────────────────────────
# The parsed GenerateResponse is this tool's reading of the upstream; the
# snapshot below is the evidence behind it — full headers plus the body with
# only the base64 image payloads stubbed out (they are megabytes each and
# already travel separately as images[].b64_json).

# A string this long made of nothing but base64 alphabet can only be a binary
# payload. Prompts and revised prompts never match: they contain spaces, CJK,
# punctuation. Anything shorter passes through whole — small enough to read.
_B64_STUB_THRESHOLD = 1024
# Enough head survives to identify the format by eye (iVBORw0KGgo → png,
# /9j/ → jpeg, UklGR → webp) and to check it against the sniffed magic bytes.
_B64_KEEP_PREFIX = 32
_B64_ALPHABET = re.compile(r"[A-Za-z0-9+/=\r\n]+")
# Non-JSON bodies are kept verbatim up to this length. Real API error bodies
# are hundreds of bytes; only a pathological page (a portal login screen at a
# mis-pointed baseurl) ever hits this.
_TEXT_BODY_CAP = 100_000


def _approx_bytes(b64_chars: int) -> str:
    n = b64_chars * 3 // 4
    return f"{n / 1048576:.1f} MB" if n >= 1048576 else f"{n / 1024:.0f} KB"


def _stub_base64(s: str) -> str:
    """Return `s`, or a short stub when it is a base64 image payload."""
    if len(s) < _B64_STUB_THRESHOLD:
        return s
    prefix, payload = "", s
    # data:image/png;base64,... — keep the self-describing prefix, stub the rest.
    if s.startswith("data:"):
        comma = s.find(",")
        if comma == -1 or ";base64" not in s[:comma]:
            return s
        prefix, payload = s[:comma + 1], s[comma + 1:]
    if not _B64_ALPHABET.fullmatch(payload):
        return s
    return (f"{prefix}{payload[:_B64_KEEP_PREFIX]}"
            f"…[base64 已过滤 · 共 {len(payload):,} 字符 ≈ {_approx_bytes(len(payload))}]")


def sanitize_body(obj):
    """Deep-copy `obj` with base64 image payloads replaced by short stubs.

    Everything that is not a giant base64 string comes through complete — the
    point of the snapshot is observing every field the API sent, not shipping
    the image twice.
    """
    if isinstance(obj, str):
        return _stub_base64(obj)
    if isinstance(obj, list):
        return [sanitize_body(v) for v in obj]
    if isinstance(obj, dict):
        return {k: sanitize_body(v) for k, v in obj.items()}
    return obj


def _snapshot(resp: httpx.Response, *, body=None, body_text=None) -> UpstreamSnapshot:
    return UpstreamSnapshot(
        status=resp.status_code,
        # Empty on HTTP/2 — the protocol dropped reason phrases.
        reason=resp.reason_phrase or None,
        http_version=resp.http_version,
        # multi_items, not dict: keeps arrival order and duplicate keys.
        headers=[[k, v] for k, v in resp.headers.multi_items()],
        body=body,
        body_text=body_text,
    )


class UpstreamHTTPError(HTTPException):
    """An upstream failure that still produced a real HTTP response.

    Carries the raw exchange so a refusal is observable with the same fidelity
    as a success — the suite's refusal probes exist precisely to read these
    bodies, and headers (request ids, ratelimit state) matter most when things
    fail. core/streaming.py picks `.upstream` up by getattr, so the Gemini
    endpoints, which raise plain HTTPExceptions, are unaffected.
    """

    def __init__(self, status_code: int, detail: str, upstream: UpstreamSnapshot):
        super().__init__(status_code=status_code, detail=detail)
        self.upstream = upstream


async def call_upstream(
    cfg: UpstreamConfig, path: str, **kwargs
) -> tuple[dict, int, str | None, UpstreamSnapshot]:
    """POST to the upstream image API and return (json, elapsed_ms, request_id,
    snapshot).

    Every failure mode is turned into an HTTPException carrying a message that is
    worth showing to the user, since the card in the UI displays it verbatim.
    Failures that got as far as an HTTP response carry the raw exchange too.
    """
    endpoint = f"{cfg.baseurl.rstrip('/')}{path}"
    headers = {"Authorization": f"Bearer {cfg.api_key}"}

    t0 = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=cfg.timeout) as client:
            resp = await client.post(endpoint, headers=headers, **kwargs)
        elapsed_ms = int((time.perf_counter() - t0) * 1000)

        # Upstream request id, useful when reporting bad generations to the provider
        h = resp.headers
        request_id = (h.get("x-openai-response-id") or h.get("x-request-id")
                      or h.get("openai-request-id") or h.get("cf-ray"))

        if resp.status_code >= 400:
            body_text = resp.text or f"HTTP {resp.status_code}"
            logger.error("API error %s: %s", resp.status_code, body_text[:500])
            try:
                err = resp.json()
                detail = (err.get("error", {}).get("message")
                          or err.get("detail")
                          or body_text)
                snap = _snapshot(resp, body=sanitize_body(err))
            except Exception:
                detail = body_text
                snap = _snapshot(resp, body_text=body_text[:_TEXT_BODY_CAP])
            raise UpstreamHTTPError(resp.status_code, detail, snap)

        raw = resp.text
        if not raw:
            logger.error("Empty response body from API (status %s)", resp.status_code)
            raise UpstreamHTTPError(
                502, "API 返回了空响应，请检查模型 ID 和 baseurl 配置",
                _snapshot(resp, body_text=""),
            )

        try:
            data = resp.json()
        except Exception as exc:
            logger.error("JSON parse failed. Raw response: %s", raw[:500])
            raise UpstreamHTTPError(
                502, f"API 响应格式错误: {exc}",
                _snapshot(resp, body_text=raw[:_TEXT_BODY_CAP]),
            )
        return data, elapsed_ms, request_id, _snapshot(resp, body=sanitize_body(data))

    except HTTPException:
        raise
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail=f"请求超时 ({cfg.timeout}s)，可在配置中增大超时时间")
    except Exception as exc:
        logger.exception("Unexpected error calling image API")
        raise HTTPException(status_code=502, detail=str(exc))


# --- Image bytes that arrive as a link ---------------------------------------
# The reference is unambiguous for GPT image models: `b64_json` is "returned by
# default" and `url` is "unsupported". A link therefore never comes from the
# Images API itself -- it is a gateway re-hosting the file, or a ChatGPT-web relay
# handing out its own download link (sub2api and AI-Zero-Token both resolve
# chatgpt.com/backend-api/files/.../download and pass the result on). Either way
# the bytes are still the thing to measure, so the link is fetched here and
# inspected like any b64 payload; what *kind* of data arrived is recorded
# separately, as evidence, in GeneratedImage.data_kind.

_URL_FETCH_CAP = 50 * 1024 * 1024
# Bounded independently of the generation timeout: a link download should take
# seconds, and a 300s configured timeout should not become a 300s hang here.
_URL_FETCH_TIMEOUT = 60.0


def _blocked_host(host: str) -> bool:
    """Refuse literal loopback / private / link-local targets.

    The link is chosen by whoever answers the configured baseurl, and a fetch
    made from inside the deployment must not be steerable at the network behind
    it. Hostnames are left to resolve normally -- this is a guard against the
    obvious, not a full SSRF filter.
    """
    if not host or host.lower() == "localhost":
        return True
    try:
        ip = ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        return False
    return (ip.is_private or ip.is_loopback or ip.is_link_local
            or ip.is_reserved or ip.is_unspecified)


async def _fetch_image_url(url: str, timeout: float) -> tuple[bytes | None, str | None]:
    """GET an image link. Returns (bytes, None), or (None, reason) -- the reason
    is shown on the card, so it is written for a reader."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        return None, f"非 http(s) 链接（{parsed.scheme or '无协议'}）"
    if _blocked_host(parsed.hostname or ""):
        return None, "链接指向内网/本机地址，拒绝下载"
    try:
        async with httpx.AsyncClient(
            timeout=min(timeout, _URL_FETCH_TIMEOUT), follow_redirects=True,
        ) as client:
            async with client.stream("GET", url) as resp:
                if resp.status_code >= 400:
                    return None, f"下载失败 HTTP {resp.status_code}"
                buf = bytearray()
                async for chunk in resp.aiter_bytes():
                    buf += chunk
                    if len(buf) > _URL_FETCH_CAP:
                        return None, "文件超过 50 MB 上限"
                return bytes(buf), None
    except httpx.TimeoutException:
        return None, "下载超时"
    except Exception as exc:  # DNS, TLS, connection refused ...
        return None, f"下载失败: {exc.__class__.__name__}"


def _split_data_url(s: str) -> str | None:
    """The base64 payload of a data:...;base64,... string, or None if not one."""
    if not s.startswith("data:"):
        return None
    comma = s.find(",")
    if comma == -1 or ";base64" not in s[:comma]:
        return None
    return s[comma + 1:]


async def _build_image(item: dict, timeout: float) -> GeneratedImage:
    """One data[] item -> one GeneratedImage, with the bytes measured whatever
    container they arrived in.

    The documented shape is `b64_json` holding raw base64. Everything else seen
    in the wild is handled and *recorded*, never silently normalised away:
    a data: URL in either field, an http(s) link (downloaded), or a `result`
    field -- the name inside a Responses API image_generation_call, which a
    gateway forwarding that item unconverted would leave as-is.
    """
    b64 = item.get("b64_json")
    url = item.get("url")
    result = item.get("result")

    kind, field = "none", None
    b64_out: str | None = None
    source_url: str | None = None
    fetch_error: str | None = None
    raw: bytes | None = None

    if isinstance(b64, str) and b64:
        field = "b64_json"
        payload = _split_data_url(b64)
        kind, b64_out = ("data_url", payload) if payload is not None else ("b64_json", b64)
    elif isinstance(url, str) and url:
        field = "url"
        payload = _split_data_url(url)
        if payload is not None:
            kind, b64_out = "data_url", payload
        else:
            kind, source_url = "url", url
            raw, fetch_error = await _fetch_image_url(url, timeout)
            if raw is not None:
                b64_out = base64.b64encode(raw).decode("ascii")
    elif isinstance(result, str) and result:
        field, kind, b64_out = "result", "b64_json", result

    real_format = None
    byte_size = None
    if raw is not None:
        byte_size = len(raw)
        real_format = detect_format(raw[:16])
    elif b64_out:
        byte_size = b64_byte_size(b64_out)
        # 24 base64 chars decode to 18 bytes -- enough for every signature
        # detect_format knows.
        try:
            real_format = detect_format(base64.b64decode(b64_out[:24]))
        except Exception:
            real_format = None

    revised = item.get("revised_prompt")
    return GeneratedImage(
        b64_json=b64_out,
        url=source_url,
        revised_prompt=revised if isinstance(revised, str) else None,
        # Sniffed only. The old fallback to the declared output_format made a
        # claim look like a measurement whenever the bytes were missing.
        image_format=real_format,
        byte_size=byte_size,
        data_kind=kind,
        data_field=field,
        source_url=source_url,
        fetch_error=fetch_error,
    )


async def build_response(data: dict, *, cfg, prompt: str, payload: dict,
                         elapsed_ms: int, request_id: str | None,
                         upstream: UpstreamSnapshot | None = None) -> GenerateResponse:
    """Shape one upstream response into the card the UI renders.

    Async because an item that arrives as a link is downloaded here, so its
    bytes can be measured like everyone else's.
    """
    declared_format = data.get("output_format")
    usage = data.get("usage") or {}
    # gpt-image reports how the input tokens split between the prompt text and
    # any reference images, under usage.input_tokens_details.
    in_details = usage.get("input_tokens_details") or {}

    items = data.get("data")
    images: list[GeneratedImage] = [
        await _build_image(item, cfg.timeout)
        for item in (items if isinstance(items, list) else [])
        if isinstance(item, dict)
    ]

    return GenerateResponse(
        images=images,
        # What was actually sent, not the account default: the batch varies the
        # model per request now, so the card has to be labelled from the payload.
        model=payload.get("model") or cfg.model_id,
        prompt=prompt,
        size=payload.get("size"),
        quality=payload.get("quality"),
        background=payload.get("background"),
        elapsed_ms=elapsed_ms,
        request_id=request_id,
        input_tokens=usage.get("input_tokens"),
        input_text_tokens=in_details.get("text_tokens"),
        input_image_tokens=in_details.get("image_tokens"),
        output_tokens=usage.get("output_tokens"),
        upstream_model=data.get("model"),
        declared_format=declared_format,
        declared_background=data.get("background"),
        upstream=upstream,
    )


def optional_params(*, size, quality, output_format, output_compression, moderation,
                    background, input_fidelity=None) -> dict:
    """The params shared by both endpoints, with anything unset left out entirely
    rather than sent as a guessed default — that is the only way to observe what
    the API itself picks.

    `input_fidelity` is edits-only, so it defaults to None and simply never
    appears in a /generate payload.
    """
    params: dict = {}
    if size:
        params["size"] = size
    if quality:
        params["quality"] = quality
    if output_format:
        params["output_format"] = output_format
        if output_format in ("jpeg", "webp") and output_compression is not None:
            params["output_compression"] = output_compression
    if moderation:
        params["moderation"] = moderation
    # Sent verbatim even where the docs say it cannot work — transparent against
    # jpeg has no container for the alpha channel, and how the API answers that
    # is what this tool is for. Not filtered here, and not in the frontend.
    if background:
        params["background"] = background
    if input_fidelity:
        params["input_fidelity"] = input_fidelity
    return params


def resolve_model(requested: str | None, cfg: UpstreamConfig) -> str:
    """The model for this request: the matrix's choice, else the account's saved
    selection (deps.snapshot_config puts its first entry in cfg.model_id).

    The only thing checked is that there is one. Unlike the Gemini side, the id
    goes into a JSON body field rather than the request path, so no character in
    it can escape anywhere — and an odd-looking id is a probe like any other:
    whether a gateway accepts `gpt-image-2.5-flare-2026-09-08`, or a house alias,
    is exactly the kind of question the custom-model input exists to ask.
    """
    model = (requested or cfg.model_id or "").strip()
    if not model:
        raise HTTPException(status_code=400, detail="请先在参数面板中选择模型")
    return model


@router.get("/config", response_model=ImageConfigOut)
def get_config(db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    return user_crud.get_image_config(db, current_user.id)


@router.put("/config", response_model=ImageConfigOut)
def save_config(
    body: ImageConfigUpdate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user)
):
    return user_crud.update_image_config(db, current_user.id, body)


@router.post("/generate")
async def generate(
    body: GenerateRequest,
    cfg: UpstreamConfig = Depends(get_image_config),
):
    """Run one parameter combination. The frontend expands the matrix and calls
    this concurrently, so results stream back as each request finishes.

    No `db` dependency on purpose: the config arrives as a snapshot with its
    session already closed, so no pooled connection is held across the 60-120s
    upstream call. See core/deps.py.

    Answers as a heartbeat stream, so `response_model` is gone from the
    decorator — the shape is still GenerateResponse, wrapped in the envelope
    described in core/streaming.py. Auth and config errors still arrive as real
    status codes: their dependencies run before the first byte is sent, and so
    does resolve_model below — "no model" is a 400, not an envelope.
    """
    model = resolve_model(body.model_id, cfg)

    async def work() -> GenerateResponse:
        payload: dict = {
            "model": model,
            "prompt": body.prompt,
            # n omitted when unset, like every other optional param: substituting 1
            # would report the API's default as though it had been requested, and
            # whether the API defaults to 1 is one of the things worth observing.
            **({"n": body.n} if body.n is not None else {}),
            **optional_params(
                size=body.size,
                quality=body.quality,
                output_format=body.output_format,
                output_compression=body.output_compression,
                moderation=body.moderation,
                background=body.background,
            ),
        }

        logger.info(
            "POST /v1/images/generations  model=%s size=%s quality=%s background=%s",
            model,
            payload.get("size", "<default>"),
            payload.get("quality", "<default>"),
            payload.get("background", "<default>"),
        )

        data, elapsed_ms, request_id, snap = await call_upstream(
            cfg, "/v1/images/generations", json=payload
        )

        return await build_response(data, cfg=cfg, prompt=body.prompt, payload=payload,
                              elapsed_ms=elapsed_ms, request_id=request_id,
                              upstream=snap)

    return heartbeat_response(work())


@router.post("/edit")
async def edit(
    # Same bounds as GenerateRequest, imported rather than restated — this
    # endpoint takes the identical params as multipart Form fields, and two
    # hand-written copies of these numbers would drift.
    prompt: str = Form(..., min_length=1, max_length=MAX_PROMPT_LEN),
    images: list[UploadFile] = File(...),
    mask: UploadFile | None = File(None),
    # Same role as GenerateRequest.model_id, same width, and the same wire name
    # via the alias. The Python name avoids the `model_` prefix on purpose:
    # FastAPI synthesises a Pydantic model for the form fields, and a field called
    # model_id there trips Pydantic's protected-namespace warning on every start,
    # with no model_config of ours to switch it off.
    requested_model: str | None = Form(None, alias="model_id", max_length=MAX_MODEL_LEN),
    size: str | None = Form(None, max_length=MAX_PARAM_LEN),
    quality: str | None = Form(None, max_length=MAX_PARAM_LEN),
    n: int | None = Form(None, ge=N_MIN, le=N_MAX),
    output_format: str | None = Form(None, max_length=MAX_PARAM_LEN),
    output_compression: int | None = Form(
        None, ge=COMPRESSION_MIN, le=COMPRESSION_MAX
    ),
    moderation: str | None = Form(None, max_length=MAX_PARAM_LEN),
    background: str | None = Form(None, max_length=MAX_PARAM_LEN),
    # Edits-only. Documented as high/low, default low, supported on "gpt-image-1
    # and gpt-image-1.5 and later models" — wording that implies gpt-image-2
    # without ever naming it, which is exactly the kind of gap worth probing
    # rather than assuming either way.
    input_fidelity: str | None = Form(None, max_length=MAX_PARAM_LEN),
    cfg: UpstreamConfig = Depends(get_image_config),
):
    """Run one edit combination against /v1/images/edits.

    The first upload is the canvas being edited; the rest are reference images.
    The mask applies only to the first one, and its fully transparent pixels are
    the region the model is asked to repaint.

    No `db` dependency, same as /generate — see core/deps.py.

    Answers as a heartbeat stream (see core/streaming.py). Note what stays
    *outside* the stream: every upload check below runs first and still raises a
    real 400. Those answer in milliseconds, so there is nothing to keep alive,
    and "第 3 张参考图格式不对" is worth a status code rather than an envelope.
    Only the upstream call itself — the part that takes minutes — is wrapped.
    """
    # Before the uploads are read: "no model" should not cost a 16-file parse.
    model = resolve_model(requested_model, cfg)

    if not images:
        raise HTTPException(status_code=400, detail="请至少上传 1 张参考图")
    if len(images) > MAX_IMAGES:
        raise HTTPException(status_code=400, detail=f"参考图最多 {MAX_IMAGES} 张，当前 {len(images)} 张")

    files: list[tuple[str, tuple[str, bytes, str]]] = []
    first_dims: tuple[int, int] | None = None

    # The upstream distinguishes one image from many by the field name, so match
    # what the official SDK sends: `image` alone, `image[]` when there are several.
    field = "image" if len(images) == 1 else "image[]"

    for idx, up in enumerate(images):
        content = await up.read()
        if not content:
            raise HTTPException(status_code=400, detail=f"第 {idx + 1} 张参考图是空文件")
        if len(content) > MAX_IMAGE_BYTES:
            raise HTTPException(
                status_code=400,
                detail=f"第 {idx + 1} 张参考图 {len(content) // 1024 // 1024} MB，超过 50 MB 上限",
            )
        fmt = detect_format(content[:16])
        if fmt not in ALLOWED_INPUT_FORMATS:
            raise HTTPException(
                status_code=400,
                detail=f"第 {idx + 1} 张参考图格式为 {fmt or '未知'}，仅支持 png / jpeg / webp",
            )
        if idx == 0:
            first_dims = image_dimensions(content)
        files.append((field, (up.filename or f"image_{idx}.{fmt}", content, f"image/{fmt}")))

    if mask is not None:
        mask_bytes = await mask.read()
        if mask_bytes:
            if len(mask_bytes) > MAX_MASK_BYTES:
                raise HTTPException(
                    status_code=400,
                    detail=f"蒙版 {len(mask_bytes) // 1024} KB，超过 4 MB 上限",
                )
            if detect_format(mask_bytes[:16]) != "png":
                raise HTTPException(status_code=400, detail="蒙版必须是 PNG 文件")
            if has_alpha_channel(mask_bytes) is False:
                raise HTTPException(
                    status_code=400,
                    detail="蒙版没有 alpha 通道，透明区域才是要重绘的区域",
                )
            mask_dims = image_dimensions(mask_bytes)
            if first_dims and mask_dims and mask_dims != first_dims:
                raise HTTPException(
                    status_code=400,
                    detail=(f"蒙版尺寸 {mask_dims[0]}×{mask_dims[1]} 与第 1 张参考图 "
                            f"{first_dims[0]}×{first_dims[1]} 不一致，必须逐像素相等"),
                )
            files.append(("mask", (mask.filename or "mask.png", mask_bytes, "image/png")))

    payload: dict = {
        "model": model,
        "prompt": prompt,
        # Omitted when unset — same reason as the generate endpoint.
        **({"n": n} if n is not None else {}),
        **optional_params(
            size=size,
            quality=quality,
            output_format=output_format,
            output_compression=output_compression,
            moderation=moderation,
            background=background,
            input_fidelity=input_fidelity,
        ),
    }
    # multipart carries everything as text; httpx sets the boundary itself.
    form = {k: str(v) for k, v in payload.items()}

    logger.info(
        "POST /v1/images/edits  model=%s images=%d mask=%s size=%s quality=%s background=%s",
        model, len(images), "yes" if len(files) > len(images) else "no",
        payload.get("size", "<default>"), payload.get("quality", "<default>"),
        payload.get("background", "<default>"),
    )

    # From here on the wall clock is the upstream's, so the rest is streamed.
    # `files` is already fully read into memory above, which is what makes this
    # safe: the UploadFile handles are not touched again after the response
    # starts, so Starlette is free to clean them up whenever it likes.
    async def work() -> GenerateResponse:
        data, elapsed_ms, request_id, snap = await call_upstream(
            cfg, "/v1/images/edits", data=form, files=files
        )
        return await build_response(data, cfg=cfg, prompt=prompt, payload=payload,
                              elapsed_ms=elapsed_ms, request_id=request_id,
                              upstream=snap)

    return heartbeat_response(work())
