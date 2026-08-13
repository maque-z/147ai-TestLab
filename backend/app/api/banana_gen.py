"""Gemini image generation, both documented surfaces.

| Endpoint                     | Upstream                                        |
|------------------------------|-------------------------------------------------|
| POST /banana-gen/generate    | /v1beta/models/{model}:generateContent           |
| POST /banana-gen/chat        | /v1/chat/completions  (modalities: text+image)   |

One request == one param combination; the frontend expands the matrix and fires
these concurrently. Unset params are omitted rather than defaulted, so what the
API picks for itself stays observable.
"""

import base64
import logging
import re
import time

import httpx
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..core.database import get_db
from ..core.deps import UpstreamConfig, get_banana_config, get_current_user
from ..core.imaging import b64_byte_size, detect_format, image_dimensions
from ..crud import user as user_crud
from ..schemas.banana_config import BananaConfigOut, BananaConfigUpdate
from ..schemas.banana_gen import (
    BananaChatRequest,
    BananaGenerateRequest,
    BananaGenerateResponse,
    BananaImage,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/banana-gen", tags=["banana-gen"])

# The five categories the official example sets, applied together with one
# threshold. Sending a subset leaves the rest at the upstream default, which would
# make a "safety off" run only partly off.
SAFETY_CATEGORIES = (
    "HARM_CATEGORY_HARASSMENT",
    "HARM_CATEGORY_HATE_SPEECH",
    "HARM_CATEGORY_SEXUALLY_EXPLICIT",
    "HARM_CATEGORY_DANGEROUS_CONTENT",
    "HARM_CATEGORY_CIVIC_INTEGRITY",
)

# A model id lands in the URL path, so anything that could climb out of it or
# split the path is refused before the request is built.
_FORBIDDEN_IN_MODEL = ("/", "\\", "?", "#", "..", " ")

# A base64 image smuggled into a text field, which the OpenAI-compatible path does
# when it wraps the result in markdown instead of using a structured part.
_DATA_URI_IN_TEXT = re.compile(r"data:image/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+")


def resolve_model(requested: str | None, cfg: UpstreamConfig) -> str:
    """The model for this request: the matrix's choice, else the stored default."""
    model = (requested or cfg.model_id or "").strip()
    if not model:
        raise HTTPException(status_code=400, detail="请先在配置中填写 Model ID，或在参数中选择模型")
    for bad in _FORBIDDEN_IN_MODEL:
        if bad in model:
            raise HTTPException(
                status_code=400,
                detail=f"模型 ID 不能包含 {bad!r}：它会被拼进请求路径",
            )
    return model


async def call_upstream(cfg: UpstreamConfig, path: str, payload: dict) -> tuple[dict, int, str | None]:
    """POST JSON upstream and return (json, elapsed_ms, request_id).

    Every failure mode becomes an HTTPException carrying a message worth showing
    verbatim — the card in the UI displays exactly this string.
    """
    endpoint = f"{cfg.baseurl.rstrip('/')}{path}"
    # Bearer for both surfaces, per the official examples.
    headers = {
        "Authorization": f"Bearer {cfg.api_key}",
        "Content-Type": "application/json",
    }

    t0 = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=cfg.timeout) as client:
            resp = await client.post(endpoint, headers=headers, json=payload)
        elapsed_ms = int((time.perf_counter() - t0) * 1000)

        h = resp.headers
        request_id = (h.get("x-request-id") or h.get("x-goog-request-id")
                      or h.get("openai-request-id") or h.get("cf-ray"))

        if resp.status_code >= 400:
            body_text = resp.text or f"HTTP {resp.status_code}"
            logger.error("Gemini API error %s: %s", resp.status_code, body_text[:500])
            try:
                err = resp.json()
                # Native errors nest under error.message; the OpenAI-compatible
                # path uses the same shape, so one lookup covers both.
                detail = (err.get("error", {}).get("message")
                          or err.get("detail")
                          or body_text)
            except Exception:
                detail = body_text
            raise HTTPException(status_code=resp.status_code, detail=detail)

        raw = resp.text
        if not raw:
            logger.error("Empty response body (status %s)", resp.status_code)
            raise HTTPException(
                status_code=502,
                detail="API 返回了空响应，请检查模型 ID 和 Base URL 配置",
            )

        try:
            return resp.json(), elapsed_ms, request_id
        except Exception as exc:
            logger.error("JSON parse failed. Raw response: %s", raw[:500])
            raise HTTPException(status_code=502, detail=f"API 响应格式错误: {exc}")

    except HTTPException:
        raise
    except httpx.TimeoutException:
        raise HTTPException(
            status_code=504,
            detail=f"请求超时 ({cfg.timeout}s)，可在配置中增大超时时间",
        )
    except Exception as exc:
        logger.exception("Unexpected error calling Gemini API")
        raise HTTPException(status_code=502, detail=str(exc))


