# 开放注册与账号管理 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 开放用户自助注册，并给管理员一套查看 / 禁用 / 重置密码 / 删除账号的能力。

**Architecture:** `users` 表增加 `is_admin` / `is_active` / `password_changed_at` 三列，由 `bootstrap.ensure_schema()` 用 `ALTER TABLE ADD COLUMN` 在线补到既有 SQLite 库。JWT 增加 `iat` 声明，`get_current_user` 比对 `iat` 与 `password_changed_at` 实现"禁用与改密即时踢人"，无需引入服务端 session 存储。管理端点独立成 `api/admin.py`，架在新的 `get_current_admin` 依赖上。

**Tech Stack:** FastAPI 0.115 / SQLAlchemy 2.0 / Pydantic 2.9 / python-jose 3.3 / bcrypt 4.2 / SQLite；前端 Vue 3.5 + naive-ui 2.39 + Pinia。

**Spec:** `docs/superpowers/specs/2026-08-20-open-registration-and-user-admin-design.md`

## Global Constraints

- **不新增测试框架，不写测试脚本。** 本仓库 `backend/requirements.txt` 无 pytest，无 `tests/` 目录，且使用者的全局规则禁止未经请求编写测试脚本。因此本计划中每个任务的验证步骤是**可执行的 curl 命令 + 预期输出**，跑在本地 Docker 栈上。验证仍是硬性的：没有贴出实际输出，任务不算完成。
- **数据库是 SQLite，且已有生产数据。** 任何 schema 变更必须走 `ALTER TABLE ADD COLUMN` 且幂等，禁止 `DROP` / 重建表。
- **密码哈希沿用现有 bcrypt**（`core/security.py`，cost=12）。不引入 argon2、不改 cost、不重新哈希既有密码。
- **`UserCreate` 不得添加字段约束** —— `bootstrap.seed_default_user` 用它构造种子账号，加约束会让 `DEFAULT_PASSWORD` 偏短的全新部署在启动时崩溃。约束只加在新的 `UserRegister` / `PasswordReset` 上。
- **密码边界：** 最短 8 字符，最长 **72 字节**（UTF-8 编码后计算，非字符数）。
- **用户名边界：** 去首尾空白后 3–50 字符。
- **`is_admin` 不开放任何写接口。** 仅由 `bootstrap` 授予 `settings.DEFAULT_USERNAME`。
- **中文错误文案**，与 `auth.py` 现有风格一致。

### 本地验证环境（每个任务的验证步骤都假定它已就绪）

```bash
# PowerShell，项目根目录
.\scripts\local-start.ps1
```

启动后：前端 `http://127.0.0.1:8080`，API 根 `http://127.0.0.1:8080/api/v1`。

后续所有 curl 示例用 Git Bash 执行，并假定：

```bash
BASE=http://127.0.0.1:8080/api/v1
```

改完后端代码后必须重建容器才生效（`backend/Dockerfile` 是 `COPY app/`，不是 bind-mount）：

```bash
docker compose -f docker-compose.local.yml up -d --build fastapi
```

---

## File Structure

**后端**

| 文件 | 职责 |
|---|---|
| `backend/app/models/user.py` | 修改：`User` 增加三列 |
| `backend/app/core/bootstrap.py` | 修改：列回填 `_ensure_user_columns`、管理员标记 `_promote_default_admin` |
| `backend/app/core/security.py` | 修改：`create_access_token` 写入 `iat` |
| `backend/app/core/deps.py` | 修改：`get_current_user` 增加两项校验；新增 `get_current_admin` |
| `backend/app/core/config.py` | 修改：新增 `ALLOW_REGISTRATION` |
| `backend/app/schemas/user.py` | 修改：新增 `UserRegister` / `PasswordReset` / `UserStatusUpdate`，`UserOut` 增列 |
| `backend/app/crud/user.py` | 修改：`UsernameTaken` 异常、`create_user` 接住冲突、四个管理操作 |
| `backend/app/api/auth.py` | 修改：实现 `register`；`login` 增加 `is_active` 拦截 |
| `backend/app/api/admin.py` | **新建**：四个管理端点 |
| `backend/app/main.py` | 修改：注册 admin 路由 |

**前端**

| 文件 | 职责 |
|---|---|
| `frontend/src/types/index.ts` | 修改：`User` 增加 `is_admin` / `is_active` |
| `frontend/src/api/admin.ts` | **新建**：四个管理接口的 axios 封装 |
| `frontend/src/views/AdminUsersView.vue` | **新建**：账号管理表格页 |
| `frontend/src/router/index.ts` | 修改：新增 `/admin/users` 路由 |
| `frontend/src/components/layout/SideNav.vue` | 修改：管理员可见的导航项 |
| `frontend/src/components/layout/AppLayout.vue` | 修改：`titleMap` 增加条目、透传 `is_admin` |
| `frontend/src/views/LoginView.vue` | 修改：注册的密码规则前端校验 |

---

## Task 1: 数据模型三列与在线回填

**Files:**
- Modify: `backend/app/models/user.py:20-26`
- Modify: `backend/app/core/bootstrap.py`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces: `User.is_admin: bool`、`User.is_active: bool`、`User.password_changed_at: datetime`（naive UTC）；`bootstrap.ensure_schema()` 保证既有库也具备这三列，且 `settings.DEFAULT_USERNAME` 的 `is_admin` 为真。

- [ ] **Step 1: 给 `User` 加三列**

`backend/app/models/user.py` —— 修改 import 行加入 `Boolean`：

```python
from sqlalchemy import Boolean, Column, DateTime, Integer, String
```

`User` 类改为：

```python
class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(50), unique=True, index=True, nullable=False)
    hashed_password = Column(String(255), nullable=False)
    created_at = Column(DateTime, default=utcnow)

    # Rows that predate these three columns are backfilled by
    # bootstrap._ensure_user_columns(). create_all never alters an existing
    # table, so without that backfill these would apply to fresh databases only.
    is_admin = Column(Boolean, nullable=False, default=False)
    is_active = Column(Boolean, nullable=False, default=True)
    # The anchor that makes a stateless JWT revocable: deps.get_current_user
    # rejects any token issued before this moment. Reset on password change.
    password_changed_at = Column(DateTime, nullable=False, default=utcnow)
```

- [ ] **Step 2: 在 `bootstrap.py` 写列回填**

在 `backend/app/core/bootstrap.py` 的 `_ensure_unique_user_id` 之后追加。注意 `_EPOCH` 的字符串格式与 SQLAlchemy SQLite DATETIME 的存储格式一致（`YYYY-MM-DD HH:MM:SS.ffffff`），使读回时能被解析：

```python
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
```

- [ ] **Step 3: 把两个新函数挂进 `ensure_schema()`**

顺序是有意义的：`_promote_default_admin` 会写 `is_admin`，必须在列存在之后运行。

```python
def ensure_schema() -> None:
    """Backfill schema changes that create_all cannot apply to existing tables.

    create_all only creates missing tables; it never alters one that already
    exists. Everything here is idempotent and safe to run on every boot.
    """
    for table in ("user_image_configs", "user_banana_configs"):
        _ensure_unique_user_id(table)

    # Order matters: _promote_default_admin writes is_admin, so the column has
    # to exist first.
    _ensure_user_columns()
    _promote_default_admin()
```

- [ ] **Step 4: 让全新库的种子账号直接是管理员**

