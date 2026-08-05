# 147ai TestLab

**Stack**: FastAPI + Python 3.11 / Vue 3 + Vite + Naive UI / SQLite / Neumorphism light

## Structure

```
backend/
  app/
    main.py        # entry
    api/           # routers (one file per domain)
    models/        # SQLAlchemy ORM
    schemas/       # Pydantic v2
    crud/          # DB access (api/ never touches models/ directly)
    core/          # config, db session, deps
  data/lab.db
  requirements.txt
frontend/
  src/
    api/           # all HTTP calls live here; components never use axios directly
    stores/        # Pinia
    views/         # pages
    components/    # reusable
    composables/   # useXxx
    types/         # TS types matching OpenAPI schema
    assets/styles/ # variables.css, global
  vite.config.ts
docker-compose.yml
Caddyfile
```

## Dev commands

```powershell
# backend
cd backend; .venv\Scripts\Activate.ps1
uvicorn app.main:app --reload --port 8000

# frontend
cd frontend; pnpm dev
pnpm build
```

## Layer rules (coupling)

```
api/ → crud/ → models/          # backend: no skipping layers
component → store → src/api/    # frontend: no raw axios in components
```

- Config: all via `.env` / `import.meta.env.VITE_*`, zero hardcoded URLs
- Contract: FastAPI `/openapi.json` is the only frontend↔backend interface

## SQLite

```python
# core/database.py — run at connect
PRAGMA journal_mode=WAL
PRAGMA foreign_keys=ON
```

## Design tokens

```css
:root {
  --bg:          #E8EDF2;
  --shadow-dark: #c8cdd4;
  --shadow-light:#ffffff;
  --accent:      #6C9BD1;
  --radius-card: 16px;
  --radius-input:10px;
}
.nm-raised { box-shadow: 6px 6px 12px var(--shadow-dark), -6px -6px 12px var(--shadow-light); }
.nm-inset  { box-shadow: inset 4px 4px 8px var(--shadow-dark), inset -4px -4px 8px var(--shadow-light); }
```

Naive UI theme override: `primaryColor #6C9BD1`, `bodyColor/cardColor #E8EDF2`, `borderRadius 12px`.

## API

- Prefix: `/api/v1/`
- Error: `{ "detail": "..." }`
- Pagination: `?page=1&page_size=20` → `{ total, page, page_size, items }`

## Docker

`docker-compose.yml`:
```yaml
services:
  fastapi:
    build: ./backend
    restart: unless-stopped
    environment:
      - DATABASE_URL=sqlite:////app/data/lab.db
      - SECRET_KEY=${SECRET_KEY}
    volumes:
      - db-data:/app/data
    expose: ["8000"]

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./frontend/dist:/srv:ro
      - caddy-data:/data
    depends_on: [fastapi]

volumes:
  db-data:
  caddy-data:
```

`Caddyfile`:
```
yourdomain.com {
    handle /api/* { reverse_proxy fastapi:8000 }
    handle { root * /srv; try_files {path} /index.html; file_server }
    encode gzip
}
```

`backend/Dockerfile`:
```dockerfile
FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app/ ./app/
RUN mkdir -p /app/data
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

Build frontend locally before deploy: `pnpm build` → `dist/` mounted by Caddy.

## .gitignore additions

```
backend/.venv/ backend/data/ backend/.env backend/**/__pycache__/
frontend/node_modules/ frontend/dist/ frontend/.env*.local
```
