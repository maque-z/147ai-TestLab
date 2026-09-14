"""Minimal CBOR (RFC 8949) codec for reading C2PA manifests.

C2PA stores its claim, its assertions and its COSE signature as CBOR, so a
manifest cannot be read without a decoder — and nothing else in this backend
needs one, which is why this is a self-contained hundred lines rather than a
dependency. Decoding covers the whole of RFC 8949: every major type,
indefinite lengths, tags, simple values and all three float widths. Encoding
covers only what COSE verification needs — the Sig_structure is an array of
text and byte strings — see `dumps`.

Nothing here knows what a claim is. It turns bytes into Python values and
back; core/c2pa.py interprets them.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass
from typing import Any


class CborError(ValueError):
    """Malformed or truncated CBOR."""


@dataclass(frozen=True)
class Tag:
    """A tagged value (major type 6). A COSE_Sign1 arrives as tag 18."""
    number: int
    value: Any


@dataclass(frozen=True)
class Simple:
    """A simple value (major type 7) other than false / true / null / undefined."""
    value: int


# Returned by _item() for the 0xFF "break" stop code. It never escapes loads():
# a break anywhere but inside an indefinite-length container is an error.
_BREAK = object()

# Nesting deeper than this is not a manifest, it is an attack on the stack.
_MAX_DEPTH = 256

# Indefinite length (additional information 31) is only defined for strings,
# arrays and maps; on integers or tags it is malformed data.
_INDEFINITE_OK = (2, 3, 4, 5)


def _key(k: Any) -> Any:
    """Make a decoded map key hashable. CBOR allows any value as a key; Python
    dicts do not, so arrays become tuples and maps become sorted item tuples."""
    if k is _BREAK:
        raise CborError("break code where a map key was expected")
    if isinstance(k, list):
        return tuple(_key(x) for x in k)
    if isinstance(k, dict):
        return tuple(sorted((repr(a), repr(b)) for a, b in k.items()))
    return k


class _Decoder:
    __slots__ = ("data", "pos")

    def __init__(self, data: bytes) -> None:
        self.data = data
        self.pos = 0

    def _take(self, n: int) -> bytes:
        end = self.pos + n
        if n < 0 or end > len(self.data):
            raise CborError("truncated CBOR data")
        chunk = self.data[self.pos:end]
        self.pos = end
        return chunk

    def _head(self) -> tuple[int, int, int | None]:
        """Read an initial byte and its argument: (major type, additional
        information, argument). The argument is None for indefinite lengths."""
        first = self._take(1)[0]
        major, info = first >> 5, first & 0x1F
        if info < 24:
            return major, info, info
        if info == 24:
            return major, info, self._take(1)[0]
        if info == 25:
            return major, info, int.from_bytes(self._take(2), "big")
        if info == 26:
            return major, info, int.from_bytes(self._take(4), "big")
        if info == 27:
            return major, info, int.from_bytes(self._take(8), "big")
        if info == 31:
            return major, info, None
        raise CborError(f"reserved additional information {info}")

    def _string(self, major: int, length: int | None) -> bytes:
        """The bytes of a byte or text string, joining indefinite-length chunks."""
        if length is not None:
            return self._take(length)
        parts: list[bytes] = []
        while True:
            m, info, n = self._head()
            if m == 7 and info == 31:
                return b"".join(parts)
            if m != major or n is None:
                raise CborError("bad chunk inside an indefinite-length string")
            parts.append(self._take(n))

    def _value(self, depth: int) -> Any:
        """One data item that may not be a break code."""
        v = self._item(depth)
        if v is _BREAK:
            raise CborError("break code outside an indefinite-length container")
        return v

    def _item(self, depth: int) -> Any:
        if depth > _MAX_DEPTH:
            raise CborError("CBOR nested too deeply")
        major, info, arg = self._head()

        if major == 7 and info == 31:
            return _BREAK
        if arg is None and major not in _INDEFINITE_OK:
            raise CborError("indefinite length on a non-container")

        if major == 0:
            return arg
        if major == 1:
            return -1 - arg
        if major == 2:
            return self._string(2, arg)
        if major == 3:
            return self._string(3, arg).decode("utf-8", "replace")

        if major == 4:
            items: list[Any] = []
            if arg is None:
                while True:
                    v = self._item(depth + 1)
                    if v is _BREAK:
                        return items
                    items.append(v)
            for _ in range(arg):
                items.append(self._value(depth + 1))
            return items

        if major == 5:
            out: dict[Any, Any] = {}
            if arg is None:
                while True:
                    k = self._item(depth + 1)
                    if k is _BREAK:
                        return out
                    out[_key(k)] = self._value(depth + 1)
            for _ in range(arg):
                k = self._value(depth + 1)
                out[_key(k)] = self._value(depth + 1)
            return out

        if major == 6:
            return Tag(arg, self._value(depth + 1))

        # Major type 7: simple values and floats. `arg` is never None here.
        if info < 24:
            return {20: False, 21: True, 22: None, 23: None}.get(arg, Simple(arg))
        if info == 24:
            if arg < 32:
                raise CborError("two-byte simple value below 32")
            return Simple(arg)
        if info == 25:
            return struct.unpack(">e", arg.to_bytes(2, "big"))[0]
        if info == 26:
            return struct.unpack(">f", arg.to_bytes(4, "big"))[0]
        return struct.unpack(">d", arg.to_bytes(8, "big"))[0]


def loads(data: bytes | bytearray | memoryview, *, strict: bool = False) -> Any:
    """Decode the first CBOR data item in `data`.

    Byte strings come back as bytes, text strings as str, arrays as lists,
    maps as dicts, tags as Tag. With `strict` any bytes after the item are an
    error; by default they are ignored, which is what a box payload wants.
    """
    dec = _Decoder(bytes(data))
    value = dec._value(0)
    if strict and dec.pos != len(dec.data):
        raise CborError(f"{len(dec.data) - dec.pos} trailing bytes after CBOR item")
    return value


def _head_bytes(major: int, arg: int) -> bytes:
    if arg < 24:
        return bytes([(major << 5) | arg])
    if arg < 0x100:
        return bytes([(major << 5) | 24, arg])
    if arg < 0x1_0000:
        return bytes([(major << 5) | 25]) + arg.to_bytes(2, "big")
    if arg < 0x1_0000_0000:
        return bytes([(major << 5) | 26]) + arg.to_bytes(4, "big")
    return bytes([(major << 5) | 27]) + arg.to_bytes(8, "big")


def dumps(value: Any) -> bytes:
    """Encode ints, bools, None, bytes, str, lists, dicts and Tags — enough to
    build a COSE Sig_structure. Shortest-form (deterministic) heads, always."""
    if value is False:
        return b"\xf4"
    if value is True:
        return b"\xf5"
    if value is None:
        return b"\xf6"
    if isinstance(value, int):
        return _head_bytes(0, value) if value >= 0 else _head_bytes(1, -1 - value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        b = bytes(value)
        return _head_bytes(2, len(b)) + b
    if isinstance(value, str):
        b = value.encode("utf-8")
        return _head_bytes(3, len(b)) + b
    if isinstance(value, (list, tuple)):
        return _head_bytes(4, len(value)) + b"".join(dumps(v) for v in value)
    if isinstance(value, dict):
        return _head_bytes(5, len(value)) + b"".join(dumps(k) + dumps(v) for k, v in value.items())
    if isinstance(value, Tag):
        return _head_bytes(6, value.number) + dumps(value.value)
    raise TypeError(f"cannot encode {type(value).__name__} as CBOR")