`seed_default_user()` 中的 `create_user` 调用改为传入 `is_admin=True`（该参数在 Task 4 加上；本步骤先改调用点会导致启动失败，所以**本步骤只改注释、不改调用**，实际传参在 Task 4 Step 3 完成）。

本步骤只需把 `seed_default_user` 的 docstring 第一句改掉——它现在写着"Registration is closed"，注册开放后这句话是错的：

```python
def seed_default_user() -> None:
    """Create the default account once, so a fresh database is reachable.

    Never touches an account that already exists — a password changed later is
    not reset by a restart. This account is the sole administrator; see
    _promote_default_admin for how existing databases acquire that flag.
    """
```

同时把 `bootstrap.py` 模块顶部 docstring 的 "Registration is closed, so a fresh database with no users would be unreachable." 改为 "A fresh database has no users, and the first administrator cannot be created by self-registration — is_admin has no write endpoint."

- [ ] **Step 5: 重建容器并验证列已补上**

```bash
docker compose -f docker-compose.local.yml up -d --build fastapi
docker compose -f docker-compose.local.yml exec fastapi \
  python -c "
import sqlite3
c = sqlite3.connect('/app/data/lab.db')
print([r[1] for r in c.execute('PRAGMA table_info(users)')])
print(list(c.execute('SELECT username, is_admin, is_active, password_changed_at FROM users')))
"
```

Expected：第一行包含 `is_admin`、`is_active`、`password_changed_at`；第二行显示 `147ai` 的 `is_admin` 为 `1`，`is_active` 为 `1`，`password_changed_at` 为 `1970-01-01 00:00:00.000000`。

- [ ] **Step 6: 验证回填是幂等的**

再重启一次，确认没有重复 ALTER 报错、且日志里不再出现 `Added column`：

```bash
docker compose -f docker-compose.local.yml restart fastapi
docker compose -f docker-compose.local.yml logs --tail 30 fastapi | grep -iE "Added column|administrator|Traceback|Error"
```

Expected：无 `Traceback`，无 `Added column`（列已存在），无 `Marked ... as administrator`（已是管理员）。

- [ ] **Step 7: Commit**

```bash
git add backend/app/models/user.py backend/app/core/bootstrap.py
git commit -m "feat(auth): users 表增加 is_admin/is_active/password_changed_at 三列与在线回填"
```

---

## Task 2: JWT 增加 iat，并在 deps 中实现禁用与改密踢人

**Files:**
- Modify: `backend/app/core/security.py:29-39`
- Modify: `backend/app/core/deps.py:31-68`

**Interfaces:**
- Consumes: Task 1 的 `User.is_active`、`User.password_changed_at`
- Produces: `create_access_token` 产出的 token 含整数 `iat`；`get_current_user` 对被禁用账号与过期会话抛 401；新增 `get_current_admin(current_user=Depends(get_current_user))`，非管理员抛 403。

- [ ] **Step 1: `create_access_token` 写入 `iat`**

`backend/app/core/security.py`，替换整个函数：

```python
def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    # timezone-aware: datetime.utcnow() is deprecated in 3.12 and produces a
    # naive value that python-jose encodes against a different reference.
    now = datetime.now(timezone.utc)
    # `iat` is what makes these tokens revocable. deps.get_current_user compares
    # it against the account's password_changed_at, so a password reset (or any
    # future event that bumps that column) invalidates every token minted before
    # it — without the server having to store a single session.
    #
    # python-jose converts a datetime in `iat`/`exp`/`nbf` via
    # timegm(value.utctimetuple()), which drops sub-second precision. The claim
    # therefore lands as whole seconds; deps compensates. See RFC 7519 §4.1.6.
    to_encode["iat"] = now
    to_encode["exp"] = now + (
        expires_delta or timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    )
    to_encode.setdefault("type", "access")
    return jwt.encode(to_encode, settings.SECRET_KEY, algorithm=settings.ALGORITHM)
```

- [ ] **Step 2: 确认 `iat` 真的是整秒**

这一步是为了证实上面注释里对 python-jose 行为的断言，而不是假设它。

```bash
docker compose -f docker-compose.local.yml exec fastapi python -c "
from datetime import datetime, timezone
from jose import jwt
t = jwt.encode({'sub':'x','iat':datetime.now(timezone.utc)}, 'k', algorithm='HS256')
c = jwt.decode(t, 'k', algorithms=['HS256'])
print('iat =', repr(c['iat']), type(c['iat']).__name__)
"
```

Expected：`iat = 1755...` 且类型是 `int`（不是 float、不是字符串）。若不是整数，Step 4 的比较逻辑需要改用 `float`；先拿到这个输出再继续。

- [ ] **Step 3: 在 `deps.py` 顶部补 import**

```python
from datetime import timezone
```

- [ ] **Step 4: `get_current_user` 增加两项校验**

在 `backend/app/core/deps.py` 中，把 `get_current_user` 末尾的

```python
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found"
        )

    return user
```

替换为：

```python
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found"
        )

    # Both checks below reuse the row already fetched above — no extra round trip.
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="账号已被禁用",
        )

    if _issued_before_password_change(payload.get("iat"), user.password_changed_at):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="密码已变更，请重新登录",
        )

    return user
```

- [ ] **Step 5: 写比较函数，处理一秒粒度陷阱**

放在 `get_current_user` 之前（模块级私有函数）：

```python
def _issued_before_password_change(iat, password_changed_at) -> bool:
    """True when this token predates the account's last password change.

    The one-second trap this exists to avoid: `iat` is whole seconds by RFC 7519,
    while password_changed_at is a microsecond-precision datetime. An admin who
    resets a password at 10:00:00.500 and a user who logs in at 10:00:00.700 would
    otherwise produce a token whose iat (10:00:00) is *below* the stored value —
    the token would be rejected the instant it was issued, and the account would
    look permanently unable to log in.

    Flooring the stored value to the same whole second removes that. The cost is
    that a token minted earlier in the same second as the reset survives one extra
    check; that window is meaningless, whereas "user can never log in" is a real
    outage.

    A token with no `iat` at all predates this feature entirely, so it is treated
    as too old — those tokens are already invalid for other reasons after the
    upgrade, and refusing them costs one re-login.
    """
    if password_changed_at is None:
        return False
    if iat is None:
        return True

    # Stored naive: SQLite drops the offset on write, so what comes back is a
    # naive value that is already UTC. Rows written by the ORM default before a
    # refresh can still be aware, so normalise rather than assume.
    changed = password_changed_at
    if changed.tzinfo is None:
        changed = changed.replace(tzinfo=timezone.utc)

    return int(iat) < int(changed.timestamp())
```

- [ ] **Step 6: 新增 `get_current_admin`**

放在 `get_current_user` 之后：

```python
def get_current_admin(current_user=Depends(get_current_user)):
    """The authenticated user, refused unless they are an administrator.

    Layered on get_current_user rather than repeating the lookup: that dependency
    already fetched the row with every column loaded, so reading is_admin here
    costs nothing. It is also the single place where is_active and token age are
    enforced, and admin routes must not bypass either.
    """
    if not current_user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="需要管理员权限",
        )
    return current_user
```

- [ ] **Step 7: 重建并验证既有会话未被升级踢掉**

这是 Task 1 Step 2 里 `_EPOCH` 那段注释的实证。

```bash
docker compose -f docker-compose.local.yml up -d --build fastapi

# 用你的实际密码替换 YOURPASS
TOKEN=$(curl -s -X POST $BASE/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"147ai","password":"YOURPASS"}' | python -c "import sys,json;print(json.load(sys.stdin)['access_token'])")
echo "token acquired: ${TOKEN:0:20}..."

curl -s -o /dev/null -w "GET /auth/me -> %{http_code}\n" \
  -H "Authorization: Bearer $TOKEN" $BASE/auth/me
```

