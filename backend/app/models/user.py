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
    user_id = Column(Integer, nullable=False, index=True)
    # API connection
    baseurl = Column(String(500), default="https://api.openai.com/v1")
    api_key = Column(String(500), default="")
    model_id = Column(String(100), default="gpt-image-alpha")
    timeout = Column(Integer, default=120)
    # Generation defaults
    size = Column(String(20), default="1024x1024")
    quality = Column(String(20), default="auto")
    n = Column(Integer, default=1)
    output_format = Column(String(10), default="png")
    output_compression = Column(Integer, default=90)
    background = Column(String(20), default="auto")
    moderation = Column(String(10), default="auto")
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
