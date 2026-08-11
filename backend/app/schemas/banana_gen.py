"""Schemas for the two documented Gemini image-generation surfaces.

Surface A — Gemini native:
    POST {base}/v1beta/models/{model}:generateContent
Surface B — OpenAI-compatible:
    POST {base}/v1/chat/completions   with modalities: ["text","image"]

Same rule as the gpt-image side: every optional param is omitted from the
upstream payload when None, because "unset" ("let the API apply its own
default") is a distinct case from any value the user could pick.
"""

from pydantic import BaseModel
from typing import List, Optional


class BananaGenerateRequest(BaseModel):
    """One request == one param combination, expanded from the matrix.

    `model` is per-request rather than read from the stored config: it goes in the
    URL path, and comparing models against each other is the point of this
    surface — documented aspectRatio and imageSize support differs between them.
    """
    model_config = {"protected_namespaces": ()}

    prompt: str
    # Path segment of /v1beta/models/{model}:generateContent. Falls back to the
    # stored config value when the matrix leaves it unset.
    model_id: Optional[str] = None

    # generationConfig.responseModalities — documented as required, and it must
    # contain "IMAGE" or the model returns text only. Left optional here so the
    # matrix can probe what happens when it is omitted entirely.
    response_modalities: Optional[List[str]] = None

    # generationConfig.imageConfig
    aspect_ratio: Optional[str] = None
    # Documented values: 512 / 1K / 2K / 4K. Case-sensitive — "2k" is ignored by
    # the upstream, so it is passed through verbatim rather than normalised.
    image_size: Optional[str] = None

    # generationConfig
    temperature: Optional[float] = None
    candidate_count: Optional[int] = None
    max_output_tokens: Optional[int] = None
    stop_sequences: Optional[List[str]] = None

    # safetySettings: one threshold applied to all five documented categories,
    # which is how the official example sets them. None omits the block entirely.
    safety_threshold: Optional[str] = None


class BananaChatRequest(BaseModel):
    """Surface B. The doc's own requestBody schema (prompt/n/size) contradicts its
    example (model/messages/stream); the example is what the endpoint actually
    accepts, so this mirrors that and records the discrepancy in the UI.
    """
    model_config = {"protected_namespaces": ()}

    prompt: str
    model_id: Optional[str] = None
    # Documented as the switch that turns on image output for this endpoint.
    modalities: Optional[List[str]] = None
    temperature: Optional[float] = None


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