Expected：`GET /auth/me -> 200`。若是 401，说明 `_EPOCH` 回填没生效或比较方向写反了 —— 停下来排查，不要继续。

- [ ] **Step 8: 验证 token 里确实带上了 iat**

```bash
python -c "
import base64, json, sys
p = '$TOKEN'.split('.')[1]
p += '=' * (-len(p) % 4)
print(json.loads(base64.urlsafe_b64decode(p)))
"
```

Expected：输出的 dict 同时含 `iat` 与 `exp`，且 `iat` 是整数。

- [ ] **Step 9: Commit**

```bash
git add backend/app/core/security.py backend/app/core/deps.py
git commit -m "feat(auth): token 增加 iat，get_current_user 校验禁用状态与改密时间"
```

---

## Task 3: 密码与用户名的校验 schema

**Files:**
- Modify: `backend/app/schemas/user.py`

**Interfaces:**
- Consumes: 无
- Produces: `UserRegister(username: str, password: str)`、`PasswordReset(password: str)`、`UserStatusUpdate(is_active: bool)`；`UserOut` 增加 `is_admin: bool` 与 `is_active: bool`。常量 `USERNAME_MIN=3`、`USERNAME_MAX=50`、`PASSWORD_MIN_CHARS=8`、`PASSWORD_MAX_BYTES=72`。

- [ ] **Step 1: 重写 `backend/app/schemas/user.py`**

```python
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field, field_validator

# 50 matches the String(50) width on models.User.username. SQLite does not
# enforce VARCHAR lengths, so without this a longer name is stored intact and
# only becomes a problem on some other database.
USERNAME_MIN, USERNAME_MAX = 3, 50

PASSWORD_MIN_CHARS = 8

# bcrypt's hard limit, and the reason this is counted in *bytes* rather than
# characters: one Chinese character is 3 bytes in UTF-8, so this is roughly 24
# of them. bcrypt does not reject a longer password — it silently truncates at
# 72 bytes, which was confirmed directly: the hash of 72 'A' characters verifies
# against 100 'A' characters. Left unchecked, a user setting a long passphrase
# would believe the tail protects them when it never reached the hash at all.
PASSWORD_MAX_BYTES = 72


class UserCreate(BaseModel):
    """The shape, without bounds.

    Deliberately unconstrained. bootstrap.seed_default_user builds one of these
    from settings.DEFAULT_PASSWORD, and a short value in .env would then crash a
    brand-new deployment at startup rather than merely being a weak password.
    Bounds are for what a client sends, so they live on UserRegister — the same
    split schemas/image_config.py already uses for ImageConfigBase/Update.
    """

    username: str
    password: str


class _PasswordPolicy(BaseModel):
    """The password rules, written once and inherited by everything that accepts
    a client-supplied password."""

    password: str = Field(min_length=PASSWORD_MIN_CHARS)

    @field_validator("password")
    @classmethod
    def _within_bcrypt_limit(cls, v: str) -> str:
        if len(v.encode("utf-8")) > PASSWORD_MAX_BYTES:
            raise ValueError(
                f"密码不能超过 {PASSWORD_MAX_BYTES} 字节（约 24 个汉字）"
            )
        return v


class UserRegister(_PasswordPolicy):
    """What a self-registering client may send."""

    username: str = Field(min_length=USERNAME_MIN, max_length=USERNAME_MAX)

    @field_validator("username", mode="before")
    @classmethod
    def _strip(cls, v):
        # mode="before" so the length bounds above measure the trimmed value —
        # otherwise "  ab  " would pass a 3-character minimum on whitespace.
        return v.strip() if isinstance(v, str) else v


class PasswordReset(_PasswordPolicy):
    """Body of the admin password-reset endpoint. Same rules as registration:
    an admin-set password is not exempt from the bcrypt truncation boundary."""


class UserStatusUpdate(BaseModel):
    is_active: bool


class UserOut(BaseModel):
    id: int
    username: str
    created_at: datetime
    # Defaulted rather than required: a row from a partially-migrated database
    # would otherwise turn a plain GET into a 500 during response validation.
    # Same reasoning as the ImageConfigBase docstring.
    is_admin: bool = False
    is_active: bool = True

    model_config = {"from_attributes": True}


class LoginRequest(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut
```

- [ ] **Step 2: 验证四条边界都按预期拒绝/放行**

```bash
docker compose -f docker-compose.local.yml up -d --build fastapi
docker compose -f docker-compose.local.yml exec fastapi python -c "
from app.schemas.user import UserRegister
cases = [
    ('短密码',      dict(username='alice', password='1234567')),
    ('刚好8位',     dict(username='alice', password='12345678')),
    ('用户名太短',   dict(username='ab',    password='12345678')),
    ('空白填充名',   dict(username='  ab  ', password='12345678')),
    ('73字节密码',  dict(username='alice', password='A'*73)),
    ('72字节密码',  dict(username='alice', password='A'*72)),
    ('25个汉字',    dict(username='alice', password='密'*25)),
]
for label, kw in cases:
    try:
        UserRegister(**kw); print(f'{label:12} -> 通过')
    except Exception as e:
        print(f'{label:12} -> 拒绝')
"
```

Expected 逐行：

```
短密码       -> 拒绝
刚好8位      -> 通过
用户名太短    -> 拒绝
空白填充名    -> 拒绝
73字节密码   -> 拒绝
72字节密码   -> 通过
25个汉字     -> 拒绝
```

「空白填充名 -> 拒绝」是 `mode="before"` 生效的证明；若它显示"通过"，说明 strip 跑在了长度校验之后。

- [ ] **Step 3: Commit**

```bash
git add backend/app/schemas/user.py
git commit -m "feat(auth): 新增 UserRegister/PasswordReset 校验，UserOut 增加 is_admin/is_active"
```

---

## Task 4: CRUD —— 用户名冲突与四个管理操作

**Files:**
- Modify: `backend/app/crud/user.py`
- Modify: `backend/app/core/bootstrap.py`（Task 1 Step 4 留下的传参）

**Interfaces:**
- Consumes: Task 1 的三列、Task 3 的 schema
- Produces: `UsernameTaken(Exception)`；`create_user(db, user_in, *, is_admin=False) -> User`（冲突时抛 `UsernameTaken`）；`list_users(db) -> list[User]`；`set_user_active(db, user, is_active) -> User`；`reset_password(db, user, new_password) -> User`；`delete_user(db, user) -> None`；`count_admins(db) -> int`。

- [ ] **Step 1: 定义异常并改写 `create_user`**

`backend/app/crud/user.py`，在 `ConfigT` 定义之后加入异常类：

```python
class UsernameTaken(Exception):
    """create_user lost the race on UNIQUE(users.username).

    A domain exception rather than letting IntegrityError escape, so the API
    layer does not have to import sqlalchemy.exc to tell "name is taken" apart
    from a genuine database fault.
    """
```

替换 `create_user`：

```python
def create_user(db: Session, user_in: UserCreate, *, is_admin: bool = False) -> User:
    hashed = get_password_hash(user_in.password)
    db_user = User(
        username=user_in.username,
        hashed_password=hashed,
        is_admin=is_admin,
    )
    db.add(db_user)
    try:
        db.commit()
    except IntegrityError:
        # UNIQUE(username). Unreachable while registration was closed — the only
        # caller was the startup seed, which checks first. Open registration makes
        # it reachable by two clients picking the same name at the same moment,
        # and uncaught it surfaces as a 500.
        db.rollback()
        raise UsernameTaken(user_in.username) from None
    db.refresh(db_user)
    return db_user
```