def describe_image(b64: str, declared_mime: str | None,
                   candidate_index: int | None) -> BananaImage:
    """Everything measurable about one returned image, without trusting the
    upstream's own claims about it."""
    byte_size = b64_byte_size(b64)
    real_format = None
    dims = None
    try:
        # 32 base64 chars decode to 24 bytes — enough for every signature, and for
        # a PNG's IHDR, which is where the dimensions live.
        head = base64.b64decode(b64[:32])
        real_format = detect_format(head)
        dims = image_dimensions(head)
    except Exception:
        pass

    # JPEG and WebP record their size further into the file than the header, so
    # fall back to decoding the whole payload when the cheap read came up empty.
    if dims is None:
        try:
            dims = image_dimensions(base64.b64decode(b64))
        except Exception:
            dims = None

    return BananaImage(
        b64_json=b64,
        declared_mime=declared_mime,
        image_format=real_format,
        byte_size=byte_size,
        width=dims[0] if dims else None,
        height=dims[1] if dims else None,
        candidate_index=candidate_index,
    )


def build_native_payload(body: BananaGenerateRequest) -> dict:
    """The generateContent body, with every unset param genuinely absent.

    Shape follows the official example: contents + generationConfig, and
    safetySettings only when a threshold was chosen.
    """
    generation: dict = {}
    if body.response_modalities:
        generation["responseModalities"] = body.response_modalities

    # imageConfig is only sent when it would carry something. An empty object is
    # not the same as omitting it, and the point is to test the documented
    # defaults rather than to send `{}` and hope it means the same thing.
    image_config: dict = {}
    if body.aspect_ratio:
        image_config["aspectRatio"] = body.aspect_ratio
    if body.image_size:
        image_config["imageSize"] = body.image_size
    if image_config:
        generation["imageConfig"] = image_config

    # `is not None`, not truthiness: temperature 0 and candidateCount 0 are values
    # the user can legitimately pick, and both are falsy.
    if body.temperature is not None:
        generation["temperature"] = body.temperature
    if body.candidate_count is not None:
        generation["candidateCount"] = body.candidate_count
    if body.max_output_tokens is not None:
        generation["maxOutputTokens"] = body.max_output_tokens
    if body.stop_sequences:
        generation["stopSequences"] = body.stop_sequences

    payload: dict = {
        "contents": [{"role": "user", "parts": [{"text": body.prompt}]}],
    }
    if generation:
        payload["generationConfig"] = generation
    if body.safety_threshold:
        payload["safetySettings"] = [
            {"category": c, "threshold": body.safety_threshold}
            for c in SAFETY_CATEGORIES
        ]
    return payload


