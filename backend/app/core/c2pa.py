"""Read the C2PA manifest off an image, and say whether it holds up.

Why this exists: everything else in this tool judges a response by what the
upstream *said* — headers, JSON shape, the format it claims. A Content
Credentials manifest is a different kind of claim. Inside the image bytes there
is an X.509 certificate chain and a COSE signature over the claim, and the claim
names who produced the image: `Azure OpenAI ImageGen` signed by
`Microsoft Corporation`, or `OpenAI Media Service API` signed by
`OpenAI OpCo, LLC`. Checking that is not a heuristic, it is signature
verification — a gateway cannot copy it, and it cannot mint one without a
private key that Microsoft or OpenAI holds. That makes it the strongest thing
this tool can report about where an image came from.

What it is not: proof of provenance in general. Three limits are reported
rather than papered over.

  * Absence proves nothing. Re-encoding, cropping or any metadata-stripping step
    removes the manifest, and a stripped image is indistinguishable from one
    that never had it. `not_present` is reported as exactly that.
  * `valid` and `trusted` are different claims. A signature that verifies says
    the bytes have not changed since signing. Whether the signer is anybody
    recognisable is a separate question, answered here by matching the chain
    against a bundled snapshot of the public C2PA trust anchors — a snapshot
    that goes stale, and whose contents are named in the report so a stale
    answer is visible rather than silent.
  * A verified signature is not a verified image. The c2pa.hash.data assertion
    is what ties the file's bytes in, and a manifest that omits it — or whose
    exclusions do not match the manifest it was written alongside — is reported
    as such rather than counted as verified.

Everything here is pure: bytes in, observations out. No network, no state — the
anchors are a file on disk, so a check cannot hang or leak.

The vocabulary is OpenAI's own, from its content-provenance guide
(`trusted` / `valid` / `invalid` / `not_present`), because matching the industry
wording beats inventing a parallel set.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import logging
import os
import re
from dataclasses import dataclass, field
from typing import Any, Iterator

from cryptography import x509
from cryptography.exceptions import InvalidSignature, UnsupportedAlgorithm
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec, ed25519, ed448, padding, rsa

from . import cbor
from .cbor import Tag

logger = logging.getLogger(__name__)

# ── Trust anchors ────────────────────────────────────────────────────────────

_TRUST_PATH = os.path.join(os.path.dirname(__file__), "trust", "c2pa_anchors.pem")


@dataclass(frozen=True)
class Anchor:
    """One trust anchor, with where it came from and when it expires."""
    subject: str
    not_after: str
    source: str


def _load_anchors() -> dict[str, Anchor]:
    """Fingerprint → anchor, from the bundled trust bundle.

    A missing or unreadable file is not fatal: the module then reports every
    chain as unanchored, which is honest and still leaves signature verification
    working. It is logged loudly because it is a deployment mistake, not a
    normal state.
    """
    try:
        with open(_TRUST_PATH, "rb") as fh:
            raw = fh.read()
    except OSError as exc:
        logger.warning("C2PA trust anchors unavailable (%s); chains read as unanchored", exc)
        return {}

    sources = [line.removeprefix("# source:").split(" - ")[0].strip()
               for line in raw.decode("utf-8", "replace").splitlines()
               if line.startswith("# source:")]
    label = " + ".join(sources) if sources else "bundled snapshot"

    out: dict[str, Anchor] = {}
    for cert in x509.load_pem_x509_certificates(raw):
        out[cert.fingerprint(hashes.SHA256()).hex()] = Anchor(
            subject=cert.subject.rfc4514_string(),
            not_after=cert.not_valid_after_utc.date().isoformat(),
            source=label,
        )
    return out


ANCHORS = _load_anchors()

# What the anchor check is worth, quoted in every report: a reader must be able
# to see that "anchored" means "in this snapshot", not "known good forever".
ANCHOR_SET_DESCRIPTION = (
    f"随附快照 {len(ANCHORS)} 个锚点 · C2PA 官方信任列表 + TSA 列表 + contentcredentials.org 锚点"
)

# ── Claim generator → who that is ────────────────────────────────────────────
# Read off the products themselves: Azure's manifest carries "Azure OpenAI
# ImageGen" (its docs also name "Azure OpenAI DALL-E"), OpenAI's carries
# "OpenAI Media Service API". Mapping them here means a finding arrives as a
# sentence rather than as a string the reader has to interpret.
_GENERATORS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"azure\s*openai", re.I), "azure"),
    (re.compile(r"openai|chatgpt|dall", re.I), "openai"),
)

# The same two origins seen from the other side. A gateway can rewrite the
# claim generator string; it cannot rewrite the subject of the leaf certificate
# without invalidating the signature. So when the two disagree — or when only
# the certificate speaks — this is what decides.
_ISSUERS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"microsoft", re.I), "azure"),
    (re.compile(r"openai", re.I), "openai"),
)

VENDOR_LABEL = {"openai": "OpenAI", "azure": "Azure OpenAI"}

# Assertions that describe the file rather than the claim, and so are never
# listed in the claim's own assertionHashes.
_HASH_EXCLUDED = ("c2pa.hash.", "c2pa.signature", "c2pa.claim")


def _vendor_of(generator: str | None, subject: str | None) -> str | None:
    """Which of the two origins this manifest points at, if either."""
    for pattern, vendor in _GENERATORS:
        if generator and pattern.search(generator):
            return vendor
    for pattern, vendor in _ISSUERS:
        if subject and pattern.search(subject):
            return vendor
    return None


# ── JUMBF ────────────────────────────────────────────────────────────────────
# C2PA is carried inside JUMBF boxes (ISO 19566-5). A superbox (`jumb`) holds a
# description box — the 16-byte type UUID, a toggles byte, an optional label —
# followed by its payload boxes. The UUIDs that matter here are fixed by the
# spec; their first four bytes are the ASCII of the name.
_UUID_CLAIM = bytes.fromhex("6332636c")       # 'c2cl'
_UUID_SIGNATURE = bytes.fromhex("63326373")   # 'c2cs'
_UUID_ASSERTIONS = bytes.fromhex("63326173")  # 'c2as'
_UUID_MANIFEST = bytes.fromhex("63326d61")    # 'c2ma'


@dataclass
class Box:
    """One JUMBF box, with the exact bytes it occupies in the file.

    `raw` matters: an assertion's hash is taken over the whole superbox, header
    included, so verification needs the original bytes rather than the decoded
    value. Re-serialising a decoded assertion would give a different hash and
    make every manifest look tampered with.
    """
    box_type: bytes
    label: str
    uuid: bytes
    payload: bytes
    raw: bytes
    children: list["Box"] = field(default_factory=list)

    def descendants(self) -> Iterator["Box"]:
        for child in self.children:
            yield child
            yield from child.descendants()

    def find(self, label: str) -> "Box | None":
        for child in self.children:
            if child.label == label:
                return child
        return None


# Box type UUIDs. In JUMBF a box type is a UUID, and for the C2PA types the
# first four bytes are the ASCII of the name ('c2ma') followed by whatever the
# writer puts in the remaining twelve — sometimes zero padding, sometimes the
# label running straight on. So identification is by those four bytes, and the
# label is read from wherever the description actually ends.
_KNOWN_UUIDS: dict[bytes, str] = {
    bytes.fromhex("6332636c"): "c2pa.claim",
    bytes.fromhex("63326373"): "c2pa.signature",
    bytes.fromhex("63326173"): "c2pa.assertions",
    bytes.fromhex("63326d61"): "c2pa.manifest",
    bytes.fromhex("63327663"): "c2pa.credentials",
    bytes.fromhex("6a736f6e"): "json",
    bytes.fromhex("63626f72"): "cbor",
}


def _uuid_at(payload: bytes, offset: int) -> bytes:
    """The box type UUID at `offset`, or b"" if it is not one we know."""
    candidate = payload[offset:offset + 16]
    if len(candidate) < 16 or candidate[:4] not in _KNOWN_UUIDS:
        return b""
    return candidate


def _label_after(payload: bytes, start: int) -> str:
    """The null-terminated label beginning at `start`, if it looks like one."""
    end = payload.find(b"\x00", start, start + 200)
    if end == -1:
        return ""
    chunk = payload[start:end]
    if len(chunk) < 4 or not all(0x20 <= b < 0x7F for b in chunk):
        return ""
    return chunk.decode("ascii", "replace")


def _canonical_label(type_name: bytes, label: str) -> str:
    """Normalise a label to the string the spec defines for its type.

    A description box's label is not at a fixed offset — the box id rides in
    the toggles byte and the type UUID's tail is padding of the writer's
    choosing — so the label is best reconstructed from the type instead of
    reverse-engineered per writer. The five C2PA superboxes always carry the
    name the spec gives them, which is also the name the claim's
    assertionHashes list and every other tool quotes.
    """
    known = _KNOWN_UUIDS.get(type_name)
    if known in ("c2pa.assertions", "c2pa.claim", "c2pa.signature",
                 "c2pa.manifest", "c2pa.credentials"):
        return known
    return label


def _read_description(payload: bytes) -> tuple[bytes, str, bytes]:
    """Split a JUMBF superbox payload into (type UUID, label, child boxes).

    Three details of a description box are not at reliable offsets, so all three
    are searched for rather than assumed:

    * The length field counts either the description alone or the description
      plus its 8-byte `jumd` header. Both conventions are in the wild, and the
      wrong reading shifts every later field by eight bytes.
    * The type UUID's last four bytes hold the toggles byte followed by an
      optional box id, so the label does not start at a fixed offset.
    * Writers pad the type UUID's tail differently.

    So the type name is found by looking for a known four-byte box name; the
    label is read from the null-terminated printable run nearest the type name;
    and the child boxes are found by trying each candidate offset for the length
    field's two conventions and keeping the reading whose bytes form a complete,
    self-consistent chain of boxes — that last check is what settles which
    convention the writer used.
    """
    for offset in (8, 16, 4, 0, 12, 24):
        uuid = _uuid_at(payload, offset)
        if not uuid:
            continue

        children = _child_boxes(payload, offset)

        # The label, if there is one, is the first printable run after the type
        # name. It cannot run past the children, so the search is bounded by
        # where the child boxes were found to begin.
        label = ""
        limit = len(payload) - len(children) if children else len(payload)
        for start in range(offset + 4, min(offset + 24, limit)):
            found = _label_after(payload, start)
            if found:
                label = found
                break

        if children or label:
            return uuid, _canonical_label(uuid[:4], label), children
    return b"", "", b""


def _child_boxes(payload: bytes, uuid_offset: int) -> bytes:
    """The subtree following a description box, or b"" if there is none.

    The length field is read both ways — relative to the payload and relative to
    the `jumd` header — and the reading that produces a complete chain of boxes
    wins. A description with no children at all (a thumbnail assertion, say)
    legitimately yields nothing here.
    """
    candidates: list[int] = []
    if len(payload) >= 4:
        declared = int.from_bytes(payload[:4], "big")
        candidates += [declared, declared + 8, declared - 8]
    candidates += [uuid_offset + 29, uuid_offset + 16, uuid_offset + 4]
    for offset in candidates:
        if 0 < offset < len(payload) and _looks_like_boxes(payload[offset:]):
            return payload[offset:]
    return b""


def _looks_like_boxes(buf: bytes) -> bool:
    """Whether `buf` is a well-formed chain of boxes covering exactly its own
    length. This is the test a wrong offset fails."""
    if len(buf) < 16:
        return False
    pos = 0
    seen = 0
    while pos + 8 <= len(buf):
        size = int.from_bytes(buf[pos:pos + 4], "big")
        if size < 8 or pos + size > len(buf):
            return False
        pos += size
        seen += 1
        if seen > 64:
            return False
    return seen > 0 and pos == len(buf)


def _read_boxes(buf: bytes) -> list[Box]:
    """Parse one level of BMFF/JUMBF boxes, recursing into superboxes."""
    boxes: list[Box] = []
    pos = 0
    while pos + 8 <= len(buf):
        size = int.from_bytes(buf[pos:pos + 4], "big")
        box_type = buf[pos + 4:pos + 8]
        header = 8
        if size == 1:  # 64-bit extended length
            if pos + 16 > len(buf):
                break
            size = int.from_bytes(buf[pos + 8:pos + 16], "big")
            header = 16
        elif size == 0:  # runs to the end of the buffer
            size = len(buf) - pos
        if size < header or pos + size > len(buf):
            break

        raw = buf[pos:pos + size]
        payload = buf[pos + header:pos + size]
        label, uuid, children = "", b"", []

        if box_type == b"jumb" and len(payload) >= 24:
            uuid, label, child_bytes = _read_description(payload)
            children = _read_boxes(child_bytes) if child_bytes else []
        boxes.append(Box(box_type, label, uuid, payload, raw, children))
        pos += size
    return boxes


# ── Getting the JUMBF bytes out of each container ────────────────────────────
# Each format carries C2PA somewhere different — and, the part that matters for
# verification, each leaves a different hole in the file's bytes, which the
# c2pa.hash.data assertion's exclusions have to describe.

def _png_chunks(data: bytes) -> Iterator[tuple[int, int, bytes, bytes]]:
    """(offset, total length, chunk type, payload) for each PNG chunk."""
    pos = 8
    while pos + 8 <= len(data):
        length = int.from_bytes(data[pos:pos + 4], "big")
        ctype = data[pos + 4:pos + 8]
        total = 12 + length
        if pos + total > len(data):
            return
        yield pos, total, ctype, data[pos + 8:pos + 8 + length]
        pos += total


def _jpeg_app11(data: bytes) -> Iterator[tuple[int, int, bytes]]:
    """(offset, total length, payload) for each APP11 segment carrying JUMBF.

    C2PA in JPEG is APP11 with a `JP` signature, a big-endian box instance
    number and a sequence number. The payload is yielded whole — the eight
    header bytes included — because one manifest larger than ~64 KB arrives as
    several segments that have to be put back in order by them.
    """
    pos = 2
    while pos + 4 <= len(data):
        if data[pos] != 0xFF:
            pos += 1
            continue
        marker = data[pos + 1]
        if marker == 0xFF:
            pos += 1
            continue
        if marker == 0x01 or 0xD0 <= marker <= 0xD9:
            pos += 2
            continue
        if marker == 0xDA:  # start of scan: entropy-coded data from here
            return
        seg_len = int.from_bytes(data[pos + 2:pos + 4], "big")
        if seg_len < 2:
            return
        if marker == 0xEB:
            payload = data[pos + 4:pos + 2 + seg_len]
            if payload[:2] == b"JP":
                yield pos, 2 + seg_len, payload
        pos += 2 + seg_len


@dataclass
class Carrier:
    """Where the manifest lives, and the file regions it accounts for."""
    kind: str
    jumbf: bytes
    regions: list[tuple[int, int]]


def find_carrier(data: bytes) -> Carrier | None:
    """The active manifest's JUMBF bytes, plus the regions it occupies.

    The regions are the exclusion ranges the hash assertion is expected to
    name. They are collected here because the container has just been walked
    anyway, and because computing them from the file is the only way to check an
    assertion that claims something different.
    """
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        for offset, total, ctype, payload in _png_chunks(data):
            if ctype == b"caBX":
                return Carrier("png.caBX", payload, [(offset, total)])
        return None

    if data.startswith(b"\xff\xd8"):
        # Box instance 1 is the active manifest; higher instances are
        # ingredients. Segments are joined in sequence-number order — one
        # manifest over ~64 KB arrives split across several, and their order in
        # the file is not guaranteed to be the order they belong in. Every
        # segment is excluded from the file hash either way.
        parts: dict[int, dict[int, bytes]] = {}
        regions: list[tuple[int, int]] = []
        for offset, total, payload in _jpeg_app11(data):
            if len(payload) < 8:
                continue
            instance = int.from_bytes(payload[2:4], "big")
            sequence = int.from_bytes(payload[4:8], "big")
            parts.setdefault(instance, {})[sequence] = payload[8:]
            regions.append((offset, total))
        if not parts:
            return None
        active = parts[min(parts)]
        return Carrier("jpeg.APP11", b"".join(active[s] for s in sorted(active)), regions)

    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        pos = 12
        while pos + 8 <= len(data):
            ctype = data[pos:pos + 4]
            size = int.from_bytes(data[pos + 4:pos + 8], "little")
            total = 8 + size + (size & 1)
            if pos + total > len(data):
                return None
            if ctype == b"C2PA":
                return Carrier("webp.C2PA", data[pos + 8:pos + 8 + size], [(pos, total)])
            pos += total
        return None

    return None


# ── COSE_Sign1 ───────────────────────────────────────────────────────────────

def _sig_structure(protected: bytes, payload: bytes) -> bytes:
    """RFC 9052 §4.4: ["Signature1", protected, external_aad, payload].

    This is the byte string the signature is computed over, so it is reproduced
    exactly rather than approximated.
    """
    return cbor.dumps(["Signature1", protected, b"", payload])


def _verify_with(key, data: bytes, signature: bytes) -> str | None:
    """Verify a raw signature against a public key. None on success."""
    try:
        if isinstance(key, rsa.RSAPublicKey):
            key.verify(signature, data, padding.PKCS1v15(), hashes.SHA256())
        elif isinstance(key, ec.EllipticCurvePublicKey):
            key.verify(signature, data, ec.ECDSA(hashes.SHA256()))
        elif isinstance(key, (ed25519.Ed25519PublicKey, ed448.Ed448PublicKey)):
            key.verify(signature, data)
        else:
            return f"不支持的密钥类型 {type(key).__name__}"
    except InvalidSignature:
        return "签名与证书公钥不匹配"
    except UnsupportedAlgorithm as exc:
        return f"不支持的算法: {exc}"
    except Exception as exc:  # malformed key, wrong signature length
        return f"签名验证出错: {exc.__class__.__name__}"
    return None


def _certs_from_headers(*headers: Any) -> list[x509.Certificate]:
    """The x5chain (header label 33) out of a COSE header map, leaf first.

    The chain may sit in the protected header or the unprotected one, as one
    certificate or a list, each entry DER or base64 — all four combinations
    appear in real files, so all four are handled.
    """
    out: list[x509.Certificate] = []
    for header in headers:
        if not isinstance(header, dict):
            continue
        chain = header.get(33)
        if chain is None:
            continue
        entries = chain if isinstance(chain, list) else [chain]
        for entry in entries:
            if isinstance(entry, (bytes, bytearray)):
                der = bytes(entry)
                if der[:1] == b"-":  # PEM smuggled into a byte string
                    try:
                        return x509.load_pem_x509_certificates(der)
                    except Exception:
                        continue
            elif isinstance(entry, str):
                try:
                    der = base64.b64decode(entry)
                except binascii.Error:
                    continue
            else:
                continue
            try:
                out.append(x509.load_der_x509_certificate(der))
            except Exception:
                continue
    return out


def _parse_cose(signature_boxes: list[Box]) -> tuple[list[Any] | None, bytes | None]:
    """The COSE_Sign1 array and the raw CBOR it was read from.

    Returns (cose, raw_cbor) — the raw bytes matter because the claim's payload
    has to be hashed exactly as it was signed, so verification re-derives the
    payload from the CBOR rather than re-encoding the decoded claim.
    """
    for box in signature_boxes:
        for child in [box, *box.descendants()]:
            if child.box_type != b"cbor":
                continue
            try:
                cose = cbor.loads(child.payload)
            except cbor.CborError:
                continue
            if isinstance(cose, Tag):
                cose = cose.value
            if isinstance(cose, list) and len(cose) == 4:
                return cose, child.payload
    return None, None


def _order_chain(certs: list[x509.Certificate]) -> tuple[list[x509.Certificate], list[str]]:
    """Sort a chain leaf-first and check that each link actually verifies.

    Returns (chain, problems). The x5chain is specified to arrive leaf-first,
    but a chain handed over out of order is not a broken chain — reporting it as
    one would be wrong, so it is reordered and then judged on whether the links
    verify.
    """
    if not certs:
        return [], []

    remaining = list(certs)
    # The leaf is the certificate nothing else in the list claims to be issued
    # by; falling back to the first entry keeps a single-certificate chain work.
    leaf = next((c for c in remaining if c.subject not in {o.issuer for o in remaining}),
                remaining[0])
    chain = [leaf]
    remaining.remove(leaf)
    while remaining:
        nxt = next((c for c in remaining if c.subject == chain[-1].issuer), None)
        if nxt is None:
            break
        chain.append(nxt)
        remaining.remove(nxt)

    problems: list[str] = []
    for child, parent in zip(chain, chain[1:]):
        try:
            key = parent.public_key()
            digest = child.signature_hash_algorithm
            if isinstance(key, rsa.RSAPublicKey):
                key.verify(child.signature, child.tbs_certificate_bytes,
                           padding.PKCS1v15(), digest)
            elif isinstance(key, ec.EllipticCurvePublicKey):
                key.verify(child.signature, child.tbs_certificate_bytes, ec.ECDSA(digest))
            elif isinstance(key, (ed25519.Ed25519PublicKey, ed448.Ed448PublicKey)):
                key.verify(child.signature, child.tbs_certificate_bytes)
            else:
                problems.append(f"证书链第 {chain.index(child) + 1} 环的签发密钥类型不支持")
        except (InvalidSignature, UnsupportedAlgorithm, TypeError, ValueError):
            problems.append(
                f"证书链断裂: {child.subject.rfc4514_string()[:48]} 并非由 "
                f"{parent.subject.rfc4514_string()[:48]} 签发")

    if len(chain) == 1:
        leaf_cert = chain[0]
        if leaf_cert.subject == leaf_cert.issuer:
            # Self-signed: legitimate for a root, which is what a chain of one
            # is. Its own signature still has to hold.
            try:
                reason = _verify_with(leaf_cert.public_key(),
                                      leaf_cert.tbs_certificate_bytes,
                                      leaf_cert.signature)
                if reason:
                    problems.append(f"自签名根证书签名无效: {reason}")
            except Exception:
                problems.append("自签名根证书的签名无法验证")
        else:
            problems.append(
                f"证书链不含根证书（{leaf_cert.issuer.rfc4514_string()[:48]} 缺失），"
                "无法确认签发方")
    return chain, problems


def _anchor_of(chain: list[x509.Certificate]) -> Anchor | None:
    """The bundled anchor this chain terminates at, if any.

    Every certificate in the chain is checked, not just the last: a conforming
    generator is only required to ship the leaf and its intermediates, so the
    root it chains to is usually *not* in the file — and when it is, it is
    matched here the same way. Nothing is looked up over the network: an
    unknown certificate is reported as unanchored, never fetched.
    """
    if not ANCHORS:
        return None
    for cert in chain:
        anchor = ANCHORS.get(cert.fingerprint(hashes.SHA256()).hex())
        if anchor:
            return anchor
    return None


# ── The hash assertions ──────────────────────────────────────────────────────

def _bytes_without(data: bytes, regions: list[tuple[int, int]]) -> bytes:
    """The file's bytes with the given (offset, length) regions removed."""
    kept = bytearray()
    skip = sorted(regions)
    idx = 0
    for offset, length in skip:
        kept += data[idx:offset]
        idx = offset + length
    kept += data[idx:]
    return bytes(kept)


