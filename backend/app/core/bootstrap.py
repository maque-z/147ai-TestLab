"""Startup seeding.

Registration is closed, so a fresh database with no users would be unreachable.
This creates the default account once, and never touches it afterwards — a
password changed later is not reset by a restart.
"""

import logging

from .config import settings
from .database import SessionLocal
from ..crud import user as user_crud
from ..schemas.user import UserCreate

logger = logging.getLogger(__name__)


def seed_default_user() -> None:
    db = SessionLocal()
    try:
        existing = user_crud.get_user_by_username(db, settings.DEFAULT_USERNAME)
        if existing is not None:
            logger.info("Default user %r already present; left unchanged.",
                        settings.DEFAULT_USERNAME)
            return

        user_crud.create_user(db, UserCreate(
            username=settings.DEFAULT_USERNAME,
            password=settings.DEFAULT_PASSWORD,
        ))
        # The password is not logged: it is a real credential, and application
        # logs are the wrong place for one.
        logger.info("Seeded default user %r.", settings.DEFAULT_USERNAME)
    finally:
        db.close()
