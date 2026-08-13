from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime

# Same bounds as the gpt-image config — imported rather than restated, since both
# tables have identical column widths and the same reasoning applies.
from .image_config import (
    MAX_KEY_LEN,
    MAX_MODEL_LEN,
    MAX_URL_LEN,
    TIMEOUT_MAX,
    TIMEOUT_MIN,
)

_DEFAULT_MODEL = "gemini-3-pro-image-preview"
_PROTECTED: dict = {"protected_namespaces": ()}


class BananaConfigBase(BaseModel):
    """The shape, without bounds — see the note in ImageConfigBase for why the
    output model must not carry them."""

    # Suppress the "model_" protected-namespace warning: model_id here refers to
    # the upstream AI model identifier, not a Pydantic model attribute.
    model_config = _PROTECTED

    baseurl: str = ""
    api_key: str = ""
    # Only the drawer's default. The batch matrix sends a model per request, since
    # comparing models against each other is the point of the Gemini surface —
    # the documented size and ratio support differs between them.
    model_id: str = _DEFAULT_MODEL
    timeout: int = 480


class BananaConfigUpdate(BananaConfigBase):
    """What a client may write. This is where the bounds apply."""

    model_config = _PROTECTED

    baseurl: str = Field(default="", max_length=MAX_URL_LEN)
    api_key: str = Field(default="", max_length=MAX_KEY_LEN)
    model_id: str = Field(default=_DEFAULT_MODEL, max_length=MAX_MODEL_LEN)
    timeout: int = Field(default=480, ge=TIMEOUT_MIN, le=TIMEOUT_MAX)


class BananaConfigOut(BananaConfigBase):
    id: int
    user_id: int
    updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True, "protected_namespaces": ()}