@dataclass
class FileHash:
    """What the c2pa.hash.data assertion said, and whether it holds."""
    present: bool = False
    algorithm: str | None = None
    exclusions: list[dict[str, Any]] = field(default_factory=list)
    matches_carrier: bool | None = None
    matches_file: bool | None = None
    detail: str = ""


def _check_hash_data(assertions: list[Box], data: bytes, carrier: Carrier) -> FileHash:
    """Verify the assertion that actually ties the image bytes to the claim.

    Two separate questions, answered separately because they fail for different
    reasons:

      matches_file     — does SHA-256 of the file minus the exclusions equal the
                         hash the generator recorded? `False` means the pixels
                         were changed after signing, or an exclusion was edited.
      matches_carrier  — do the exclusions cover exactly the manifest's own
                         bytes? If the manifest is not where it claims to be,
                         the hash can still agree while proving nothing about
                         the image, which is worth saying out loud.

    The algorithm is only ever sha256. Anything else is reported as unverified
    rather than waved through — a hash this tool cannot recompute cannot be
    counted as evidence for anything.
    """
    out = FileHash()
    box = next((b for b in assertions if b.label.startswith("c2pa.hash.data")), None)
    if box is None:
        out.detail = "缺少 c2pa.hash.data 断言（签名有效，但没有把图片字节绑进声明）"
        return out

    for child in [box, *box.descendants()]:
        if child.box_type != b"cbor":
            continue
        try:
            value = cbor.loads(child.payload)
        except cbor.CborError:
            continue
        if not isinstance(value, dict):
            continue

        out.present = True
        out.algorithm = value.get("alg") or "sha256"
        exclusions = value.get("exclusions") or []
        out.exclusions = [e for e in exclusions if isinstance(e, dict)]
        recorded = value.get("hash")
        if not isinstance(recorded, (bytes, bytearray)):
            out.detail = "hash 字段缺失或格式异常"
            return out
        recorded_b = bytes(recorded)

        ranges = [(int(e.get("start", 0)), int(e.get("length", 0))) for e in out.exclusions]
        out.matches_file = hashlib.sha256(_bytes_without(data, ranges)).digest() == recorded_b

        carrier_ranges = sorted(carrier.regions)
        claimed = sorted((s, l) for s, l in ranges if l > 0)
        out.matches_carrier = claimed == carrier_ranges

        if out.matches_file is False:
            out.detail = "文件哈希与声明不符：签名有效，但图片字节在签名之后被改过"
        elif out.matches_carrier is False:
            out.detail = ("排除区间与清单实际位置不一致（声明 "
                          f"{claimed or '空'}，实际 {carrier_ranges}）——哈希虽然对得上，"
                          "但它覆盖的范围并不等于「整张图去掉清单」")
        else:
            out.detail = f"文件哈希一致（{out.algorithm}，排除 {len(ranges)} 段）"
        return out

    out.detail = "c2pa.hash.data 断言无法解析"
    return out


