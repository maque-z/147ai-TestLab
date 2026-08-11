from pydantic import BaseModel
from typing import Optional
from datetime import datetime


class BananaConfigBase(BaseModel):
    # Suppress the "model_" protected-namespace warning: model_id here refers to
    # the upstream AI model identifier, not a Pydantic model attribute.
    model_config = {"protected_namespaces": ()}

    baseurl: str = ""
    api_key: str = ""
    # Only the drawer's default. The batch matrix sends a model per request, since
    # comparing models against each other is the point of the Gemini surface —
    # the documented size and ratio support differs between them.
    model_id: str = "gemini-3-pro-image-preview"
    timeout: int = 480


class BananaConfigUpdate(BananaConfigBase):
    pass


class BananaConfigOut(BananaConfigBase):
    id: int
    user_id: int
    updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True, "protected_namespaces": ()}
