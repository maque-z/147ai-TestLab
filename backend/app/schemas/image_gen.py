from pydantic import BaseModel, Field
from typing import Any, Optional, List

# One width for a model id everywhere it can be typed: config lists and the
# per-request field below must agree, or an id that saves fine would fail to send.
from .image_config import MAX_MODEL_LEN

# Bounds are deliberately wider than the vendor's documented ranges.
#
# This tool exists to find where a gateway disagrees with the published spec, so a
# value the doc calls invalid still has to be sendable: n=50 against a documented
# max of 10 is a probe, not a typo, and clamping it here would mean the API's
# refusal never gets observed. What is rejected is only what cannot be anything
# but a mistake — a negative count, an unbounded string, a compression percentage
# outside 0-100.
#
# Shared with /edit, which takes the same params as multipart Form fields rather
# than a JSON body. Two copies of these numbers is exactly the kind of thing that
# drifts, so the Form declarations import these.
MAX_PROMPT_LEN = 32_000
# Long enough for any plausible value ("3840x2160", "gemini-3-pro-image-preview")
# without letting a megabyte of text through as a "quality".
MAX_PARAM_LEN = 64
N_MIN, N_MAX = 1, 100
COMPRESSION_MIN, COMPRESSION_MAX = 0, 100


class GenerateRequest(BaseModel):
    """One request == one param combination. The frontend expands the matrix
    and fires these concurrently so results stream back one by one.

    Every param is optional and omitted from the upstream payload when None —
    "unset" means "let the API apply its own default", which is a distinct case
    from any value the user could pick.

    `model_id` is the one exception to that rule: there is no "let the API
    decide" for it (an Images call with no model falls back to a model that no
    longer exists), so when the request leaves it unset the account's saved
    selection is used instead — see api/image_gen.resolve_model.
    """
    # model_id names the upstream model, not a Pydantic attribute.
    model_config = {"protected_namespaces": ()}

    prompt: str = Field(min_length=1, max_length=MAX_PROMPT_LEN)
    # Per request rather than read from the stored config, because the matrix
    # varies it: several models ticked is one request per model, on identical
    # params, which is how two models behind one gateway get compared.
    model_id: Optional[str] = Field(default=None, max_length=MAX_MODEL_LEN)
    size: Optional[str] = Field(default=None, max_length=MAX_PARAM_LEN)
    quality: Optional[str] = Field(default=None, max_length=MAX_PARAM_LEN)
    n: Optional[int] = Field(default=None, ge=N_MIN, le=N_MAX)
    output_format: Optional[str] = Field(default=None, max_length=MAX_PARAM_LEN)
    output_compression: Optional[int] = Field(
        default=None, ge=COMPRESSION_MIN, le=COMPRESSION_MAX
    )
    moderation: Optional[str] = Field(default=None, max_length=MAX_PARAM_LEN)
    # transparent / opaque / auto, default auto. This param was previously left
    # out on the grounds that gpt-image-2 refused transparent outright — true
    # when that was written, and no longer: the changelog entry dated 2026-08-20
    # put transparency in preview for gpt-image-2 and gpt-image-2-2026-04-21.
    # Alpha needs a container that can carry it, so the docs pair transparent
    # with png or webp and state jpeg cannot do it. The jpeg combination is still
    # sendable here, because what the API does with it is worth observing.
    background: Optional[str] = Field(default=None, max_length=MAX_PARAM_LEN)


class GeneratedImage(BaseModel):
    b64_json: Optional[str] = None
    # Kept only when the upstream handed out an http(s) link (see data_kind);
    # a data: URL is unpacked into b64_json instead of being shipped twice.
    url: Optional[str] = None
    revised_prompt: Optional[str] = None
    # Real format sniffed from magic bytes - the API's declared output_format
    # does not always match the actual bytes. None when there were no bytes to
    # sniff (a link that could not be downloaded), and deliberately *not*
    # backfilled from the declaration: a claim standing in for a measurement
    # is exactly what this tool exists to avoid.
    image_format: Optional[str] = None
    byte_size: Optional[int] = None
    # How the upstream actually delivered the image. The official reference is
    # explicit for GPT image models: b64_json is "returned by default" and
    # url is "unsupported", so anything but b64_json is itself a finding:
    #   b64_json  raw base64 in the documented field
    #   data_url  a data:image/...;base64, string - a re-serialising gateway
    #   url       an http(s) link - a gateway re-hosting the file, or a
    #             ChatGPT-web relay handing out its own download link; fetched
    #             server-side so the bytes can still be measured
    #   none      the item carried no image at all
    data_kind: Optional[str] = None
    # Which wire field carried it: b64_json / url / result. `result` is the
    # field name inside a Responses API image_generation_call; seeing it here
    # means a gateway forwarded that item without converting it.
    data_field: Optional[str] = None
    # The link exactly as returned, when data_kind is url. Its host is
    # evidence: oaiusercontent.com is ChatGPT's file store, not the Images API.
    source_url: Optional[str] = None
    # Why the link could not be downloaded, when it could not. The card then
    # renders the link directly and reports the bytes as unmeasurable.
    fetch_error: Optional[str] = None

class UpstreamSnapshot(BaseModel):
    """One upstream HTTP exchange, verbatim, for the observation modal.

    Headers are kept as ordered [name, value] pairs straight off the wire —
    a dict would collapse duplicates (set-cookie) and lose the order they
    actually arrived in. `body` is the parsed JSON with base64 image payloads
    replaced by short stubs; everything else is complete. `body_text` carries
    a body that failed to parse as JSON (an HTML error page from a mis-pointed
    baseurl) instead.
    """
    status: int
    reason: Optional[str] = None
    http_version: Optional[str] = None
    headers: List[List[str]] = Field(default_factory=list)
    body: Any = None
    body_text: Optional[str] = None


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
    background: Optional[str] = None
    # The model the API says it used. Not part of the official response shape, but
    # gateways often include it — and a value that differs from the requested
    # model is exactly the silent-swap case this tool exists to catch.
    upstream_model: Optional[str] = None
    # Response-level output_format claim. Kept separate from each image's
    # magic-byte format so a disagreement between the two stays visible.
    declared_format: Optional[str] = None
    # Response-level background claim, kept separate from the echo above for the
    # same reason. Documented as a top-level field alongside output_format,
    # quality and size, but read defensively all the same — a gateway that
    # omits it is a finding, not a crash.
    declared_background: Optional[str] = None
    # The raw exchange this card was built from, with base64 payloads stubbed.
    # The parsed fields above are this tool's *reading* of the response; the
    # snapshot is the evidence, so a claim can always be checked against it.
    upstream: Optional[UpstreamSnapshot] = None