def parse_native(data: dict) -> tuple[list[BananaImage], list[str], list[str]]:
    """Pull (images, texts, finishReasons) out of a generateContent response.

    Walks every candidate and every part rather than reading candidates[0] only:
    candidateCount > 1 is one of the params under test, and a response carrying
    more candidates than were asked for is itself the finding.
    """
    images: list[BananaImage] = []
    texts: list[str] = []
    reasons: list[str] = []

    for idx, cand in enumerate(data.get("candidates") or []):
        reason = cand.get("finishReason")
        if reason:
            reasons.append(str(reason))
        parts = ((cand.get("content") or {}).get("parts")) or []
        for part in parts:
            inline = part.get("inlineData") or part.get("inline_data")
            if inline and inline.get("data"):
                images.append(describe_image(
                    inline["data"],
                    inline.get("mimeType") or inline.get("mime_type"),
                    idx,
                ))
                continue
            text = part.get("text")
            if text:
                texts.append(text)

    return images, texts, reasons


def block_reason_from(data: dict, reasons: list[str]) -> str | None:
    """Why a 200 came back without an image.

    promptFeedback.blockReason covers a prompt rejected before generation; a
    non-STOP finishReason covers one rejected after. Both are documented, and
    neither is an HTTP error, so they have to be surfaced from the body.
    """
    feedback = data.get("promptFeedback") or {}
    if feedback.get("blockReason"):
        return str(feedback["blockReason"])
    bad = [r for r in reasons if r != "STOP"]
    if bad:
        return bad[0]
    return None


def parse_chat(data: dict) -> tuple[list[BananaImage], list[str]]:
    """Pull (images, texts) out of a chat/completions response.

    The doc is self-contradictory here — its requestBody schema describes
    prompt/n/size while its example sends model/messages, and its response schema
    shows a top-level `data[].url` that a chat completion does not return. So each
    shape that has actually been observed carrying an image is handled explicitly,
    rather than assuming one and reporting "no image" for the others.
    """
    images: list[BananaImage] = []
    texts: list[str] = []

    for idx, choice in enumerate(data.get("choices") or []):
        msg = choice.get("message") or choice.get("delta") or {}

        # message.images[].image_url.url — what the Gemini-compatible path uses
        for item in msg.get("images") or []:
            url = ((item.get("image_url") or {}).get("url")) or item.get("url")
            if url:
                _append_url(images, url, idx)

        content = msg.get("content")
        if isinstance(content, str):
            if content.strip():
                texts.append(content)
            # A data URI embedded in markdown, e.g. ![img](data:image/png;base64,…)
            for m in _DATA_URI_IN_TEXT.finditer(content):
                _append_url(images, m.group(0), idx)
        elif isinstance(content, list):
            # Multimodal content parts
            for part in content:
                if not isinstance(part, dict):
                    continue
                url = (part.get("image_url") or {}).get("url")
                if url:
                    _append_url(images, url, idx)
                elif part.get("text"):
                    texts.append(part["text"])

    # The shape the doc's own response schema describes.
    for idx, item in enumerate(data.get("data") or []):
        if item.get("b64_json"):
            images.append(describe_image(item["b64_json"], None, idx))
        elif item.get("url"):
            _append_url(images, item["url"], idx)

    return images, texts


def _from_data_uri(url: str) -> tuple[str, str | None] | None:
    """(base64, mime) from a `data:` URI, or None for a plain http(s) URL."""
    if not url.startswith("data:"):
        return None
    header, _, payload = url.partition(",")
    if not payload:
        return None
    mime = header[5:].split(";")[0] or None
    return payload, mime


def _append_url(images: list[BananaImage], url: str, idx: int) -> None:
    """Record an image given either an inline data URI or a hosted URL."""
    parsed = _from_data_uri(url)
    if parsed:
        b64, mime = parsed
        images.append(describe_image(b64, mime, idx))
    else:
        # A hosted URL cannot be measured here; the browser reports its size.
        images.append(BananaImage(url=url, candidate_index=idx))


