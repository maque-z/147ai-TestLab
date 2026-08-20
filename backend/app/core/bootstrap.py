"""Startup seeding and small schema backfills.

A fresh database has no users, and the first administrator cannot be created by
self-registration — is_admin has no write endpoint. This creates the default
account once, and never touches it afterwards — a password changed later is not
reset by a restart.
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

    # Order matters: _promote_default_admin writes is_admin, so the column has
    # to exist first.
    _ensure_user_columns()
    _promote_default_admin()


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


# Backfill value for password_changed_at on rows that predate the column.
#
# Deliberately not utcnow(): get_current_user rejects a token whose `iat` is
# older than this value, so backfilling "now" would invalidate every token that
# is currently valid — the upgrade itself would log everyone out. An epoch value
# is older than any token that can exist, so live sessions survive the upgrade.
_EPOCH = "1970-01-01 00:00:00.000000"

# (column name, DDL). SQLite permits ADD COLUMN with NOT NULL only when a
# non-null DEFAULT is supplied, which is why each carries one. The SQL-level
# default never applies to new rows — SQLAlchemy always sends these columns
# explicitly — it exists solely to satisfy the backfill of existing rows.
_USER_COLUMNS = (
    ("is_admin", "BOOLEAN NOT NULL DEFAULT 0"),
    ("is_active", "BOOLEAN NOT NULL DEFAULT 1"),
    ("password_changed_at", f"DATETIME NOT NULL DEFAULT '{_EPOCH}'"),
)


def _ensure_user_columns() -> None:
    """Add the account-management columns to an existing `users` table.

    ADD COLUMN is an O(1) metadata change in SQLite — it does not rewrite the
    table. Idempotent: a fresh database already has the columns from create_all,
    and PRAGMA table_info makes this a no-op there.
    """
    with engine.begin() as conn:
        if not conn.exec_driver_sql(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'"
        ).first():
            return  # fresh database; create_all built it with the columns

        # PRAGMA table_info returns (cid, name, type, notnull, dflt_value, pk)
        existing = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(users)")}
        for name, ddl in _USER_COLUMNS:
            if name in existing:
                continue
            # `name` and `ddl` are module constants, never user input.
            # Identifiers cannot be bound parameters, so interpolation is the
            # only option — and is safe here.
            conn.exec_driver_sql(f"ALTER TABLE users ADD COLUMN {name} {ddl}")
            logger.info("Added column users.%s.", name)


def _promote_default_admin() -> None:
    """Make settings.DEFAULT_USERNAME an administrator, once.

    Runs for existing databases, where the account was created before is_admin
    existed and would otherwise be left with no way to reach the admin pages.
    Idempotent — the WHERE clause matches nothing on the second run.
    """
    with engine.begin() as conn:
        if not conn.exec_driver_sql(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'"
        ).first():
            return

        result = conn.exec_driver_sql(
            "UPDATE users SET is_admin = 1 WHERE username = ? AND is_admin = 0",
            (settings.DEFAULT_USERNAME,),
        )
        if result.rowcount:
            logger.info("Marked %r as administrator.", settings.DEFAULT_USERNAME)


def seed_default_user() -> None:
    """Create the default account once, so a fresh database is reachable.

    Never touches an account that already exists — a password changed later is
    not reset by a restart. This account is the sole administrator; see
    _promote_default_admin for how existing databases acquire that flag.
    """
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
