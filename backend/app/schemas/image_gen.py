from pydantic import BaseModel
from typing import Optional, List


class GenerateRequest(BaseModel):
    prompt: str
    # Per-request overrides (use stored config defaults if omitted)
    size: Optional[str] = None
    quality: Optional[str] = None
    n: Optional[int] = None
    output_format: Optional[str] = None
    output_compression: Optional[int] = None
    background: Optional[str] = None
    moderation: Optional[str] = None


class GeneratedImage(BaseModel):
    b64_json: Optional[str] = None
    url: Optional[str] = None
    revised_prompt: Optional[str] = None


class GenerateResponse(BaseModel):
    images: List[GeneratedImage]
    model: str
    prompt: str
