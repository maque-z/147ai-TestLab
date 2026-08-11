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
    """Backfill the UNIQUE(user_id) constraint on the per-user config tables.

    create_all only creates missing tables; it never alters one that already
    exists. Without this, the constraint declared on the model would silently
    apply to fresh databases only. Only user_image_configs actually needs the
    backfill — it predates the constraint — but the loop covers both so a table
    added later is not quietly left out.

    Any duplicate rows are collapsed first, keeping the highest id — that is the
    most recently inserted, so a config the user saved after the duplicate
    appeared is the one that survives. Rows are only ever deleted when a genuine
    duplicate exists; the single-row case does nothing.
    """
    for table in ("user_image_configs", "user_banana_configs"):
        _ensure_unique_user_id(table)


def _ensure_unique_user_id(table: str) -> None:
    # `table` is a module constant, never user input. Identifiers cannot be bound
    # parameters, so interpolation is the only option — and is safe here.
    with engine.begin() as conn:
        if not conn.exec_driver_sql(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
        ).first():
            return  # fresh database; create_all already built it with the constraint

        already = conn.exec_driver_sql(
            f"""SELECT 1 FROM pragma_index_list('{table}') WHERE "unique" = 1"""
        ).first()
        if already:
            return

        removed = conn.exec_driver_sql(
            f"DELETE FROM {table} WHERE id NOT IN "
            f"(SELECT MAX(id) FROM {table} GROUP BY user_id)"
        ).rowcount
        if removed:
            logger.warning(
                "Collapsed %d duplicate row(s) in %s, keeping the newest per user.",
                removed, table,
            )

        conn.execute(text(
            f"CREATE UNIQUE INDEX IF NOT EXISTS ux_{table}_user_id "
            f"ON {table} (user_id)"
        ))
        logger.info("Applied UNIQUE(user_id) to %s.", table)


def seed_default_user() -> None:
    db = SessionLocal()
    try:
        existing = user_crud.get_user_by_username(db, settings.DEFAULT_USERNAME)
        if existing is not None:
            logger.info("Default user %r already present; left unchanged.",
                        settings.DEFAULT_USERNAME)
            return

        if not settings.DEFAULT_PASSWORD:
            raise RuntimeError(
                "DEFAULT_PASSWORD is required when seeding a fresh database. "
                "Set it in .env; it is ignored after the account exists."
            )

        user_crud.create_user(db, UserCreate(
            username=settings.DEFAULT_USERNAME,
            password=settings.DEFAULT_PASSWORD,
        ))
        # The password is not logged: it is a real credential, and application
        # logs are the wrong place for one.
        logger.info("Seeded default user %r.", settings.DEFAULT_USERNAME)
    finally:
        db.close()
