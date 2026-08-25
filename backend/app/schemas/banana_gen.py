"""Schemas for the two documented Gemini image-generation surfaces.

Surface A — Gemini native:
    POST {base}/v1beta/models/{model}:generateContent
Surface B — OpenAI-compatible:
    POST {base}/v1/chat/completions   with modalities: ["text","image"]

Same rule as the gpt-image side: every optional param is omitted from the
upstream payload when None, because "unset" ("let the API apply its own
default") is a distinct case from any value the user could pick.
"""

from pydantic import BaseModel, Field, field_validator
from typing import List, Optional

from .image_gen import MAX_PARAM_LEN, MAX_PROMPT_LEN

# Same principle as the gpt-image side: wider than the documented ranges on
# purpose, so an out-of-spec value can still be sent and the API's own reaction
# observed. temperature is documented 0-2 and candidateCount 1-4; both are allowed
# past that here. Only impossible values are refused.
TEMPERATURE_MIN, TEMPERATURE_MAX = 0.0, 4.0
CANDIDATE_MIN, CANDIDATE_MAX = 1, 32
MAX_OUTPUT_TOKENS_MAX = 1_000_000
MAX_LIST_ITEMS = 16


class BananaReferenceImage(BaseModel):
    """One inlineData part used by Gemini native image editing."""

    mime_type: str = Field(max_length=64)
    data: str

    @field_validator("mime_type")
    @classmethod
    def validate_mime(cls, value: str) -> str:
        if value not in {"image/png", "image/jpeg", "image/webp"}:
            raise ValueError("参考图仅支持 PNG、JPEG 或 WebP")
        return value


SAFETY_THRESHOLD_VALUES = (
    'HARM_BLOCK_THRESHOLD_UNSPECIFIED', 'BLOCK_LOW_AND_ABOVE',
    'BLOCK_MEDIUM_AND_ABOVE', 'BLOCK_ONLY_HIGH', 'BLOCK_NONE', 'OFF',
)
SAFETY_CATEGORY_VALUES = {
    'HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH',
    'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT',
    'HARM_CATEGORY_CIVIC_INTEGRITY', 'HARM_CATEGORY_JAILBREAK',
}
THINKING_LEVEL_VALUES = {'THINKING_LEVEL_UNSPECIFIED', 'MINIMAL', 'LOW', 'MEDIUM', 'HIGH'}


class BananaSafetySetting(BaseModel):
    category: str = Field(max_length=MAX_PARAM_LEN)
    threshold: str = Field(max_length=MAX_PARAM_LEN)

    @field_validator('threshold')
    @classmethod
    def validate_threshold(cls, value: str) -> str:
        if value not in SAFETY_THRESHOLD_VALUES:
            raise ValueError('安全阈值不是 Gemini 官方枚举值')
        return value

    @field_validator('category')
    @classmethod
    def validate_category(cls, value: str) -> str:
        if value not in SAFETY_CATEGORY_VALUES:
            raise ValueError('安全类别不是 Gemini 官方枚举值')
        return value


class BananaGenerateRequest(BaseModel):
    """One request == one param combination, expanded from the matrix.

    `model` is per-request rather than read from the stored config: it goes in the
    URL path, and comparing models against each other is the point of this
    surface — documented aspectRatio and imageSize support differs between them.
    """
    model_config = {"protected_namespaces": ()}

    prompt: str = Field(min_length=1, max_length=MAX_PROMPT_LEN)
    # Path segment of /v1beta/models/{model}:generateContent. Falls back to the
    # stored config value when the matrix leaves it unset. Length-capped because
    # it is interpolated into the request path; the characters that could escape
    # that path are rejected separately, in resolve_model.
    model_id: Optional[str] = Field(default=None, max_length=MAX_PARAM_LEN)

    # generationConfig.responseModalities — documented as required, and it must
    # contain "IMAGE" or the model returns text only. Left optional here so the
    # matrix can probe what happens when it is omitted entirely.
    response_modalities: Optional[List[str]] = Field(
        default=None, max_length=MAX_LIST_ITEMS
    )

    # generationConfig.imageConfig
    aspect_ratio: Optional[str] = Field(default=None, max_length=MAX_PARAM_LEN)
    # Documented values: 512 / 1K / 2K / 4K. Case-sensitive — "2k" is ignored by
    # the upstream, so it is passed through verbatim rather than normalised.
    image_size: Optional[str] = Field(default=None, max_length=MAX_PARAM_LEN)

    # generationConfig
    temperature: Optional[float] = Field(
        default=None, ge=TEMPERATURE_MIN, le=TEMPERATURE_MAX
    )
    candidate_count: Optional[int] = Field(
        default=None, ge=CANDIDATE_MIN, le=CANDIDATE_MAX
    )
    max_output_tokens: Optional[int] = Field(
        default=None, ge=1, le=MAX_OUTPUT_TOKENS_MAX
    )
    stop_sequences: Optional[List[str]] = Field(
        default=None, max_length=5
    )
    top_p: Optional[float] = Field(default=None, ge=0, le=1)
    top_k: Optional[int] = Field(default=None, ge=1)
    seed: Optional[int] = None

    # Editing uses the same endpoint and parameters as generation; supplying
    # inlineData parts before the text part changes the task into an edit.
    reference_images: Optional[List[BananaReferenceImage]] = Field(
        default=None, max_length=16
    )
    # Gemini documents no dedicated mask field. This probe is normalised by the
    # backend into a final inlineData part plus an explicit text instruction.
    mask_image: Optional[BananaReferenceImage] = None

    # safetySettings: one object per category. None omits the block entirely.
    safety_settings: Optional[List[BananaSafetySetting]] = Field(default=None, max_length=16)
    thinking_level: Optional[str] = Field(default=None, max_length=MAX_PARAM_LEN)
    include_thoughts: Optional[bool] = None
    thinking_budget: Optional[int] = Field(default=None, ge=-1, le=1_000_000)

    @field_validator('thinking_level')
    @classmethod
    def validate_thinking_level(cls, value: str | None) -> str | None:
        if value is not None and value not in THINKING_LEVEL_VALUES:
            raise ValueError('思考等级不是 Gemini 官方枚举值')
        return value


