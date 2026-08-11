"""Pure byte-level inspection of image payloads.

Nothing here touches the network or the database — every function takes bytes and
answers a question the upstream API's own metadata cannot be trusted to answer.
Lives in core/ because both image endpoints need it: gpt-image reports an
`output_format` that can disagree with the bytes it sent, and Gemini reports an
`inlineData.mimeType` with the same caveat.
"""


def detect_format(head: bytes) -> str | None:
    """Identify the real image format from its magic bytes.

    The API's declared output_format can disagree with the actual bytes, so the
    signature written by the encoder is the reliable source.
    """
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if head.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    if head[:4] == b"GIF8":
        return "gif"
    if head[:2] == b"BM":
        return "bmp"
    return None


def image_dimensions(data: bytes) -> tuple[int, int] | None:
    """(width, height) read straight from the file header, or None if unreadable.

    Only png / jpeg / webp are handled — between them they cover every format
    either upstream actually returns, plus the three the edits endpoint accepts.

    Two callers depend on this. The edits endpoint needs it because the upstream
    requires the mask to match the first image exactly and rejects a one-pixel
    difference with an opaque 400. The Gemini endpoint needs it because the
    documented pixel size for an aspectRatio/imageSize pair is only verifiable
    against the real decoded dimensions.
    """
    if data.startswith(b"\x89PNG\r\n\x1a\n") and len(data) >= 24:
        return (int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big"))

    if data[:4] == b"RIFF" and data[8:12] == b"WEBP" and len(data) >= 30:
        chunk = data[12:16]
        if chunk == b"VP8X":
            return (int.from_bytes(data[24:27], "little") + 1,
                    int.from_bytes(data[27:30], "little") + 1)
        if chunk == b"VP8 ":
            return (int.from_bytes(data[26:28], "little") & 0x3FFF,
                    int.from_bytes(data[28:30], "little") & 0x3FFF)
        if chunk == b"VP8L":
            bits = int.from_bytes(data[21:25], "little")
            return ((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1)
        return None

    if data.startswith(b"\xff\xd8"):
        # Walk the segment chain to the start-of-frame header, which is the only
        # place a JPEG records its dimensions.
        i = 2
        while i + 9 < len(data):
            if data[i] != 0xFF:
                i += 1
                continue
            marker = data[i + 1]
            if marker == 0xFF:          # fill byte before a real marker
                i += 1
                continue
            if marker == 0x01 or 0xD0 <= marker <= 0xD9:  # standalone, no payload
                i += 2
                continue
            if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                return (int.from_bytes(data[i + 7:i + 9], "big"),
                        int.from_bytes(data[i + 5:i + 7], "big"))
            seg = int.from_bytes(data[i + 2:i + 4], "big")
            if seg < 2:
                return None
            i += 2 + seg
        return None

    return None


def b64_byte_size(b64: str) -> int:
    """Decoded byte length of a base64 string, computed without decoding it."""
    n = len(b64)
    if n == 0:
        return 0
    padding = b64[-2:].count("=")
    return n // 4 * 3 - padding


def has_alpha_channel(png: bytes) -> bool | None:
    """Whether a PNG declares an alpha channel, from its IHDR colour type.

    The upstream reads the mask's transparency, so a fully opaque PNG silently
    masks nothing at all — worth catching before spending a generation on it.
    """
    if not png.startswith(b"\x89PNG\r\n\x1a\n") or len(png) < 26:
        return None
    colour_type = png[25]
    return colour_type in (4, 6)  # greyscale+alpha, truecolour+alpha
