from datetime import datetime

from pydantic import BaseModel, Field, field_validator

# 50 matches the String(50) width on models.User.username. SQLite does not
# enforce VARCHAR lengths, so without this a longer name is stored intact and
# only becomes a problem on some other database.
USERNAME_MIN, USERNAME_MAX = 3, 50

PASSWORD_MIN_CHARS = 8

# bcrypt's hard limit, and the reason this is counted in *bytes* rather than
# characters: one Chinese character is 3 bytes in UTF-8, so this is roughly 24
# of them. bcrypt does not reject a longer password — it silently truncates at
# 72 bytes, which was confirmed directly: the hash of 72 'A' characters verifies
# against 100 'A' characters. Left unchecked, a user setting a long passphrase
# would believe the tail protects them when it never reached the hash at all.
PASSWORD_MAX_BYTES = 72


class UserCreate(BaseModel):
    """The shape, without bounds.

    Deliberately unconstrained. bootstrap.seed_default_user builds one of these
    from settings.DEFAULT_PASSWORD, and a short value in .env would then crash a
    brand-new deployment at startup rather than merely being a weak password.
    Bounds are for what a client sends, so they live on UserRegister — the same
    split schemas/image_config.py already uses for ImageConfigBase/Update.
    """

    username: str
    password: str


class _PasswordPolicy(BaseModel):
    """The password rules, written once and inherited by everything that accepts
    a client-supplied password."""

    password: str = Field(min_length=PASSWORD_MIN_CHARS)

    @field_validator("password")
    @classmethod
    def _within_bcrypt_limit(cls, v: str) -> str:
        if len(v.encode("utf-8")) > PASSWORD_MAX_BYTES:
            raise ValueError(
                f"密码不能超过 {PASSWORD_MAX_BYTES} 字节（约 24 个汉字）"
            )
        return v


class UserRegister(_PasswordPolicy):
    """What a self-registering client may send."""

    username: str = Field(min_length=USERNAME_MIN, max_length=USERNAME_MAX)

    @field_validator("username", mode="before")
    @classmethod
    def _strip(cls, v):
        # mode="before" so the length bounds above measure the trimmed value —
        # otherwise "  ab  " would pass a 3-character minimum on whitespace.
        return v.strip() if isinstance(v, str) else v


class PasswordReset(_PasswordPolicy):
    """Body of the admin password-reset endpoint. Same rules as registration:
    an admin-set password is not exempt from the bcrypt truncation boundary."""


class UserStatusUpdate(BaseModel):
    is_active: bool


class UserOut(BaseModel):
    id: int
    username: str
    created_at: datetime
    # Defaulted rather than required: a row from a partially-migrated database
    # would otherwise turn a plain GET into a 500 during response validation.
    # Same reasoning as the ImageConfigBase docstring.
    is_admin: bool = False
    is_active: bool = True

    model_config = {"from_attributes": True}


class LoginRequest(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut
