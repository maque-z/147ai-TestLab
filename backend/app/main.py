from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from .core.database import Base, engine
from .api import auth, image_gen

# Create all DB tables on startup
Base.metadata.create_all(bind=engine)

app = FastAPI(title="147ai TestLab", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router, prefix="/api/v1")
app.include_router(image_gen.router, prefix="/api/v1")


@app.get("/api/v1/health")
def health():
    return {"status": "ok"}
