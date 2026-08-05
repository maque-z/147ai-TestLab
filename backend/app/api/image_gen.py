import logging
import httpx
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from ..core.database import get_db
from ..core.deps import get_current_user
from ..crud import user as user_crud
from ..schemas.image_config import ImageConfigOut, ImageConfigUpdate
from ..schemas.image_gen import GenerateRequest, GenerateResponse, GeneratedImage

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/image-gen", tags=["image-gen"])


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


@router.post("/generate", response_model=GenerateResponse)
async def generate(
    body: GenerateRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user)
):
    cfg = user_crud.get_image_config(db, current_user.id)
    if not cfg.api_key:
        raise HTTPException(status_code=400, detail="请先在配置中填写 API Key")

    # Build payload — only include params the model actually supports
    payload: dict = {
        "model": cfg.model_id,
        "prompt": body.prompt,
        "n": body.n if body.n is not None else cfg.n,
        "size": body.size or cfg.size,
        "quality": body.quality or cfg.quality,
    }

    # Optional params — skip when set to "auto" to let the API use its defaults
    output_format = body.output_format or cfg.output_format
    if output_format and output_format != "auto":
        payload["output_format"] = output_format
        if output_format in ("jpeg", "webp"):
            compression = body.output_compression if body.output_compression is not None else cfg.output_compression
            payload["output_compression"] = compression

    background = body.background or cfg.background
    if background and background != "auto":
        payload["background"] = background

    moderation = body.moderation or cfg.moderation
    if moderation and moderation != "auto":
        payload["moderation"] = moderation

    baseurl = cfg.baseurl.rstrip("/")
    headers = {"Authorization": f"Bearer {cfg.api_key}", "Content-Type": "application/json"}

    logger.info("Calling %s/images/generations  model=%s", baseurl, cfg.model_id)

    try:
        async with httpx.AsyncClient(timeout=cfg.timeout) as client:
            resp = await client.post(
                f"{baseurl}/images/generations",
                json=payload,
                headers=headers,
            )

        if resp.status_code >= 400:
            body_text = resp.text or f"HTTP {resp.status_code}"
            logger.error("API error %s: %s", resp.status_code, body_text[:500])
            # Try to extract a meaningful message from JSON error body
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
            data = resp.json()
        except Exception as exc:
            logger.error("JSON parse failed. Raw response: %s", raw[:500])
            raise HTTPException(status_code=502, detail=f"API 响应格式错误: {exc}")

    except HTTPException:
        raise
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="请求超时，可尝试增大配置中的超时时间")
    except Exception as exc:
        logger.exception("Unexpected error calling image API")
        raise HTTPException(status_code=502, detail=str(exc))

    items = data.get("data", [])
    images = [
        GeneratedImage(
            b64_json=item.get("b64_json"),
            url=item.get("url"),
            revised_prompt=item.get("revised_prompt"),
        )
        for item in items
    ]
    return GenerateResponse(images=images, model=cfg.model_id, prompt=body.prompt)
