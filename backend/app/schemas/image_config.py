from pydantic import BaseModel
from typing import Optional
from datetime import datetime


class ImageConfigBase(BaseModel):
    # Suppress the "model_" protected-namespace warning: model_id here refers to
    # the upstream AI model identifier, not a Pydantic model attribute.
    model_config = {"protected_namespaces": ()}

    baseurl: str = ""
    api_key: str = ""
    model_id: str = "gpt-image-2"
    timeout: int = 480


class ImageConfigUpdate(ImageConfigBase):
    pass


class ImageConfigOut(ImageConfigBase):
    id: int
    user_id: int
    updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True, "protected_namespaces": ()}
