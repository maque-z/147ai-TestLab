from datetime import datetime, timezone

from sqlalchemy import Column, DateTime, Integer, String

from ..core.database import Base


def utcnow() -> datetime:
    """Current UTC time, timezone-aware.

    datetime.utcnow() is deprecated in 3.12 and returns a naive value that
    silently pretends to be local time. The columns below are naive DateTime, and
    SQLite's bind processor drops the offset, so the stored string is byte-for-byte
    what utcnow() produced — this is a correctness change at the call site, not a
    storage change, and needs no migration.
    """
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(50), unique=True, index=True, nullable=False)
    hashed_password = Column(String(255), nullable=False)
    created_at = Column(DateTime, default=utcnow)


class UserImageConfig(Base):
    __tablename__ = "user_image_configs"

    id = Column(Integer, primary_key=True, index=True)
    # unique: get_image_config is a read-then-insert, and the frontend fires its
    # matrix concurrently, so two requests on an account with no config row yet
    # could both pass the "not found" check and both insert. The constraint makes
    # the second one fail loudly instead of leaving a duplicate that later reads
    # resolve by insert order.
    #
    # create_all does not ALTER an existing table, so this only covers databases
    # created from here on — bootstrap.ensure_schema() backfills the rest.
    user_id = Column(Integer, nullable=False, index=True, unique=True)
    # API connection
    baseurl = Column(String(500), default="")
    api_key = Column(String(500), default="")
    model_id = Column(String(100), default="gpt-image-2")
    timeout = Column(Integer, default=480)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow)


class UserBananaConfig(Base):
    """Connection settings for the Gemini image endpoints.

    A separate table rather than a column added to UserImageConfig, for two
    reasons. The model id means something different on each side — here it is the
    request *path* (`/v1beta/models/{model}:generateContent`), and the batch
    matrix varies it per request, so the stored value is only the default the
    drawer opens with. And the two surfaces can sit behind different gateway
    groups, so baseurl and key have to be settable independently.
    """

    __tablename__ = "user_banana_configs"

    id = Column(Integer, primary_key=True, index=True)
    # unique for the same reason as user_image_configs above: get_banana_config is
    # a read-then-insert and the frontend fires its matrix concurrently.
    user_id = Column(Integer, nullable=False, index=True, unique=True)
    baseurl = Column(String(500), default="")
    api_key = Column(String(500), default="")
    # Highest-quality model in the official list, and the only one that documents
    # 2K/4K support — the most useful default for a lab that exists to check
    # whether the documented sizes actually come back.
    model_id = Column(String(100), default="gemini-3-pro-image-preview")
    timeout = Column(Integer, default=480)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow)