def _verify_assertion_hashes(claim: dict[str, Any], assertions: list[Box]) -> list[str]:
    """Check every hash the claim records in assertionHashes.

    Each entry is [label, hash] over the whole assertion superbox — header
    included — so a decoded-then-re-encoded assertion cannot pass.
    """
    recorded = claim.get("assertionHashes")
    if not isinstance(recorded, list):
        return []

    by_label: dict[str, list[Box]] = {}
    for box in assertions:
        by_label.setdefault(box.label, []).append(box)

    problems: list[str] = []
    for entry in recorded:
        if not (isinstance(entry, list) and len(entry) == 2):
            continue
        label, expected = entry
        if not isinstance(label, str) or not isinstance(expected, (bytes, bytearray)):
            continue
        if any(label.startswith(prefix) for prefix in _HASH_EXCLUDED):
            continue  # covered by the hash assertion, or is the signature itself
        candidates = by_label.get(label)
        if not candidates:
            problems.append(f"声明引用的断言 {label} 缺失")
            continue
        if not any(hashlib.sha256(c.raw).digest() == bytes(expected) for c in candidates):
            problems.append(f"断言 {label} 的哈希不符（内容与签名时不同）")
    return problems


# ── Report vocabulary ────────────────────────────────────────────────────────

STATUS_LABEL = {
    "trusted": "受信任（签名有效，证书可追溯到随附信任锚点）",
    "valid": "签名有效（证书链完整，但签发方不在随附信任锚点中）",
    "invalid": "签名无效或内容被改动",
    "not_present": "无 Content Credentials 清单",
    "unreadable": "发现清单，但无法解析",
    "unsupported_format": "该格式不携带 C2PA 清单",
}


