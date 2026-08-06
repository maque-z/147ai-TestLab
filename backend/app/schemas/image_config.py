from pydantic import BaseModel
from typing import Optional
from datetime import datetime


class ImageConfigBase(BaseModel):
    baseurl: str = "https://api.openai.com"
    api_key: str = ""
    model_id: str = "gpt-image-alpha"
    timeout: int = 400


class ImageConfigUpdate(ImageConfigBase):
    pass


class ImageConfigOut(ImageConfigBase):
    id: int
    user_id: int
    updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True}
