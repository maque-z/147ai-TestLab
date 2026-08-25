import base64
import logging
import time

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
from ..schemas.image_config import ImageConfigOut, ImageConfigUpdate
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
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/image-gen", tags=["image-gen"])

# Limits published for the edits endpoint. Checked here so an oversized upload
# fails immediately with a readable message instead of after a long round trip.
MAX_IMAGES = 16
MAX_IMAGE_BYTES = 50 * 1024 * 1024
MAX_MASK_BYTES = 4 * 1024 * 1024
ALLOWED_INPUT_FORMATS = ("png", "jpeg", "webp")


async def call_upstream(cfg: UpstreamConfig, path: str, **kwargs) -> tuple[dict, int, str | None]:
    """POST to the upstream image API and return (json, elapsed_ms, request_id).

    Every failure mode is turned into an HTTPException carrying a message that is
    worth showing to the user, since the card in the UI displays it verbatim.
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
            except Exception:
                detail = body_text
            raise HTTPException(status_code=resp.status_code, detail=detail)

        raw = resp.text
        if not raw:
            logger.error("Empty response body from API (status %s)", resp.status_code)
            raise HTTPException(status_code=502, detail="API 返回了空响应，请检查模型 ID 和 baseurl 配置")

        try:
            return resp.json(), elapsed_ms, request_id
        except Exception as exc:
            logger.error("JSON parse failed. Raw response: %s", raw[:500])
            raise HTTPException(status_code=502, detail=f"API 响应格式错误: {exc}")

    except HTTPException:
        raise
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail=f"请求超时 ({cfg.timeout}s)，可在配置中增大超时时间")
    except Exception as exc:
        logger.exception("Unexpected error calling image API")
        raise HTTPException(status_code=502, detail=str(exc))


def build_response(data: dict, *, cfg, prompt: str, payload: dict,
                   elapsed_ms: int, request_id: str | None) -> GenerateResponse:
    """Shape one upstream response into the card the UI renders."""
    declared_format = data.get("output_format")
    usage = data.get("usage") or {}
    # gpt-image reports how the input tokens split between the prompt text and
    # any reference images, under usage.input_tokens_details.
    in_details = usage.get("input_tokens_details") or {}

    images: list[GeneratedImage] = []
    for item in data.get("data", []):
        b64 = item.get("b64_json")
        real_format = None
        byte_size = None
        if b64:
            byte_size = b64_byte_size(b64)
            # 24 base64 chars decode to 18 bytes — enough for every signature above
            try:
                real_format = detect_format(base64.b64decode(b64[:24]))
            except Exception:
                real_format = None
        images.append(GeneratedImage(
            b64_json=b64,
            url=item.get("url"),
            revised_prompt=item.get("revised_prompt"),
            image_format=real_format or declared_format,
            byte_size=byte_size,
        ))

    return GenerateResponse(
        images=images,
        model=cfg.model_id,
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
    status codes: their dependencies run before the first byte is sent.
    """
    async def work() -> GenerateResponse:
        payload: dict = {
            "model": cfg.model_id,
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
            "POST /v1/images/generations  size=%s quality=%s background=%s",
            payload.get("size", "<default>"),
            payload.get("quality", "<default>"),
            payload.get("background", "<default>"),
        )

        data, elapsed_ms, request_id = await call_upstream(
            cfg, "/v1/images/generations", json=payload
        )

        return build_response(data, cfg=cfg, prompt=body.prompt, payload=payload,
                              elapsed_ms=elapsed_ms, request_id=request_id)

    return heartbeat_response(work())


@router.post("/edit")
async def edit(
    # Same bounds as GenerateRequest, imported rather than restated — this
    # endpoint takes the identical params as multipart Form fields, and two
    # hand-written copies of these numbers would drift.
    prompt: str = Form(..., min_length=1, max_length=MAX_PROMPT_LEN),
    images: list[UploadFile] = File(...),
    mask: UploadFile | None = File(None),
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
        "model": cfg.model_id,
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
        "POST /v1/images/edits  images=%d mask=%s size=%s quality=%s background=%s",
        len(images), "yes" if len(files) > len(images) else "no",
        payload.get("size", "<default>"), payload.get("quality", "<default>"),
        payload.get("background", "<default>"),
    )

    # From here on the wall clock is the upstream's, so the rest is streamed.
    # `files` is already fully read into memory above, which is what makes this
    # safe: the UploadFile handles are not touched again after the response
    # starts, so Starlette is free to clean them up whenever it likes.
    async def work() -> GenerateResponse:
        data, elapsed_ms, request_id = await call_upstream(
            cfg, "/v1/images/edits", data=form, files=files
        )
        return build_response(data, cfg=cfg, prompt=prompt, payload=payload,
                              elapsed_ms=elapsed_ms, request_id=request_id)

    return heartbeat_response(work())