- [ ] **Step 2: 加入四个管理操作**

追加到 `backend/app/crud/user.py` 末尾：

```python
def list_users(db: Session) -> list[User]:
    """Every account, oldest first — registration order is what the admin table
    reads most naturally."""
    return db.query(User).order_by(User.id).all()


def count_admins(db: Session) -> int:
    return db.query(User).filter(User.is_admin.is_(True)).count()


def set_user_active(db: Session, user: User, is_active: bool) -> User:
    """Enable or disable an account.

    Only the flag moves. password_changed_at is deliberately left alone: a
    disabled account is already refused by deps.get_current_user on is_active, and
    bumping the anchor would additionally invalidate the account's tokens forever
    — so re-enabling would not restore the session the admin just interrupted.
    """
    user.is_active = is_active
    db.commit()
    db.refresh(user)
    return user


def reset_password(db: Session, user: User, new_password: str) -> User:
    """Set a new password and end every session that used the old one.

    Moving password_changed_at forward is what makes the reset take effect
    immediately: deps.get_current_user rejects any token issued before it. Without
    this line the old password would stop working while tokens minted with it kept
    working for the rest of their seven days.
    """
    user.hashed_password = get_password_hash(new_password)
    user.password_changed_at = utcnow()
    db.commit()
    db.refresh(user)
    return user


def delete_user(db: Session, user: User) -> None:
    """Delete an account together with both of its config rows.

    The config tables carry no foreign key — user_id is a plain Integer column —
    so nothing cascades on its own, and the rows would be left behind as orphans.
    That is not merely untidy, it leaks credentials: SQLite hands out max(id)+1
    for an INTEGER PRIMARY KEY declared without AUTOINCREMENT, so deleting the
    highest-id account frees that exact id for the next registration. The new
    account would then be matched by _get_or_create_config to the orphaned rows
    and silently inherit the previous owner's baseurl and api_key.

    One transaction: a partial delete is the state that produces the leak.
    """
    db.query(UserImageConfig).filter(UserImageConfig.user_id == user.id).delete()
    db.query(UserBananaConfig).filter(UserBananaConfig.user_id == user.id).delete()
    db.delete(user)
    db.commit()
```

- [ ] **Step 3: 让种子账号成为管理员**

`backend/app/core/bootstrap.py` 的 `seed_default_user` 中，把

```python
        user_crud.create_user(db, UserCreate(
            username=settings.DEFAULT_USERNAME,
            password=settings.DEFAULT_PASSWORD,
        ))
```

改为

```python
        # The sole administrator. is_admin has no write endpoint, so this and
        # _promote_default_admin are the only two ways an account acquires it.
        user_crud.create_user(db, UserCreate(
            username=settings.DEFAULT_USERNAME,
            password=settings.DEFAULT_PASSWORD,
        ), is_admin=True)
```

- [ ] **Step 4: 验证删除会级联清掉配置行**

这是 spec §5.2 的直接实证，也是本计划里优先级最高的正确性检查。

```bash
docker compose -f docker-compose.local.yml up -d --build fastapi
docker compose -f docker-compose.local.yml exec fastapi python -c "
from app.core.database import SessionLocal
from app.crud import user as c
from app.schemas.user import UserCreate
from app.models.user import UserImageConfig

db = SessionLocal()
u = c.create_user(db, UserCreate(username='cascade_probe', password='probe12345'))
uid = u.id
cfg = c.get_image_config(db, uid)
cfg.api_key = 'sk-SHOULD-NOT-SURVIVE'
db.commit()
print('created uid =', uid, 'key =', c.get_image_config(db, uid).api_key)

c.delete_user(db, c.get_user_by_id(db, uid))
left = db.query(UserImageConfig).filter(UserImageConfig.user_id == uid).count()
print('orphan config rows after delete =', left)
db.close()
"
```

Expected：

```
created uid = <N> key = sk-SHOULD-NOT-SURVIVE
orphan config rows after delete = 0
```

`orphan config rows after delete` 必须是 `0`。任何非零值都意味着下一个注册者可能继承这把 key —— 停下来修好再继续。

- [ ] **Step 5: 验证用户名冲突抛的是 `UsernameTaken` 而不是 500**

```bash
docker compose -f docker-compose.local.yml exec fastapi python -c "
from app.core.database import SessionLocal
from app.crud import user as c
from app.schemas.user import UserCreate

db = SessionLocal()
c.create_user(db, UserCreate(username='dup_probe', password='probe12345'))
try:
    c.create_user(db, UserCreate(username='dup_probe', password='probe12345'))
    print('BUG: 第二次创建居然成功了')
except c.UsernameTaken as e:
    print('UsernameTaken 正确抛出:', e)
finally:
    c.delete_user(db, c.get_user_by_username(db, 'dup_probe'))
    db.close()
"
```

Expected：`UsernameTaken 正确抛出: dup_probe`

- [ ] **Step 6: Commit**

```bash
git add backend/app/crud/user.py backend/app/core/bootstrap.py
git commit -m "feat(auth): create_user 接住用户名冲突，新增列表/禁用/改密/级联删除"
```

---

## Task 5: 开放注册端点，并在登录端拦住被禁用账号

**Files:**
- Modify: `backend/app/core/config.py:70-95`
- Modify: `backend/app/api/auth.py`

**Interfaces:**
- Consumes: Task 3 的 `UserRegister`、Task 4 的 `UsernameTaken` 与 `create_user`
- Produces: `POST /api/v1/auth/register` 返回 201 + `TokenResponse`；`POST /api/v1/auth/login` 对被禁用账号返回 403；新配置项 `settings.ALLOW_REGISTRATION`。

- [ ] **Step 1: 新增配置开关**

`backend/app/core/config.py`，在 `DEFAULT_PASSWORD` 之后加入：

```python
    # Self-registration. Open by default, which is the deliberate choice for this
    # deployment: per-user config rows mean a new account starts with an empty
    # api_key and must supply its own, so a registrant spends their own upstream
    # quota rather than the operator's. Set ALLOW_REGISTRATION=false in .env to
    # close it again without a code change.
    ALLOW_REGISTRATION: bool = True
```

- [ ] **Step 2: 改 `auth.py` 的 import**

```python
from ..core.config import settings
from ..core.database import get_db
from ..core.deps import get_current_user
from ..core.security import create_access_token, verify_password
from ..core.throttle import check_rate_limit, clear_attempts, record_attempt
from ..crud import user as user_crud
from ..schemas.user import (
    LoginRequest,
    TokenResponse,
    UserCreate,
    UserOut,
    UserRegister,
)
```

- [ ] **Step 3: 在模块常量区加入注册的限流桶前缀**

紧跟在 `_BAD_CREDENTIALS` 之后：

```python
# Registration counts into its own throttle bucket, not the login one.
#
# throttle._buckets is keyed by an arbitrary string, so a prefix is all that is
# needed. They must stay separate because a successful login calls
# clear_attempts(ip), which pops the whole bucket — sharing it would let
# "register, log in, register, log in" reset the counter after every account and
# defeat the registration limit entirely, at two requests per account.
#
# The trade-off accepted here: registration floods no longer lock out logins from
# the same address. The two surfaces are metered independently, which is correct.
_REGISTER_BUCKET = "register:"
```

