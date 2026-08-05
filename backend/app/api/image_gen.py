import base64
import httpx
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session
from typing import Optional
from ..core.database import get_db
from ..core.deps import get_current_user
from ..crud import user as user_crud
from ..schemas.image_config import ImageConfigOut, ImageConfigUpdate
from ..schemas.image_gen import GenerateRequest, GenerateResponse, GeneratedImage

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
        raise HTTPException(status_code=400, detail="API key not configured")

    payload = {
        "model": cfg.model_id,
        "prompt": body.prompt,
        "n": body.n or cfg.n,
        "size": body.size or cfg.size,
        "quality": body.quality or cfg.quality,
        "output_format": body.output_format or cfg.output_format,
        "background": body.background or cfg.background,
        "moderation": body.moderation or cfg.moderation,
        "response_format": "b64_json",
    }
    if payload["output_format"] in ("jpeg", "webp"):
        payload["output_compression"] = body.output_compression or cfg.output_compression

    baseurl = cfg.baseurl.rstrip("/")
    headers = {"Authorization": f"Bearer {cfg.api_key}", "Content-Type": "application/json"}

    try:
        async with httpx.AsyncClient(timeout=cfg.timeout) as client:
            resp = await client.post(f"{baseurl}/images/generations", json=payload, headers=headers)
        resp.raise_for_status()
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail=e.response.text)
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))

    data = resp.json()
    images = [GeneratedImage(b64_json=item.get("b64_json"), url=item.get("url"),
                             revised_prompt=item.get("revised_prompt"))
              for item in data.get("data", [])]
    return GenerateResponse(images=images, model=cfg.model_id, prompt=body.prompt)
