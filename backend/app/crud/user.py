from typing import Type, TypeVar
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from pydantic import BaseModel
from ..models.user import User, UserImageConfig, UserBananaConfig
from ..schemas.user import UserCreate
from ..schemas.image_config import ImageConfigUpdate
from ..schemas.banana_config import BananaConfigUpdate
from ..core.security import get_password_hash
from datetime import datetime

# Both config tables have the same shape (one row per user, UNIQUE(user_id)) and
# the same two access patterns, so the get-or-create race handling below is
# written once and parameterised rather than copied — that logic is subtle enough
# that two copies would drift.
ConfigT = TypeVar("ConfigT", UserImageConfig, UserBananaConfig)


def get_user_by_username(db: Session, username: str) -> User | None:
    return db.query(User).filter(User.username == username).first()


def get_user_by_id(db: Session, user_id: int) -> User | None:
    return db.query(User).filter(User.id == user_id).first()


def create_user(db: Session, user_in: UserCreate) -> User:
    hashed = get_password_hash(user_in.password)
    db_user = User(username=user_in.username, hashed_password=hashed)
    db.add(db_user)
    db.commit()
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
    cfg.updated_at = datetime.utcnow()
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