- [ ] **Step 4: 登录端加入 `is_active` 拦截**

在 `login` 里，把

```python
    clear_attempts(ip)
    token = create_access_token(
```

替换为

```python
    # Checked here as well as in deps.get_current_user, and on purpose. Without
    # it a disabled account still receives 200 and a freshly minted token — whose
    # `iat` is current, so it clears the password_changed_at check — and only
    # then fails on every subsequent request. That reads as "I can log in but
    # nothing works", which looks like an outage rather than a disabled account.
    #
    # Deliberately not the _BAD_CREDENTIALS message: that wording exists to stop
    # username enumeration, and reaching this line means the caller already
    # supplied the correct username *and* password. Staying vague past that point
    # protects nothing and just makes the user retry.
    if not user.is_active:
        logger.info("Login refused for disabled account %r from %s", user.username, ip)
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="账号已被禁用，请联系管理员",
        )

    clear_attempts(ip)
    token = create_access_token(
```

- [ ] **Step 5: 实现 `register`**

整段替换现有的 `register`：

```python
@router.post("/register", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
def register(body: UserRegister, request: Request, db: Session = Depends(get_db)):
    """Create an account and log it straight in.

    A new account starts with no config row of its own, so it cannot call the
    image endpoints until its owner supplies a baseurl and api_key — nothing here
    grants access to the operator's upstream quota.
    """
    if not settings.ALLOW_REGISTRATION:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="注册已关闭，请联系管理员",
        )

    ip = _client_ip(request)
    bucket = _REGISTER_BUCKET + ip

    allowed, retry_after = check_rate_limit(bucket)
    if not allowed:
        logger.warning("Registration throttled for %s", ip)
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"注册尝试过于频繁，请 {retry_after} 秒后再试",
            headers={"Retry-After": str(retry_after)},
        )

    # Recorded before the attempt resolves, and never cleared on success. Unlike
    # login — where success proves the caller owns the account and clearing is
    # fair — success here *is* the action being limited, so clearing would leave
    # the cap applying only to failed registrations.
    record_attempt(bucket)

    try:
        user = user_crud.create_user(
            db, UserCreate(username=body.username, password=body.password)
        )
    except user_crud.UsernameTaken:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="用户名已被占用",
        )

    token = create_access_token(
        {"sub": user.username},
        expires_delta=timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES),
    )
    logger.info("Registered new account %r from %s", user.username, ip)
    return TokenResponse(access_token=token, user=UserOut.model_validate(user))
```

- [ ] **Step 6: 验证注册可用，且新账号拿不到别人的 key**

这是 spec §1.1「配置隔离」的实证。

```bash
docker compose -f docker-compose.local.yml up -d --build fastapi

curl -s -X POST $BASE/auth/register -H 'Content-Type: application/json' \
  -d '{"username":"probe_alice","password":"alice12345"}' | tee /tmp/reg.json
echo
NEWTOK=$(python -c "import json;print(json.load(open('/tmp/reg.json'))['access_token'])")

echo "--- 新账号看到的配置 ---"
curl -s -H "Authorization: Bearer $NEWTOK" $BASE/image-gen/config
echo
echo "--- 新账号直接点生成 ---"
curl -s -o /dev/null -w "%{http_code}\n" -X POST $BASE/image-gen/generate \
  -H "Authorization: Bearer $NEWTOK" -H 'Content-Type: application/json' \
  -d '{"prompt":"probe"}'
```

Expected：注册返回含 `access_token` 与 `"is_admin":false`；配置里 `"baseurl":""` 且 `"api_key":""`；生成返回 `400`（`请先在配置中填写 API Key`）。**若 `api_key` 非空，立刻停止** —— 那意味着配置隔离被打破了。

- [ ] **Step 7: 验证重名与弱密码被拒**

```bash
curl -s -o /dev/null -w "重名 -> %{http_code}\n" -X POST $BASE/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"probe_alice","password":"alice12345"}'

curl -s -o /dev/null -w "7位密码 -> %{http_code}\n" -X POST $BASE/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"probe_bob","password":"1234567"}'
```

Expected：`重名 -> 400`、`7位密码 -> 422`。

- [ ] **Step 8: 验证注册限流不被登录成功清零**

这是 Step 3 那段注释的实证。默认 `LOGIN_MAX_ATTEMPTS=8`，所以第 8 次应触发锁定；中间穿插的成功登录不应让计数归零。

```bash
docker compose -f docker-compose.local.yml restart fastapi   # 清空进程内限流表
sleep 3
for i in $(seq 1 9); do
  code=$(curl -s -o /dev/null -w "%{http_code}" -X POST $BASE/auth/register \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"probe_r$i\",\"password\":\"probe12345\"}")
  echo "注册 #$i -> $code"
  curl -s -o /dev/null -X POST $BASE/auth/login -H 'Content-Type: application/json' \
    -d "{\"username\":\"probe_r$i\",\"password\":\"probe12345\"}"
done
```

Expected：前若干次 `201`，到第 8 次开始出现 `429` 并持续。**如果 9 次全是 201，说明桶被登录清零了** —— 检查 `_REGISTER_BUCKET` 有没有真的用上。

- [ ] **Step 9: Commit**

```bash
git add backend/app/core/config.py backend/app/api/auth.py
git commit -m "feat(auth): 开放注册端点，登录拦截被禁用账号，注册独立限流桶"
```

---

## Task 6: 管理端点

**Files:**
- Create: `backend/app/api/admin.py`
- Modify: `backend/app/main.py:6`、`backend/app/main.py:51-53`

**Interfaces:**
- Consumes: Task 2 的 `get_current_admin`、Task 3 的 `PasswordReset`/`UserStatusUpdate`/`UserOut`、Task 4 的五个 crud 函数
- Produces: `GET /api/v1/admin/users`、`PATCH /api/v1/admin/users/{user_id}`、`POST /api/v1/admin/users/{user_id}/password`、`DELETE /api/v1/admin/users/{user_id}`

- [ ] **Step 1: 新建 `backend/app/api/admin.py`**

```python
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
    logger.info("Admin %r set is_active=%s on %r", admin.username, body.is_active, user.username)
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
    # Belt and braces next to the self-delete guard above: today the seeded
    # account is the only admin, so the two overlap. They stop overlapping the
    # moment a second admin is set directly in the database, and this is the one
    # that still holds then.
    if user.is_admin and user_crud.count_admins(db) <= 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="不能删除最后一个管理员"
        )
    logger.info("Admin %r deleted account %r", admin.username, user.username)
    user_crud.delete_user(db, user)
```

- [ ] **Step 2: 在 `main.py` 注册路由**

import 行改为：

```python
from .api import admin, auth, banana_gen, image_gen
```

在 `app.include_router(banana_gen.router, prefix="/api/v1")` 之后加入：

```python
app.include_router(admin.router, prefix="/api/v1")
```

- [ ] **Step 3: 验证非管理员被 403 挡住**

```bash
docker compose -f docker-compose.local.yml up -d --build fastapi

# Task 5 里注册的 probe_alice
ALICE=$(curl -s -X POST $BASE/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"probe_alice","password":"alice12345"}' \
  | python -c "import sys,json;print(json.load(sys.stdin)['access_token'])")

curl -s -o /dev/null -w "普通用户查列表 -> %{http_code}\n" \
  -H "Authorization: Bearer $ALICE" $BASE/admin/users
curl -s -o /dev/null -w "无 token 查列表 -> %{http_code}\n" $BASE/admin/users
```