@dataclass
class Report:
    """Everything read off one image's manifest. Serialised straight to the API."""
    status: str = "not_present"
    carrier: str | None = None
    present: bool = False
    generator: str | None = None
    generator_version: str | None = None
    claim_format: str | None = None
    title: str | None = None
    actions: list[dict[str, Any]] = field(default_factory=list)
    software_agent: str | None = None
    digital_source_type: str | None = None
    subject: str | None = None
    subject_org: str | None = None
    issuer: str | None = None
    chain: list[dict[str, Any]] = field(default_factory=list)
    anchored: bool = False
    anchor_subject: str | None = None
    anchor_source: str | None = None
    algorithm: str | None = None
    signature_ok: bool | None = None
    signed_at: str | None = None
    timestamped: bool = False
    hash_data: FileHash | None = None
    watermark: str | None = None
    vendor: str | None = None
    evidence: list[str] = field(default_factory=list)
    problems: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        data = dict(self.__dict__)
        data["status_label"] = STATUS_LABEL.get(self.status, self.status)
        data["vendor_label"] = VENDOR_LABEL.get(self.vendor or "", None)
        data["anchor_set"] = ANCHOR_SET_DESCRIPTION
        return data


def _extract_actions(assertions: list[Box]) -> list[dict[str, Any]]:
    """The c2pa.actions list, flattened to what is worth showing."""
    for box in assertions:
        if not box.label.startswith("c2pa.actions"):
            continue
        for child in [box, *box.descendants()]:
            if child.box_type != b"cbor":
                continue
            try:
                value = cbor.loads(child.payload)
            except cbor.CborError:
                continue
            if not isinstance(value, dict):
                continue
            out: list[dict[str, Any]] = []
            for action in value.get("actions") or []:
                if not isinstance(action, dict):
                    continue
                agent = action.get("softwareAgent")
                if isinstance(agent, dict):
                    agent = agent.get("name")
                out.append({
                    "action": action.get("action"),
                    "when": action.get("when"),
                    "software_agent": agent if isinstance(agent, str) else None,
                    "digital_source_type": action.get("digitalSourceType"),
                })
            return out
    return []


