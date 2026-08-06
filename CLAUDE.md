# 147ai TestLab

**Stack**: FastAPI + Python 3.11 / Vue 3 + Vite + Naive UI / SQLite / anime.js v4

用途：对照测试 gpt-image 系列 API。把参数矩阵展开成并发请求，逐项对比「请求值 → 实际值」，
暴露 API 与文档不符或网关偷换模型的情况。所以**呈现请求与实际的差异是核心，不是附属功能**。

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
    utils/motion.ts# 所有动效的唯一出口 (anime.js v4)
    assets/styles/ # variables.css, global.css
  vite.config.ts
nginx/
  local.conf          # Nginx config for local Docker
  baota-snippet.conf  # 宝塔 Nginx 反向代理配置片段
scripts/
  deploy.sh           # 服务器部署脚本
  local-start.ps1     # Windows 本地 Docker 一键启动
docs/superpowers/specs/  # 设计文档
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
.\scripts\local-start.ps1        # → http://127.0.0.1:8080

# 手动操作
cd frontend; pnpm build          # dist 是 bind-mount 进 nginx 的，必须先构建
docker compose -f docker-compose.local.yml up -d --build
docker compose -f docker-compose.local.yml down
```

### 本地 Docker 排错

| 改了什么 | 必须做什么 | 不做的后果 |
|---|---|---|
| `backend/app/**` | `up -d --build` | Dockerfile 是 `COPY app/`，不重建跑的还是旧代码 |
| `frontend/src/**` | `pnpm build` | nginx 挂的是 `dist/`，不构建看不到改动 |
| `nginx/*.conf` | `restart nginx` | `up -d --build` 只重建后端，nginx 显示 `Running` 而非 `Recreated`；配置只在启动时读一次 |

```powershell
# 改 nginx 配置后
docker compose -f docker-compose.local.yml restart nginx

# 确认配置真的生效了
docker exec 147ai-testlab-nginx-1 nginx -T | Select-String client_max_body_size
```

- **用 `127.0.0.1:8080`，不要用 `localhost:8080`**：Windows 上 `localhost` 优先解析到 IPv6 `::1`，
  而 Docker 端口映射只监听 IPv4。浏览器会自动回退，curl / Python 脚本不会。
- `openapi.json` 在 `/openapi.json`，不在 `/api/` 下，所以**不走 nginx 反代**。
  查路由用 `docker exec 147ai-testlab-fastapi-1 python -c "import urllib.request;print(urllib.request.urlopen('http://localhost:8000/openapi.json').read())"`
- nginx 的 `client_max_body_size` 默认只有 **1MB**，图片编辑走 multipart 上传必须放开，
  否则一律 413；`proxy_read_timeout` 必须大于后端 timeout，否则长任务被 nginx 先掐断，看到的是 504 而非真实错误。

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

视觉语言：**边框优先，阴影退场**（Linear / Vercel 一路）。层级靠字重、间距和背景微差表达，
不靠光影。阴影只留给真正的浮层（弹窗、抽屉）。数字一律等宽字体，参数对比表才能逐列对齐。

> 2026-08 从 Neumorphism 改为此方案。原方案用同色双向阴影做层级，导致对比度不达标
> （主按钮白字仅 2.90:1、次要文字 2.43:1，均低于 WCAG 4.5:1），且每个盒子都在发光、
> 无法建立重点，不适合本项目这种密集数据界面。

```css
:root {
  /* 表面：近单色 */
  --bg: #FBFBFC;  --surface: #FFFFFF;
  --surface-sunken: #F3F4F6;  --surface-hover: #F7F8F9;
  /* 边框承担原本阴影的职责 */
  --border: #E8EAED;  --border-strong: #D8DBDF;
  /* 文字三级 */
  --text: #16181D;  --text-secondary: #5A6069;  --text-muted: #8B919B;
  /* accent 用于填充，accent-ink 用于淡底上的文字 */
  --accent: #2F6FE0;  --accent-ink: #1F5AC4;  --accent-soft: #EEF3FE;
  --danger: #C7362F;  --success: #1F7F4F;  --warning: #9A5B00;
  --ring: 0 0 0 3px rgba(47,111,224,.20);
  --r-sm: 6px;  --r-md: 8px;  --r-lg: 10px;  --r-xl: 14px;
  --shadow-overlay: 0 12px 32px rgba(16,18,24,.14), 0 2px 8px rgba(16,18,24,.08);
  --sidebar-w: 224px;
}
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-xl); }
.panel { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-lg); }
.sunken { background: var(--surface-sunken); border: 1px solid var(--border); border-radius: var(--r-md); }
.overlay { background: var(--surface); border-radius: var(--r-xl); box-shadow: var(--shadow-overlay); }
:focus-visible { outline: none; box-shadow: var(--ring); }
```

- 字号只用 `11 / 12 / 13 / 14 / 16 / 20`；间距走 4px 网格
- **`--text-muted` 对白底仅 3.17:1**，只能用于 11px 以下辅助信息；正文必须用 `--text` 或 `--text-secondary`
- 淡底（`--accent-soft`）上的文字必须用 `--accent-ink`，用 `--accent` 会掉到 4.22:1
- 不引外部字体：Docker 环境可能无外网，加载失败会造成字体闪烁
- 改动配色后请重新验证对比度，别凭肉眼判断

Naive UI theme override: `primaryColor #2F6FE0`, `bodyColor #FBFBFC`, `cardColor #FFFFFF`, `borderRadius 10px`.

