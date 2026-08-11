"""Startup seeding and small schema backfills.

Registration is closed, so a fresh database with no users would be unreachable.
This creates the default account once, and never touches it afterwards — a
password changed later is not reset by a restart.
"""

import logging

from sqlalchemy import text

from .config import settings
from .database import SessionLocal, engine
from ..crud import user as user_crud
from ..schemas.user import UserCreate

logger = logging.getLogger(__name__)


def ensure_schema() -> None:
    """Apply the UNIQUE(user_id) on user_image_configs to pre-existing databases.

    create_all only creates missing tables; it never alters one that already
    exists. Without this, the constraint declared on the model would silently
    apply to fresh databases only.

    Any duplicate rows are collapsed first, keeping the highest id — that is the
    most recently inserted, so a config the user saved after the duplicate
    appeared is the one that survives. Rows are only ever deleted when a genuine
    duplicate exists; the single-row case does nothing.
    """
    with engine.begin() as conn:
        if not conn.exec_driver_sql(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='user_image_configs'"
        ).first():
            return  # fresh database; create_all already built it with the constraint

        already = conn.exec_driver_sql(
            "SELECT 1 FROM pragma_index_list('user_image_configs') WHERE \"unique\" = 1"
        ).first()
        if already:
            return

        removed = conn.exec_driver_sql(
            "DELETE FROM user_image_configs WHERE id NOT IN "
            "(SELECT MAX(id) FROM user_image_configs GROUP BY user_id)"
        ).rowcount
        if removed:
            logger.warning(
                "Collapsed %d duplicate image-config row(s), keeping the newest per user.",
                removed,
            )

        conn.execute(text(
            "CREATE UNIQUE INDEX IF NOT EXISTS ux_user_image_configs_user_id "
            "ON user_image_configs (user_id)"
        ))
        logger.info("Applied UNIQUE(user_id) to user_image_configs.")


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
