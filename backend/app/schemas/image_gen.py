from pydantic import BaseModel
from typing import Optional, List


class GenerateRequest(BaseModel):
    """One request == one param combination. The frontend expands the matrix
    and fires these concurrently so results stream back one by one.

    Every param is optional and omitted from the upstream payload when None —
    "unset" means "let the API apply its own default", which is a distinct case
    from any value the user could pick.

    No `background`: gpt-image-2 rejects background=transparent outright, which
    leaves opaque and auto meaning the same thing, so the param tests nothing.
    """
    prompt: str
    size: Optional[str] = None
    quality: Optional[str] = None
    n: Optional[int] = None
    output_format: Optional[str] = None
    output_compression: Optional[int] = None
    moderation: Optional[str] = None


class GeneratedImage(BaseModel):
    b64_json: Optional[str] = None
    url: Optional[str] = None
    revised_prompt: Optional[str] = None
    # Real format sniffed from magic bytes — the API's declared output_format
    # does not always match the actual bytes.
    image_format: Optional[str] = None
    byte_size: Optional[int] = None


class GenerateResponse(BaseModel):
    images: List[GeneratedImage]
    model: str
    prompt: str
    elapsed_ms: int
    request_id: Optional[str] = None
    # Token usage. The input side splits into prompt text vs reference images —
    # worth seeing separately because gpt-image-2 processes every image input at
    # high fidelity, so reference images dominate the input cost of an edit.
    input_tokens: Optional[int] = None
    input_text_tokens: Optional[int] = None
    input_image_tokens: Optional[int] = None
    output_tokens: Optional[int] = None
    # Echo back what was actually sent upstream, so the UI can label each card.
    # None means the param was left unset and the API chose for itself.
    size: Optional[str] = None
    quality: Optional[str] = None
    # The model the API says it used. Not part of the official response shape, but
    # gateways often include it — and a value that differs from the requested
    # model is exactly the silent-swap case this tool exists to catch.
    upstream_model: Optional[str] = None
    # Response-level output_format claim. Kept separate from each image's
    # magic-byte format so a disagreement between the two stays visible.
    declared_format: Optional[str] = None
