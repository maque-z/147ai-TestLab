from typing import Type, TypeVar
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from pydantic import BaseModel
from ..models.user import User, UserImageConfig, UserBananaConfig, utcnow
from ..schemas.user import UserCreate
from ..schemas.image_config import ImageConfigUpdate
from ..schemas.banana_config import BananaConfigUpdate
from ..core.security import get_password_hash

# Both config tables have the same shape (one row per user, UNIQUE(user_id)) and
# the same two access patterns, so the get-or-create race handling below is
# written once and parameterised rather than copied — that logic is subtle enough
# that two copies would drift.
ConfigT = TypeVar("ConfigT", UserImageConfig, UserBananaConfig)


class UsernameTaken(Exception):
    """create_user lost the race on UNIQUE(users.username).

    A domain exception rather than letting IntegrityError escape, so the API
    layer does not have to import sqlalchemy.exc to tell "name is taken" apart
    from a genuine database fault.
    """


def get_user_by_username(db: Session, username: str) -> User | None:
    return db.query(User).filter(User.username == username).first()


def get_user_by_id(db: Session, user_id: int) -> User | None:
    return db.query(User).filter(User.id == user_id).first()


def create_user(db: Session, user_in: UserCreate, *, is_admin: bool = False) -> User:
    hashed = get_password_hash(user_in.password)
    db_user = User(
        username=user_in.username,
        hashed_password=hashed,
        is_admin=is_admin,
    )
    db.add(db_user)
    try:
        db.commit()
    except IntegrityError:
        # UNIQUE(username). Unreachable while registration was closed — the only
        # caller was the startup seed, which checks first. Open registration makes
        # it reachable by two clients picking the same name at the same moment,
        # and uncaught it surfaces as a 500.
        db.rollback()
        raise UsernameTaken(user_in.username) from None
    db.refresh(db_user)
    return db_user


def _get_or_create_config(db: Session, model: Type[ConfigT], user_id: int) -> ConfigT:
    cfg = db.query(model).filter(model.user_id == user_id).first()
    if cfg is not None:
        return cfg

    # Read-then-insert, so two concurrent first requests can both get here. The
    # UNIQUE(user_id) constraint means the loser raises instead of inserting a
    # duplicate; re-read to pick up the row the winner committed.
    cfg = model(user_id=user_id)
    db.add(cfg)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        cfg = db.query(model).filter(model.user_id == user_id).first()
        if cfg is None:
            raise  # not the duplicate we assumed; the caller should see it
        return cfg
    db.refresh(cfg)
    return cfg


def _update_config(db: Session, cfg: ConfigT, cfg_in: BaseModel) -> ConfigT:
    # exclude_unset: every field on the config schemas has a default, so a body
    # that omits one would otherwise arrive as that default and overwrite the
    # stored value. Sending only model_id would blank the user's baseurl and
    # api_key. The current frontend submits the whole form, so this changes
    # nothing for it.
    for field, value in cfg_in.model_dump(exclude_unset=True).items():
        setattr(cfg, field, value)
    cfg.updated_at = utcnow()
    db.commit()
    db.refresh(cfg)
    return cfg


def get_image_config(db: Session, user_id: int) -> UserImageConfig:
    return _get_or_create_config(db, UserImageConfig, user_id)


def update_image_config(db: Session, user_id: int, cfg_in: ImageConfigUpdate) -> UserImageConfig:
    return _update_config(db, get_image_config(db, user_id), cfg_in)


def get_banana_config(db: Session, user_id: int) -> UserBananaConfig:
    return _get_or_create_config(db, UserBananaConfig, user_id)


def update_banana_config(db: Session, user_id: int, cfg_in: BananaConfigUpdate) -> UserBananaConfig:
    return _update_config(db, get_banana_config(db, user_id), cfg_in)


def list_users(db: Session) -> list[User]:
    """Every account, oldest first — registration order is what the admin table
    reads most naturally."""
    return db.query(User).order_by(User.id).all()


def count_admins(db: Session) -> int:
    return db.query(User).filter(User.is_admin.is_(True)).count()


def set_user_active(db: Session, user: User, is_active: bool) -> User:
    """Enable or disable an account.

    Only the flag moves. password_changed_at is deliberately left alone: a
    disabled account is already refused by deps.get_current_user on is_active, and
    bumping the anchor would additionally invalidate the account's tokens forever
    — so re-enabling would not restore the session the admin just interrupted.
    """
    user.is_active = is_active
    db.commit()
    db.refresh(user)
    return user


def reset_password(db: Session, user: User, new_password: str) -> User:
    """Set a new password and end every session that used the old one.

    Moving password_changed_at forward is what makes the reset take effect
    immediately: deps.get_current_user rejects any token issued before it. Without
    this line the old password would stop working while tokens minted with it kept
    working for the rest of their seven days.
    """
    user.hashed_password = get_password_hash(new_password)
    user.password_changed_at = utcnow()
    db.commit()
    db.refresh(user)
    return user


def delete_user(db: Session, user: User) -> None:
    """Delete an account together with both of its config rows.

    The config tables carry no foreign key — user_id is a plain Integer column —
    so nothing cascades on its own, and the rows would be left behind as orphans.
    That is not merely untidy, it leaks credentials: SQLite hands out max(id)+1
    for an INTEGER PRIMARY KEY declared without AUTOINCREMENT, so deleting the
    highest-id account frees that exact id for the next registration. The new
    account would then be matched by _get_or_create_config to the orphaned rows
    and silently inherit the previous owner's baseurl and api_key.

    One transaction: a partial delete is the state that produces the leak.
    """
    db.query(UserImageConfig).filter(UserImageConfig.user_id == user.id).delete()
    db.query(UserBananaConfig).filter(UserBananaConfig.user_id == user.id).delete()
    db.delete(user)
    db.commit()