@router.get("/config", response_model=BananaConfigOut)
def get_config(db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    return user_crud.get_banana_config(db, current_user.id)


@router.put("/config", response_model=BananaConfigOut)
def save_config(
    body: BananaConfigUpdate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    return user_crud.update_banana_config(db, current_user.id, body)


@router.post("/generate", response_model=BananaGenerateResponse)
async def generate(
    body: BananaGenerateRequest,
    cfg: UpstreamConfig = Depends(get_banana_config),
):
    """One combination against /v1beta/models/{model}:generateContent.

    No `db` dependency: the config arrives as a snapshot with its session already
    closed, so no pooled connection is held across the upstream call. See
    core/deps.py.
    """
    model = resolve_model(body.model_id, cfg)
    payload = build_native_payload(body)

    logger.info(
        "POST /v1beta/models/%s:generateContent  ratio=%s size=%s modalities=%s",
        model,
        body.aspect_ratio or "<default>",
        body.image_size or "<default>",
        ",".join(body.response_modalities or []) or "<omitted>",
    )

    data, elapsed_ms, request_id = await call_upstream(
        cfg, f"/v1beta/models/{model}:generateContent", payload
    )

    images, texts, reasons = parse_native(data)
    usage = data.get("usageMetadata") or {}

    return BananaGenerateResponse(
        images=images,
        texts=texts,
        model=model,
        prompt=body.prompt,
        elapsed_ms=elapsed_ms,
        request_id=request_id,
        aspect_ratio=body.aspect_ratio,
        image_size=body.image_size,
        finish_reasons=reasons,
        candidate_count=len(data.get("candidates") or []),
        prompt_tokens=usage.get("promptTokenCount"),
        candidates_tokens=usage.get("candidatesTokenCount"),
        total_tokens=usage.get("totalTokenCount"),
        upstream_model=data.get("modelVersion"),
        block_reason=None if images else block_reason_from(data, reasons),
    )


@router.post("/chat", response_model=BananaGenerateResponse)
async def chat(
    body: BananaChatRequest,
    cfg: UpstreamConfig = Depends(get_banana_config),
):
    """One combination against the OpenAI-compatible /v1/chat/completions.

    stream is deliberately never set: the documented example passes `true`, but a
    streamed body cannot be measured as a whole, and the byte size and magic-byte
    format of the result are the point of running this at all.

    No `db` dependency, same as /generate — see core/deps.py.
    """
    model = resolve_model(body.model_id, cfg)

    payload: dict = {
        "model": model,
        "messages": [{"role": "user", "content": body.prompt}],
    }
    if body.modalities:
        payload["modalities"] = body.modalities
    if body.temperature is not None:
        payload["temperature"] = body.temperature

    logger.info(
        "POST /v1/chat/completions  model=%s modalities=%s",
        model, ",".join(body.modalities or []) or "<omitted>",
    )

    data, elapsed_ms, request_id = await call_upstream(
        cfg, "/v1/chat/completions", payload
    )

    images, texts = parse_chat(data)
    usage = data.get("usage") or {}

    # A 200 with text but no image is the documented symptom of modalities missing
    # "image" — reported as a block reason so the card says why it is empty.
    block = None
    if not images:
        block = "NO_IMAGE_IN_RESPONSE" if texts else "EMPTY_RESPONSE"

    return BananaGenerateResponse(
        images=images,
        texts=texts,
        model=model,
        prompt=body.prompt,
        elapsed_ms=elapsed_ms,
        request_id=request_id,
        finish_reasons=[
            str(c.get("finish_reason")) for c in (data.get("choices") or [])
            if c.get("finish_reason")
        ],
        candidate_count=len(data.get("choices") or []),
        # This surface reports OpenAI-style token names for the same three numbers.
        prompt_tokens=usage.get("prompt_tokens"),
        candidates_tokens=usage.get("completion_tokens"),
        total_tokens=usage.get("total_tokens"),
        upstream_model=data.get("model"),
        block_reason=block,
    )