## 动效

所有动效走 `src/utils/motion.ts` 单一出口——时长和缓动只有一处定义，
`prefers-reduced-motion` 也只需要在一个地方处理（这不是可选项，动效会让部分人真的不适）。

- 组件里不要直接 `import { animate } from 'animejs'`，加到 `motion.ts` 里再用
- 单次动效 ≤ 400ms，悬停类 ≤ 150ms，不得阻塞输入
- anime v4 的 `from` 值在第一帧（rAF）才写入，可能晚于浏览器绘制。入场动画要先
  同步 `utils.set` 到初态，否则会先闪一下完成态
- transform 已被响应式状态绑定的元素（如预览图的缩放/平移），只能动 opacity，
  否则动画写入的值会被下一次重渲染覆盖

## API

- Prefix: `/api/v1/`
- Error: `{ "detail": "..." }`
- Auth: JWT Bearer token，`POST /api/v1/auth/login` → `{ access_token, user }`

图像相关两个端点：

| 端点 | 传输 | 说明 |
|---|---|---|
| `POST /image-gen/generate` | JSON | 转发 `/v1/images/generations` |
| `POST /image-gen/edit` | **multipart** | 转发 `/v1/images/edits`，带参考图和蒙版 |

**一次请求 = 一个参数组合。** 前端展开矩阵后并发调用，结果逐个回填。

**未选中的参数一律不发送**，而不是补一个猜测的默认值——只有这样才能测出 API 自己会选什么。
所以 schema 里每个参数都是 Optional，`None` 表示"交给 API 决定"。

### gpt-image-2 的限制（已查官方文档确认）

- **不支持 `background: transparent`**，会直接报错；`opaque` 和 `auto` 等价，所以这个参数已整个移除
- **不接受 `input_fidelity`**，传了返回 400——它强制所有输入图高保真处理
- 每次调用只出 1 张图，要 N 张就发 N 个并发请求
- 编辑端点：参考图最多 16 张（单张 `image`，多张 `image[]`），每张 < 50MB
- **蒙版必须是 PNG + 带 alpha 通道，且与第 1 张图逐像素等尺寸**，差 1 像素就 400。
  alpha=0 的区域才是要重绘的。蒙版只作用于第 1 张图
- 蒙版是软引导，模型不保证精确遵循形状——所以卡片上蒙版只显示"请求"值

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

两份 nginx 配置里有两个不能删的设置：`client_max_body_size 128m`（默认只有 1MB，
图像编辑的 multipart 上传会直接 413）和 `proxy_read_timeout 600s`（必须大于后端
timeout，否则 nginx 先断，看到的是 504 而不是真实错误）。

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
frontend/*.tsbuildinfo
.env
```

## Rules

### Rule 1: Environment — Windows

The development environment is Windows. Use Windows-compatible paths and commands where applicable.

### Rule 2: No Unsolicited Tests or Docs

Do not write test scripts or project documentation (`.md` files) unless the user explicitly requests them.
