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
  Dockerfile
frontend/
  src/
    api/           # all HTTP calls live here; components never use axios directly
    stores/        # Pinia (persisted via pinia-plugin-persistedstate)
    views/         # pages
    components/    # reusable (layout/, imageGen/)
    router/        # Vue Router
    types/         # TS types matching OpenAPI schema
    assets/styles/ # variables.css, global.css
  vite.config.ts
nginx/
  local.conf          # Nginx config for local Docker
  baota-snippet.conf  # 宝塔 Nginx 反向代理配置片段
scripts/
  deploy.sh           # 服务器部署脚本
  local-start.ps1     # Windows 本地 Docker 一键启动
docker-compose.yml        # 生产 (宝塔): 只启动 FastAPI
docker-compose.local.yml  # 本地测试: FastAPI + Nginx → http://localhost:8080
.env.example              # 根目录 SECRET_KEY 模板
```

## Dev commands

```powershell
# backend 直接运行
cd backend; .venv\Scripts\Activate.ps1
uvicorn app.main:app --reload --port 8000

# frontend 直接运行
cd frontend; pnpm dev

# 本地 Docker 一键启动 (构建前端 + 启动容器)
.\scripts\local-start.ps1        # → http://localhost:8080

# 手动操作
cd frontend; pnpm build
docker-compose -f docker-compose.local.yml up -d --build
docker-compose -f docker-compose.local.yml down
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
  --bg:           #E8EDF2;
  --shadow-dark:  #c8cdd4;
  --shadow-light: #ffffff;
  --accent:       #6C9BD1;
  --accent-hover: #5a89bf;
  --text-primary: #3a4a5c;
  --text-muted:   #8a9ab0;
  --radius-card:  16px;
  --radius-input: 10px;
  --sidebar-w:    220px;
}
.nm-raised { box-shadow: 6px 6px 12px var(--shadow-dark), -6px -6px 12px var(--shadow-light); }
.nm-inset  { box-shadow: inset 4px 4px 8px var(--shadow-dark), inset -4px -4px 8px var(--shadow-light); }
.nm-btn    { box-shadow: 4px 4px 8px var(--shadow-dark), -4px -4px 8px var(--shadow-light); }
```

Naive UI theme override: `primaryColor #6C9BD1`, `bodyColor/cardColor #E8EDF2`, `borderRadius 12px`.

## API

- Prefix: `/api/v1/`
- Error: `{ "detail": "..." }`
- Auth: JWT Bearer token，`POST /api/v1/auth/login` → `{ access_token, user }`
- Pagination: `?page=1&page_size=20` → `{ total, page, page_size, items }`

## Docker

两套 compose，按场景选择：

`docker-compose.yml` — **生产/宝塔**，只启动 FastAPI：
```yaml
services:
  fastapi:
    build: ./backend
    ports: ["127.0.0.1:8000:8000"]   # 只绑 localhost，宝塔 Nginx 反代
    environment:
      - DATABASE_URL=sqlite:////app/data/lab.db
      - SECRET_KEY=${SECRET_KEY}      # 读取根目录 .env
    volumes: [db-data:/app/data]
volumes:
  db-data:
```

`docker-compose.local.yml` — **本地测试**，FastAPI + Nginx：
```yaml
# FastAPI 同上，Nginx 额外挂载 frontend/dist + nginx/local.conf
# nginx 监听 :8080，代理 /api/ → fastapi:8000
```

**宝塔部署流程：**
1. `bash scripts/deploy.sh`（拉代码 → 构建前端 → 重启容器）
2. 宝塔 → 网站根目录指向 `frontend/dist`，伪静态选 vue
3. 反向代理 `/api/` → `http://127.0.0.1:8000`（详见 `nginx/baota-snippet.conf`）
4. 申请 SSL 证书

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

## .gitignore

```
backend/.venv/  backend/data/  backend/.env  backend/**/__pycache__/
frontend/node_modules/  frontend/dist/  frontend/.env*.local  frontend/.env
.env
```

## Rules

### Rule 1: Environment — Windows

The development environment is Windows. Use Windows-compatible paths and commands where applicable.

### Rule 2: No Unsolicited Tests or Docs

Do not write test scripts or project documentation (`.md` files) unless the user explicitly requests them.
