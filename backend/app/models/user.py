from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, Column, DateTime, Integer, String

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

    # Rows that predate these three columns are backfilled by
    # bootstrap._ensure_user_columns(). create_all never alters an existing
    # table, so without that backfill these would apply to fresh databases only.
    is_admin = Column(Boolean, nullable=False, default=False)
    is_active = Column(Boolean, nullable=False, default=True)
    # The anchor that makes a stateless JWT revocable: deps.get_current_user
    # rejects any token issued before this moment. Reset on password change.
    password_changed_at = Column(DateTime, nullable=False, default=utcnow)


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
    # Legacy single-model field. The model is chosen per request from the
    # parameter panel now (selected_models below), so rows created from here on
    # leave this empty. A non-empty value only exists on rows written before the
    # change, and bootstrap._seed_image_model_selection() carries it into the
    # selection exactly once. Empty rather than a model default on purpose: that
    # seed keys on "model_id set, selection empty", and a default here would make
    # every untouched new row look like a legacy one on the next restart.
    model_id = Column(String(100), default="")
    # The models ticked in the parameter panel, in click order. Persisted so the
    # panel reopens where it was left, and because each entry becomes its own
    # request in a batch — two models ticked is two requests per combination,
    # side by side. JSON for the same reason as UserBananaConfig.custom_models.
    selected_models = Column(JSON, default=list, nullable=False)
    # Model ids the user typed in: gateway aliases, dated snapshots, models newer
    # than the documented list. Kept apart from the selection so an id can be
    # unticked without being forgotten.
    custom_models = Column(JSON, default=list, nullable=False)
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
    model_id = Column(String(100), default="gemini-3.1-flash-image")
    # User-provided model ids are kept separately from the default so the
    # documented model list remains visible while custom gateway aliases can be
    # selected in the batch matrix. JSON is supported by SQLite and keeps the
    # config API as a real list instead of a delimiter-encoded string.
    custom_models = Column(JSON, default=list, nullable=False)
    timeout = Column(Integer, default=480)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow)