class BananaChatRequest(BaseModel):
    """Surface B. The doc's own requestBody schema (prompt/n/size) contradicts its
    example (model/messages/stream); the example is what the endpoint actually
    accepts, so this mirrors that and records the discrepancy in the UI.
    """
    model_config = {"protected_namespaces": ()}

    prompt: str = Field(min_length=1, max_length=MAX_PROMPT_LEN)
    model_id: Optional[str] = Field(default=None, max_length=MAX_PARAM_LEN)
    # Documented as the switch that turns on image output for this endpoint.
    modalities: Optional[List[str]] = Field(default=None, max_length=MAX_LIST_ITEMS)
    temperature: Optional[float] = Field(
        default=None, ge=TEMPERATURE_MIN, le=TEMPERATURE_MAX
    )


class BananaImage(BaseModel):
    b64_json: Optional[str] = None
    url: Optional[str] = None
    # inlineData.mimeType as claimed by the upstream.
    declared_mime: Optional[str] = None
    # Format sniffed from magic bytes — authoritative when the two disagree.
    image_format: Optional[str] = None
    byte_size: Optional[int] = None
    # Read from the file header server-side, so the documented pixel size for an
    # aspectRatio/imageSize pair can be checked without waiting for a browser
    # decode. None when the header could not be parsed.
    width: Optional[int] = None
    height: Optional[int] = None
    # Which candidate this image came from, so a candidateCount > 1 response can
    # be told apart from one candidate that returned several parts.
    candidate_index: Optional[int] = None
    # Container-level alpha declaration, read from the actual returned bytes.
    # This is distinct from whether any pixel is transparent, which the browser
    # samples after decoding.
    has_alpha_channel: Optional[bool] = None


class BananaGenerateResponse(BaseModel):
    model_config = {"protected_namespaces": ()}

    images: List[BananaImage]
    # Text parts, if any. A response with text but no image is the documented
    # symptom of responseModalities missing "IMAGE".
    texts: List[str] = []

    model: str
    prompt: str
    elapsed_ms: int
    request_id: Optional[str] = None

    # Echo of what was actually sent upstream; None means the param was omitted
    # and the API chose for itself.
    aspect_ratio: Optional[str] = None
    image_size: Optional[str] = None

    # candidates[].finishReason. STOP is normal; SAFETY / IMAGE_SAFETY /
    # PROHIBITED_CONTENT / OTHER / MAX_TOKENS are the documented refusals.
    finish_reasons: List[str] = []
    candidate_count: Optional[int] = None

    # usageMetadata
    prompt_tokens: Optional[int] = None
    candidates_tokens: Optional[int] = None
    total_tokens: Optional[int] = None

    # modelVersion is not in the documented response shape, but gateways commonly
    # include it — and a value that differs from the requested model is exactly
    # the silent-swap case this tool exists to catch.
    upstream_model: Optional[str] = None

    # Set when the upstream returned 200 with no image at all, carrying whatever
    # the body said instead. Kept separate from an HTTP error: a 200 that refuses
    # is a different finding from a request that failed.
    block_reason: Optional[str] = None
