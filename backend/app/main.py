import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api import auth, image_gen
from .core.bootstrap import seed_default_user
from .core.config import settings
from .core.database import Base, engine

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
)

# Models are registered on Base.metadata by the router imports above, so this
# sees every table. Must run before seeding, which writes to `users`.
Base.metadata.create_all(bind=engine)

# Registration is closed, so without this a fresh database would have no way in.
# Idempotent: an existing account is never touched.
seed_default_user()

app = FastAPI(title="147ai TestLab", version="1.0.0")

# Only these browser origins may call the API. Previously "*", which let any page
# on the internet drive this API with a token it managed to read out of
# localStorage — the token is the only thing guarding it, and localStorage is
# reachable from any script running on the page.
#
# Both documented deployments are same-origin (nginx serves dist/ and proxies
# /api/; `vite dev` proxies /api to :8000), so neither actually needs an entry
# here. The defaults cover hitting the backend port directly during development.
#
# allow_credentials stays False: auth is a Bearer header, not a cookie, so the
# browser never needs permission to attach credentials cross-origin. Flip it only
# if this ever moves to cookie sessions — and note "*" plus credentials is a
# combination browsers reject outright.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router, prefix="/api/v1")
app.include_router(image_gen.router, prefix="/api/v1")

logging.getLogger(__name__).info(
    "CORS allows %d origin(s): %s",
    len(settings.cors_origin_list), ", ".join(settings.cors_origin_list) or "(none)",
)


@app.get("/api/v1/health")
def health():
    return {"status": "ok"}