Expected：`普通用户查列表 -> 403`、`无 token 查列表 -> 403`（`HTTPBearer` 缺少凭证时返回 403）。

- [ ] **Step 4: 验证管理员能拿到列表**

```bash
ADMIN=$(curl -s -X POST $BASE/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"147ai","password":"YOURPASS"}' \
  | python -c "import sys,json;print(json.load(sys.stdin)['access_token'])")

curl -s -H "Authorization: Bearer $ADMIN" $BASE/admin/users | python -m json.tool
```

Expected：JSON 数组，`147ai` 那条 `"is_admin": true`，`probe_alice` 那条 `"is_admin": false, "is_active": true`。

- [ ] **Step 5: 验证禁用后旧 token 立即失效（spec §2.1 的实证）**

```bash
ALICE_ID=$(curl -s -H "Authorization: Bearer $ADMIN" $BASE/admin/users \
  | python -c "import sys,json;print([u['id'] for u in json.load(sys.stdin) if u['username']=='probe_alice'][0])")

echo "禁用前:"
curl -s -o /dev/null -w "  alice /auth/me -> %{http_code}\n" -H "Authorization: Bearer $ALICE" $BASE/auth/me

curl -s -o /dev/null -w "禁用请求 -> %{http_code}\n" -X PATCH $BASE/admin/users/$ALICE_ID \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{"is_active":false}'

echo "禁用后（同一枚旧 token）:"
curl -s -o /dev/null -w "  alice /auth/me -> %{http_code}\n" -H "Authorization: Bearer $ALICE" $BASE/auth/me
curl -s -w "  alice 重新登录 -> %{http_code}\n" -o /dev/null -X POST $BASE/auth/login \
  -H 'Content-Type: application/json' -d '{"username":"probe_alice","password":"alice12345"}'
```

Expected：禁用前 `200`；禁用请求 `200`；禁用后旧 token `401`，重新登录 `403`。**旧 token 若仍是 200，说明 `is_active` 校验没进 `get_current_user`。**

- [ ] **Step 6: 验证自我锁死被拦住**

```bash
ADMIN_ID=$(curl -s -H "Authorization: Bearer $ADMIN" $BASE/admin/users \
  | python -c "import sys,json;print([u['id'] for u in json.load(sys.stdin) if u['username']=='147ai'][0])")

curl -s -w "  禁用自己 -> %{http_code} " -o /dev/null -X PATCH $BASE/admin/users/$ADMIN_ID \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{"is_active":false}'
echo
curl -s -w "  删除自己 -> %{http_code}\n" -o /dev/null -X DELETE $BASE/admin/users/$ADMIN_ID \
  -H "Authorization: Bearer $ADMIN"
```

Expected：两行都是 `400`。

- [ ] **Step 7: 验证重置密码会踢掉旧会话，且新密码当场可用（spec §6.2 的一秒陷阱实证）**

```bash
# 先把 alice 启用回来
curl -s -o /dev/null -X PATCH $BASE/admin/users/$ALICE_ID \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{"is_active":true}'

ALICE2=$(curl -s -X POST $BASE/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"probe_alice","password":"alice12345"}' \
  | python -c "import sys,json;print(json.load(sys.stdin)['access_token'])")

# 重置后立刻登录 —— 两个动作落在同一秒内是这一步的重点
curl -s -o /dev/null -X POST $BASE/admin/users/$ALICE_ID/password \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"password":"newpass12345"}'
NEW=$(curl -s -X POST $BASE/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"probe_alice","password":"newpass12345"}' \
  | python -c "import sys,json;print(json.load(sys.stdin)['access_token'])")

curl -s -o /dev/null -w "  旧 token -> %{http_code}\n" -H "Authorization: Bearer $ALICE2" $BASE/auth/me
curl -s -o /dev/null -w "  新 token -> %{http_code}\n" -H "Authorization: Bearer $NEW"    $BASE/auth/me
curl -s -o /dev/null -w "  旧密码登录 -> %{http_code}\n" -X POST $BASE/auth/login \
  -H 'Content-Type: application/json' -d '{"username":"probe_alice","password":"alice12345"}'
```

Expected：`旧 token -> 401`、`新 token -> 200`、`旧密码登录 -> 401`。

**`新 token -> 200` 是这一步真正要证的东西** —— 它证明一秒粒度陷阱已被处理。若是 401，说明 `_issued_before_password_change` 没有把 `password_changed_at` 向下取整到秒。

- [ ] **Step 8: 验证删除后重新注册不会继承孤儿配置（spec §5.2 端到端实证）**

```bash
# 给 alice 填一把可识别的 key
curl -s -o /dev/null -X PUT $BASE/image-gen/config -H "Authorization: Bearer $NEW" \
  -H 'Content-Type: application/json' \
  -d '{"baseurl":"http://host.docker.internal:3000","api_key":"sk-LEAK-CANARY","model_id":"gpt-image-2","timeout":480}'

curl -s -o /dev/null -w "删除 alice -> %{http_code}\n" -X DELETE $BASE/admin/users/$ALICE_ID \
  -H "Authorization: Bearer $ADMIN"

# 重新注册（id 很可能被回收成同一个）
RE=$(curl -s -X POST $BASE/auth/register -H 'Content-Type: application/json' \
  -d '{"username":"probe_carol","password":"carol12345"}' \
  | python -c "import sys,json;print(json.load(sys.stdin)['access_token'])")
echo "carol 看到的配置:"
curl -s -H "Authorization: Bearer $RE" $BASE/image-gen/config
```

Expected：删除返回 `204`；carol 的配置 `"baseurl":""`、`"api_key":""`。**出现 `sk-LEAK-CANARY` 即为 spec §5.2 描述的泄漏成真，必须停下。**

- [ ] **Step 9: 清理探针账号**

```bash
for name in probe_carol $(seq -f "probe_r%g" 1 9); do
  id=$(curl -s -H "Authorization: Bearer $ADMIN" $BASE/admin/users \
    | python -c "import sys,json;m=[u['id'] for u in json.load(sys.stdin) if u['username']=='$name'];print(m[0] if m else '')")
  [ -n "$id" ] && curl -s -o /dev/null -X DELETE $BASE/admin/users/$id -H "Authorization: Bearer $ADMIN" && echo "deleted $name"
done
curl -s -H "Authorization: Bearer $ADMIN" $BASE/admin/users | python -m json.tool
```

Expected：最终列表里只剩 `147ai`。

- [ ] **Step 10: Commit**

```bash
git add backend/app/api/admin.py backend/app/main.py
git commit -m "feat(admin): 新增账号管理端点（列表/禁用/重置密码/删除）"
```

---

## Task 7: 前端类型与 API 封装

**Files:**
- Modify: `frontend/src/types/index.ts:5-9`
- Create: `frontend/src/api/admin.ts`

**Interfaces:**
- Consumes: Task 6 的四个端点
- Produces: `User` 接口增加 `is_admin: boolean` / `is_active: boolean`；`admin.ts` 导出 `listUsers()`、`setActive(id, isActive)`、`resetPassword(id, password)`、`deleteUser(id)`。

- [ ] **Step 1: 扩展 `User` 类型**

`frontend/src/types/index.ts`：

```typescript
export interface User {
  id: number
  username: string
  created_at: string
  is_admin: boolean
  is_active: boolean
}
```

- [ ] **Step 2: 新建 `frontend/src/api/admin.ts`**

