from datetime import datetime
from sqlalchemy import Column, Integer, String, DateTime, Text
from ..core.database import Base


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(50), unique=True, index=True, nullable=False)
    hashed_password = Column(String(255), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)


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
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
