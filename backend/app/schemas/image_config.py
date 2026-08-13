from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime

# Match the column widths in models/user.py. SQLite does not enforce VARCHAR
# lengths, so without these a longer value is stored intact and only surfaces as a
# problem on some other database — better to refuse it here with a readable 422.
MAX_URL_LEN = 500
MAX_KEY_LEN = 500
MAX_MODEL_LEN = 100

# Wider than the drawer's own 60-600 on purpose, but finite at both ends: 0 or a
# negative value reaches httpx as "fail immediately", and an unbounded one pins a
# worker on a hung upstream for as long as it is willing to wait.
TIMEOUT_MIN, TIMEOUT_MAX = 10, 3600

_PROTECTED: dict = {"protected_namespaces": ()}


class ImageConfigBase(BaseModel):
    """The shape, without bounds.

    Deliberately unconstrained: this is the base for the *output* model too, and
    FastAPI validates outgoing responses against response_model. A row already in
    the database with a value outside the bounds below — written before they
    existed, or by a direct API call — would then turn GET /config into a 500
    rather than simply being returned. Bounds are for what a client sends, so they
    live on ImageConfigUpdate alone.
    """

    # Suppress the "model_" protected-namespace warning: model_id here refers to
    # the upstream AI model identifier, not a Pydantic model attribute.
    model_config = _PROTECTED

    baseurl: str = ""
    api_key: str = ""
    model_id: str = "gpt-image-2"
    timeout: int = 480


class ImageConfigUpdate(ImageConfigBase):
    """What a client may write. This is where the bounds apply."""

    model_config = _PROTECTED

    baseurl: str = Field(default="", max_length=MAX_URL_LEN)
    api_key: str = Field(default="", max_length=MAX_KEY_LEN)
    model_id: str = Field(default="gpt-image-2", max_length=MAX_MODEL_LEN)
    timeout: int = Field(default=480, ge=TIMEOUT_MIN, le=TIMEOUT_MAX)


class ImageConfigOut(ImageConfigBase):
    id: int
    user_id: int
    updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True, "protected_namespaces": ()}