```typescript
import { http } from './http'
import type { User } from '@/types'

// Uses the shared instance from api/http.ts, not a bare axios client: that one
// carries the Authorization header and the 401 interceptor. An admin whose own
// account is disabled mid-session must be logged out by this page too, and the
// interceptor is what does it.

export function listUsers(): Promise<User[]> {
  return http.get<User[]>('/admin/users').then(r => r.data)
}

export function setActive(id: number, is_active: boolean): Promise<User> {
  return http.patch<User>(`/admin/users/${id}`, { is_active }).then(r => r.data)
}

export function resetPassword(id: number, password: string): Promise<User> {
  return http.post<User>(`/admin/users/${id}/password`, { password }).then(r => r.data)
}

export function deleteUser(id: number): Promise<void> {
  return http.delete(`/admin/users/${id}`).then(() => undefined)
}
```

- [ ] **Step 3: 类型检查通过**

```bash
cd frontend && pnpm build
```

Expected：`vue-tsc` 无报错，构建产物写入 `dist/`。

若 `vue-tsc` 报 `User` 缺少 `is_admin` —— 说明某处构造了 `User` 字面量。按报错位置补齐字段，不要把类型改成可选：后端一定会返回这两个字段。

- [ ] **Step 4: Commit**

```bash
git add frontend/src/types/index.ts frontend/src/api/admin.ts
git commit -m "feat(admin): 前端 User 类型增加 is_admin/is_active，新增 admin API 封装"
```

---

## Task 8: 账号管理页面与路由

**Files:**
- Create: `frontend/src/utils/password.ts`
- Create: `frontend/src/views/AdminUsersView.vue`
- Modify: `frontend/src/router/index.ts:25-33`
- Modify: `frontend/src/components/layout/AppLayout.vue:136-139`
- Modify: `frontend/src/components/layout/SideNav.vue:43-60`

**Interfaces:**
- Consumes: Task 7 的 `admin.ts` 与 `User` 类型
- Produces: 路由 `/admin/users`（name: `admin-users`）；侧边栏对管理员显示入口。

- [ ] **Step 1: 抽出前后端共用的密码规则**

新建 `frontend/src/utils/password.ts` —— 注册页和重置弹窗都要用同一套规则，写两份必然漂移：

```typescript
// Mirrors backend/app/schemas/user.py. The byte count is the part that matters:
// bcrypt truncates at 72 *bytes*, and one Chinese character is 3 of them, so a
// character-based check would let a 30-character Chinese passphrase through with
// its tail silently discarded.
export const PASSWORD_MIN_CHARS = 8
export const PASSWORD_MAX_BYTES = 72

const encoder = new TextEncoder()

/** The problem with this password, or an empty string when it is acceptable. */
export function checkPassword(password: string): string {
  if (password.length < PASSWORD_MIN_CHARS) {
    return `密码至少 ${PASSWORD_MIN_CHARS} 位`
  }
  if (encoder.encode(password).length > PASSWORD_MAX_BYTES) {
    return `密码不能超过 ${PASSWORD_MAX_BYTES} 字节（约 24 个汉字）`
  }
  return ''
}
```

- [ ] **Step 2: 新建 `frontend/src/views/AdminUsersView.vue`**

```vue
<template>
  <div class="admin-users">
    <div class="toolbar">
      <span class="count text-muted">共 {{ users.length }} 个账号</span>
      <button class="nm-btn" :disabled="loading" @click="load">
        {{ loading ? '加载中...' : '刷新' }}
      </button>
    </div>

    <n-data-table
      :columns="columns"
      :data="users"
      :loading="loading"
      :bordered="false"
      :row-key="(row: User) => row.id"
    />

    <n-modal v-model:show="resetOpen" preset="dialog" title="重置密码">
      <template #default>
        <p class="reset-target">
          为 <strong>{{ resetTarget?.username }}</strong> 设置新密码
        </p>
        <n-input
          v-model:value="newPassword"
          type="password"
          show-password-on="click"
          placeholder="8-72 字节"
          @keyup.enter="confirmReset"
        />
        <p v-if="resetError" class="reset-error">{{ resetError }}</p>
      </template>
      <template #action>
        <button class="nm-btn" @click="resetOpen = false">取消</button>
        <button class="nm-btn primary" :disabled="resetting" @click="confirmReset">
          {{ resetting ? '提交中...' : '确定' }}
        </button>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { h, onMounted, ref } from 'vue'
import { NButton, NDataTable, NInput, NModal, NPopconfirm, NTag, useMessage } from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import type { User } from '@/types'
import * as adminApi from '@/api/admin'
import { useAuthStore } from '@/stores/auth'
import { checkPassword } from '@/utils/password'

const auth = useAuthStore()
const message = useMessage()

const users = ref<User[]>([])
const loading = ref(false)

const resetOpen = ref(false)
const resetTarget = ref<User | null>(null)
const newPassword = ref('')
const resetError = ref('')
const resetting = ref(false)

/** Read the server's message when there is one. Every 4xx here carries a Chinese
 *  detail worth showing verbatim — "不能删除自己", "不能删除最后一个管理员" — and
 *  replacing them with a generic string would hide the reason the action failed. */
function reason(e: any, fallback: string): string {
  return e?.response?.data?.detail || fallback
}

async function load() {
  loading.value = true
  try {
    users.value = await adminApi.listUsers()
  } catch (e: any) {
    message.error(reason(e, '加载账号列表失败'))
  } finally {
    loading.value = false
  }
}

async function toggleActive(row: User) {
  try {
    const updated = await adminApi.setActive(row.id, !row.is_active)
    Object.assign(row, updated)
    message.success(updated.is_active ? '已启用' : '已禁用')
  } catch (e: any) {
    message.error(reason(e, '操作失败'))
  }
}

async function remove(row: User) {
  try {
    await adminApi.deleteUser(row.id)
    users.value = users.value.filter(u => u.id !== row.id)
    message.success(`已删除 ${row.username}`)
  } catch (e: any) {
    message.error(reason(e, '删除失败'))
  }
}

function openReset(row: User) {
  resetTarget.value = row
  newPassword.value = ''
  resetError.value = ''
  resetOpen.value = true
}

async function confirmReset() {
  const target = resetTarget.value
  if (!target) return

  // Same rule the backend enforces, checked here so the admin sees it before a
  // round trip that would come back as an unreadable 422 body.
  const problem = checkPassword(newPassword.value)
  if (problem) {
    resetError.value = problem
    return
  }

  resetting.value = true
  try {
    await adminApi.resetPassword(target.id, newPassword.value)
    resetOpen.value = false
    message.success(`已重置 ${target.username} 的密码`)
  } catch (e: any) {
    resetError.value = reason(e, '重置失败')
  } finally {
    resetting.value = false
  }
}

const columns: DataTableColumns<User> = [
  { title: '用户名', key: 'username' },
  {
    title: '注册时间',
    key: 'created_at',
    render: row => new Date(row.created_at).toLocaleString('zh-CN')
  },
  {
    title: '状态',
    key: 'status',
    render: row => {
      if (row.is_admin) return h(NTag, { type: 'info', bordered: false }, () => '管理员')
      return row.is_active
        ? h(NTag, { type: 'success', bordered: false }, () => '正常')
        : h(NTag, { type: 'error', bordered: false }, () => '已禁用')
    }
  },
  {
    title: '操作',
    key: 'actions',
    render: row => {
      // The server refuses these for the current account anyway (400 "不能删除自己").
      // Hiding them here means the admin never clicks something that cannot work.
      if (row.id === auth.user?.id) return h('span', { class: 'text-muted' }, '—')

      return h('div', { class: 'row-actions' }, [
        h(NButton, { size: 'small', secondary: true, onClick: () => toggleActive(row) },
          () => (row.is_active ? '禁用' : '启用')),
        h(NButton, { size: 'small', secondary: true, onClick: () => openReset(row) },
          () => '重置密码'),
        h(NPopconfirm,
          { onPositiveClick: () => remove(row), positiveText: '删除', negativeText: '取消' },
          {
            trigger: () => h(NButton, { size: 'small', secondary: true, type: 'error' }, () => '删除'),
            default: () => `删除 ${row.username}？该账号的 API 配置会一并清除，不可恢复。`
          })
      ])
    }
  }
]

onMounted(load)
</script>

<style scoped>
.admin-users { padding: 4px; }

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.count { font-size: 13px; }

:deep(.row-actions) { display: flex; gap: 8px; }

.reset-target { margin: 0 0 12px; font-size: 14px; }
.reset-error { margin: 8px 0 0; color: #c0564a; font-size: 13px; }
</style>
```

