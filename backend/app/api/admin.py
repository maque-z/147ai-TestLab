"""Account administration.

A separate module from auth.py rather than five more routes appended to it:
auth.py already carries login, throttling and registration, and the two files
have different audiences — everything here is behind get_current_admin.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ..core.database import get_db
from ..core.deps import get_current_admin
from ..crud import user as user_crud
from ..models.user import User
from ..schemas.user import PasswordReset, UserOut, UserStatusUpdate

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/admin", tags=["admin"])


def _target(db: Session, user_id: int) -> User:
    user = user_crud.get_user_by_id(db, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="账号不存在")
    return user


@router.get("/users", response_model=list[UserOut])
def list_users(db: Session = Depends(get_db), _admin=Depends(get_current_admin)):
    return user_crud.list_users(db)


@router.patch("/users/{user_id}", response_model=UserOut)
def set_active(
    user_id: int,
    body: UserStatusUpdate,
    db: Session = Depends(get_db),
    admin=Depends(get_current_admin),
):
    user = _target(db, user_id)
    # The lockout guard: there is no endpoint that grants is_admin, so an admin
    # who disables their own account cannot be re-enabled by anyone.
    if user.id == admin.id and not body.is_active:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="不能禁用自己"
        )
    logger.info(
        "Admin %r set is_active=%s on %r", admin.username, body.is_active, user.username
    )
    return user_crud.set_user_active(db, user, body.is_active)


@router.post("/users/{user_id}/password", response_model=UserOut)
def reset_password(
    user_id: int,
    body: PasswordReset,
    db: Session = Depends(get_db),
    admin=Depends(get_current_admin),
):
    """Set a new password for an account. The user's existing sessions end
    immediately — see crud.reset_password."""
    user = _target(db, user_id)
    logger.info("Admin %r reset the password for %r", admin.username, user.username)
    return user_crud.reset_password(db, user, body.password)


@router.delete("/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_user(
    user_id: int,
    db: Session = Depends(get_db),
    admin=Depends(get_current_admin),
):
    user = _target(db, user_id)
    if user.id == admin.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="不能删除自己"
        )
    # Unreachable today, and kept deliberately. To get here you must be an admin
    # (get_current_admin), the target must be an admin, and the target cannot be
    # you (guarded above) — which means at least two admins exist and the count
    # is never <= 1. It is the guard that still holds if either of those premises
    # is relaxed later: an endpoint that grants or revokes is_admin, or a change
    # to the self-delete rule. Cheap, and it fails closed.
    if user.is_admin and user_crud.count_admins(db) <= 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="不能删除最后一个管理员"
        )
    logger.info("Admin %r deleted account %r", admin.username, user.username)
    user_crud.delete_user(db, user)
