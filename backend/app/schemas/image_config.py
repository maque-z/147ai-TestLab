from pydantic import BaseModel
from typing import Optional
from datetime import datetime


class ImageConfigBase(BaseModel):
    baseurl: str = "https://api.openai.com/v1"
    api_key: str = ""
    model_id: str = "gpt-image-alpha"
    timeout: int = 120
    size: str = "1024x1024"
    quality: str = "auto"
    n: int = 1
    output_format: str = "png"
    output_compression: int = 90
    background: str = "auto"
    moderation: str = "auto"


class ImageConfigUpdate(ImageConfigBase):
    pass


class ImageConfigOut(ImageConfigBase):
    id: int
    user_id: int
    updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True}