- [ ] **Step 3: 注册路由**

`frontend/src/router/index.ts`，在 `banana-gen` 之后加入同级子路由：

```typescript
        {
          path: 'admin/users',
          name: 'admin-users',
          component: () => import('@/views/AdminUsersView.vue')
        }
```

- [ ] **Step 4: 顶栏标题**

`frontend/src/components/layout/AppLayout.vue` 的 `titleMap`：

```typescript
const titleMap: Record<string, string> = {
  'image-gen': 'GPT Image 生成',
  'banana-gen': 'Gemini 图片生成',
  'admin-users': '账号管理'
}
```

- [ ] **Step 5: 侧边栏入口（仅管理员可见）**

`AppLayout.vue` 里给 `SideNav` 加一个 prop：

```vue
    <SideNav
      :collapsed="collapsed"
      :username="auth.user?.username"
      :is-admin="auth.user?.is_admin === true"
      @toggle="collapsed = !collapsed"
      @logout="handleLogout"
    />
```

`SideNav.vue` 的 script 部分：

```typescript
const props = defineProps<{ collapsed: boolean; username?: string; isAdmin?: boolean }>()
const emit = defineEmits<{ toggle: []; logout: [] }>()
```

把 `navItems` 从常量改为 computed（需要在已有的 `computed` import 上追加，它已经被 import 了）：

```typescript
// Hiding the entry is presentation only — it is not the permission. Every route
// behind it is refused server-side by get_current_admin, which is what actually
// enforces this.
const navItems = computed(() => {
  const items = [
    { to: '/image-gen', icon: '🖼️', label: 'GPT Image 生成' },
    { to: '/banana-gen', icon: '🍌', label: 'Gemini 图片生成' }
  ]
  if (props.isAdmin) items.push({ to: '/admin/users', icon: '👤', label: '账号管理' })
  return items
})
```

模板里的 `v-for="item in navItems"` 不需要改 —— Vue 会自动解包 computed 的 `.value`。

- [ ] **Step 6: 构建并人工走一遍**

```bash
cd frontend && pnpm build
cd .. && docker compose -f docker-compose.local.yml restart nginx
```

浏览器打开 `http://127.0.0.1:8080`，用 `147ai` 登录，然后：

1. 侧边栏应出现「👤 账号管理」；点进去能看到账号列表
2. 注册一个测试账号（另开无痕窗口），回到管理页刷新，应看到它，状态「正常」
3. 点「禁用」→ 状态变「已禁用」；回无痕窗口刷新页面 → 应被踢回登录页
4. 点「重置密码」→ 填 `newpass12345` → 提示成功
5. 点「删除」→ 弹出二次确认 → 确认后该行消失
6. `147ai` 自己那一行，操作列应显示 `—`

Expected：六条全部符合。把实际观察到的结果逐条写下来，不要只写"通过"。

- [ ] **Step 7: 验证非管理员看不到入口，且直接敲 URL 也进不去**

用无痕窗口注册的普通账号登录，然后：

1. 侧边栏不应出现「账号管理」
2. 地址栏直接输入 `http://127.0.0.1:8080/admin/users`

Expected：页面能打开（前端路由不做权限判断），但表格为空并弹出错误提示「需要管理员权限」—— 数据来自服务端，`get_current_admin` 已经挡住了。这正是 spec §7.3 说的"UI 隐藏不构成权限"。

- [ ] **Step 8: Commit**

```bash
git add frontend/src/views/AdminUsersView.vue frontend/src/utils/password.ts \
        frontend/src/router/index.ts frontend/src/components/layout/AppLayout.vue \
        frontend/src/components/layout/SideNav.vue
git commit -m "feat(admin): 新增账号管理页面、路由与管理员导航入口"
```

---

## Task 9: 注册页的密码规则提示

**Files:**
- Modify: `frontend/src/views/LoginView.vue:62-66`、`frontend/src/views/LoginView.vue:80-110`

**Interfaces:**
- Consumes: Task 8 Step 1 的 `checkPassword`
- Produces: 无（终端任务）

- [ ] **Step 1: 在 `LoginView.vue` 引入规则**

script 顶部加入：

```typescript
import { checkPassword } from '@/utils/password'
```

- [ ] **Step 2: 在 `handleRegister` 里先做本地校验**

找到 `handleRegister`，在 `await formRef.value?.validate()` 之后、发起请求之前插入：

```typescript
  // Checked before the request so the user sees the rule in plain Chinese. The
  // backend returns 422 with a pydantic error body for the same case, which is
  // not something to put in front of someone who just typed a short password.
  const problem = checkPassword(form.value.password)
  if (problem) {
    message.warning(problem)
    nudge(cardEl.value)
    return
  }
```

- [ ] **Step 3: 给密码框加提示文案**

模板里的密码 `n-input` 增加 placeholder 说明，让规则在输入前就可见：

```vue
          <n-input
            v-model:value="form.password"
            type="password"
            placeholder="密码（注册需 8 位以上）"
            size="large"
            class="nm-inset"
            @keyup.enter="handleLogin"
          />
```

- [ ] **Step 4: 构建并验证**

```bash
cd frontend && pnpm build
cd .. && docker compose -f docker-compose.local.yml restart nginx
```

浏览器无痕窗口打开 `http://127.0.0.1:8080/login`：

1. 用户名 `probe_ui`、密码 `1234567`（7 位）→ 点「注册」
2. 用户名 `probe_ui`、密码 `probe12345` → 点「注册」

Expected：第 1 步弹出黄色提示「密码至少 8 位」且**没有发出网络请求**（DevTools Network 面板确认）；第 2 步注册成功并直接进入主界面。

- [ ] **Step 5: 清理测试账号**

用 `147ai` 登录管理页，把 `probe_ui` 删掉，确认列表只剩 `147ai`。

- [ ] **Step 6: Commit**

```bash
git add frontend/src/views/LoginView.vue
git commit -m "feat(auth): 注册前在前端校验密码规则"
```

---

## 收尾检查

- [ ] `docker compose -f docker-compose.local.yml logs fastapi | grep -iE "Traceback|ERROR"` 无输出
- [ ] `cd frontend && pnpm build` 通过
- [ ] `git log --oneline -9` 显示九次提交，每次只动一个关注点
- [ ] 数据库里只剩 `147ai` 一个账号，且 `is_admin=1`
- [ ] `.env.example` 增加一行 `# ALLOW_REGISTRATION=true`（关闭注册时改为 false），并提交