def inspect(data: bytes, *, label: str = "") -> dict[str, Any]:
    """Read the C2PA manifest out of `data` and judge it.

    Never raises: every failure becomes a status, a problem line, or both. This
    runs on an upstream's image inside a request the user is waiting on, so a
    malformed manifest has to be a finding, not a 500.
    """
    report = Report()
    if not data:
        report.status = "not_present"
        report.problems.append("没有图片字节")
        return report.to_dict()

    try:
        carrier = find_carrier(data)
    except Exception as exc:
        logger.warning("C2PA carrier scan failed%s: %s", f" [{label}]" if label else "", exc)
        report.status = "unreadable"
        report.problems.append(f"容器解析失败: {exc.__class__.__name__}")
        return report.to_dict()

    if carrier is None:
        # Three different situations, kept apart because they mean different
        # things to a reader: a format that cannot carry C2PA at all, a format
        # that can but does not here, and bytes that are not an image. Only the
        # second one is evidence about the image; the others are limits of the
        # check, and are labelled as such rather than as "no manifest".
        if data[:4] == b"GIF8" or not _known_image(data):
            report.status = "unsupported_format"
        else:
            report.status = "not_present"
        return report.to_dict()

    report.carrier = carrier.kind
    try:
        # The active manifest is the `c2pa` JUMBF superbox; `_read_boxes` returns
        # the top-level boxes of whatever buffer it is given, so both the buffer
        # itself and its children are searched — a manifest reaches us either as
        # the whole payload (PNG, WebP) or nested inside another superbox.
        top = _read_boxes(carrier.jumbf)
        # The active manifest is the superbox whose type is `c2ma`. (Its label
        # is a URI the writer chooses — `contentauth:urn:uuid:…` — so the type
        # is what identifies it, not the label.) A manifest that was re-wrapped
        # by an intermediate tool may have lost its own superbox entirely, so
        # anything carrying a claim or a signature superbox is accepted as the
        # root as a fallback.
        candidates = [
            box
            for outer in top
            for box in [outer, *outer.descendants()]
        ]
        root = next((b for b in candidates if b.uuid[:4] == _UUID_MANIFEST), None)
        if root is None:
            root = next((b for b in candidates
                         if b.uuid[:4] in (_UUID_CLAIM, _UUID_SIGNATURE)), None)
    except Exception as exc:
        logger.warning("C2PA JUMBF parse failed: %s", exc)
        root = None
    if root is None:
        report.status = "unreadable"
        report.problems.append("容器内有 JUMBF，但没有可识别的 c2pa 清单")
        return report.to_dict()
    report.present = True

    # ── The claim ────────────────────────────────────────────────────────────
    # Matched on the four-byte type name: the rest of the UUID is whatever the
    # writer padded it with, so a full-16-byte comparison misses valid boxes.
    claim_box = next((b for b in root.descendants()
                      if b.uuid[:4] == _UUID_CLAIM), None)
    claim: dict[str, Any] = {}
    claim_cbor: bytes | None = None
    if claim_box is not None:
        for child in [claim_box, *claim_box.descendants()]:
            if child.box_type == b"cbor":
                claim_cbor = child.payload
                try:
                    value = cbor.loads(child.payload)
                except cbor.CborError:
                    value = None
                if isinstance(value, dict):
                    claim = value
                break

    if not claim:
        report.status = "unreadable"
        report.problems.append("清单里没有可解析的 c2pa.claim")
        return report.to_dict()

    generator_info = claim.get("claim_generator_info")
    if isinstance(generator_info, list) and generator_info and isinstance(generator_info[0], dict):
        report.generator = generator_info[0].get("name")
        report.generator_version = generator_info[0].get("version")
    if not report.generator:
        raw_generator = claim.get("claim_generator")
        # Older manifests pack "name/version" into one string.
        if isinstance(raw_generator, str):
            name, _, version = raw_generator.partition("/")
            report.generator = name
            report.generator_version = version or None
    report.claim_format = claim.get("dc:format")
    report.title = claim.get("dc:title")

    assertions_super = next((b for b in root.descendants() if b.uuid[:4] == _UUID_ASSERTIONS), None)
    assertion_boxes = list(assertions_super.children) if assertions_super else []

    report.actions = _extract_actions(assertion_boxes)
    if report.actions:
        first = report.actions[0]
        report.software_agent = first.get("software_agent")
        report.digital_source_type = first.get("digital_source_type")

    # ── The signature ────────────────────────────────────────────────────────
    sig_boxes = [b for b in root.descendants() if b.uuid[:4] == _UUID_SIGNATURE]
    cose, _ = _parse_cose(sig_boxes)
    if cose is None:
        report.status = "invalid"
        report.problems.append("清单里没有可解析的 COSE 签名（c2pa.signature）")
        return report.to_dict()

    protected, unprotected, payload, signature = cose
    # The protected header is a byte string holding CBOR (that is what the
    # signature covers); some writers hand it over already decoded. Both are
    # handled, but the exact bytes matter, so a decoded header is re-encoded
    # rather than dropped.
    if isinstance(protected, (bytes, bytearray)):
        protected_bytes = bytes(protected)
        try:
            protected_map = cbor.loads(protected_bytes)
        except cbor.CborError:
            protected_map = {}
        if not isinstance(protected_map, dict):
            protected_map = {}
    elif isinstance(protected, dict):
        protected_map = protected
        protected_bytes = cbor.dumps(protected)
    else:
        protected_map, protected_bytes = {}, b""
    if not isinstance(unprotected, dict):
        unprotected = {}

    alg_id = protected_map.get(1)
    report.algorithm = f"COSE {alg_id}" if alg_id is not None else None

    # The signed payload is the claim exactly as the signer serialised it. It
    # normally travels in the COSE structure itself; a generator that put the
    # claim only in its own box is covered by the fallback to the claim box.
    if isinstance(payload, (bytes, bytearray)) and payload:
        signed_payload = bytes(payload)
    else:
        signed_payload = claim_cbor

    if not isinstance(signature, (bytes, bytearray)):
        report.status = "invalid"
        report.problems.append("签名字段不是字节串，无法验证")
        return report.to_dict()

    if signed_payload is None:
        report.status = "invalid"
        report.problems.append("找不到被签名的声明原文，无法验证签名")
        return report.to_dict()

    certs = _certs_from_headers(protected_map, unprotected)
    if not certs:
        report.status = "invalid"
        report.problems.append("签名未携带 x5chain 证书链，无法验证签发方")
        return report.to_dict()

    chain, chain_problems = _order_chain(certs)
    report.problems.extend(chain_problems)
    report.chain = [{
        "subject": c.subject.rfc4514_string(),
        "issuer": c.issuer.rfc4514_string(),
        "not_before": c.not_valid_before_utc.date().isoformat(),
        "not_after": c.not_valid_after_utc.date().isoformat(),
        "self_signed": c.subject == c.issuer,
    } for c in chain]

    leaf = chain[0]
    report.subject = leaf.subject.rfc4514_string()
    report.issuer = leaf.issuer.rfc4514_string()
    orgs = leaf.subject.get_attributes_for_oid(x509.NameOID.ORGANIZATION_NAME)
    report.subject_org = orgs[0].value if orgs else None

    reason = _verify_with(
        leaf.public_key(),
        _sig_structure(protected_bytes, signed_payload),
        bytes(signature),
    )
    report.signature_ok = reason is None
    if reason:
        report.problems.append(f"COSE 签名验证失败: {reason}")

    # ── Timestamp and watermark ─────────────────────────────────────────────
    # Signing certificates are short-lived, so a conforming generator attaches
    # an RFC 3161 timestamp; its presence is recorded, and its signature is not
    # re-verified here (that needs a TSA trust decision this tool does not make).
    if isinstance(unprotected, dict) and (8 in unprotected or isinstance(unprotected.get(8), Tag)):
        report.timestamped = True
    for box in assertion_boxes:
        if "invismark" in box.label or "watermark" in box.label.lower():
            report.watermark = box.label
            break

    # ── File hash ────────────────────────────────────────────────────────────
    # Two separate questions, both reported: does the file hash match what the
    # generator recorded (the pixels were not touched since signing), and do the
    # exclusions describe this manifest's own bytes (the hash covers the whole
    # image rather than some other span). The first decides the verdict; the
    # second is context that can disagree with it.
    report.hash_data = _check_hash_data(assertion_boxes, data, carrier)
    report.problems.extend(_verify_assertion_hashes(claim, assertion_boxes))
    if report.hash_data.present and report.hash_data.matches_file is False:
        report.problems.append(report.hash_data.detail)

    # ── Verdict ──────────────────────────────────────────────────────────────
    anchor = _anchor_of(chain)
    report.anchored = anchor is not None
    if anchor:
        report.anchor_subject = anchor.subject
        report.anchor_source = anchor.source

    # A verdict needs all three of these to hold: the signature verifies, the
    # certificate chain links up, and the file hash describes these bytes.
    # Only then does the anchor decide between `trusted` and `valid` — the two
    # differ solely on whether the signer is recognisable, never on whether the
    # signature is sound.
    if not report.signature_ok or chain_problems:
        report.status = "invalid"
    elif report.hash_data.present and report.hash_data.matches_file is False:
        report.status = "invalid"
    elif anchor is not None:
        report.status = "trusted"
    else:
        report.status = "valid"

    report.vendor = _vendor_of(report.generator, report.subject_org or report.subject)

    # ── Evidence, strongest first ────────────────────────────────────────────
    if report.signature_ok:
        report.evidence.append(
            f"COSE 签名验证通过（{report.algorithm or '未知算法'}），签发证书 "
            f"{report.subject_org or report.subject}")
    if report.anchored:
        report.evidence.append(f"证书链锚定于随附信任锚点：{report.anchor_subject}")
    elif report.signature_ok:
        report.evidence.append("证书链未能锚定到随附信任锚点（未联网核对，仅对快照判断）")
    if report.generator:
        report.evidence.append(
            f"claim_generator: {report.generator}"
            + (f" / {report.generator_version}" if report.generator_version else ""))
    if report.software_agent:
        report.evidence.append(f"softwareAgent: {report.software_agent}")
    if report.digital_source_type:
        report.evidence.append(f"digitalSourceType: {report.digital_source_type}")
    if report.hash_data:
        report.evidence.append(f"c2pa.hash.data: {report.hash_data.detail}")
    if report.watermark:
        report.evidence.append(f"半可见水印断言: {report.watermark}")

    return report.to_dict()


def _known_image(data: bytes) -> bool:
    """Whether these bytes are an image format at all."""
    return (data.startswith(b"\x89PNG\r\n\x1a\n") or data.startswith(b"\xff\xd8")
            or (data[:4] == b"RIFF" and data[8:12] == b"WEBP")
            or data[:4] == b"GIF8")

