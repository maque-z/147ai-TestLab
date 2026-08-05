from datetime import timedelta
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from ..core.database import get_db
from ..core.security import verify_password, create_access_token
from ..core.deps import get_current_user
from ..crud import user as user_crud
from ..schemas.user import LoginRequest, TokenResponse, UserCreate, UserOut
from ..core.config import settings

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=TokenResponse)
def login(body: LoginRequest, db: Session = Depends(get_db)):
    user = user_crud.get_user_by_username(db, body.username)
    if user is None or not verify_password(body.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password"
        )
    token = create_access_token(
        {"sub": user.username},
        expires_delta=timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    )
    return TokenResponse(access_token=token, user=UserOut.model_validate(user))


@router.post("/register", response_model=TokenResponse)
def register(body: UserCreate, db: Session = Depends(get_db)):
    existing = user_crud.get_user_by_username(db, body.username)
    if existing:
        raise HTTPException(status_code=400, detail="Username already taken")
    user = user_crud.create_user(db, body)
    token = create_access_token({"sub": user.username})
    return TokenResponse(access_token=token, user=UserOut.model_validate(user))


@router.get("/me", response_model=UserOut)
def get_me(current_user=Depends(get_current_user)):
    return current_user
