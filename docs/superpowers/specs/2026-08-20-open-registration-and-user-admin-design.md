# 开放注册与账号管理设计文档

日期：2026-08-20
状态：待实施
范围：`backend/app/`（认证、模型、schema、CRUD、启动回填）与 `frontend/src/`（注册校验、管理页面）

---

## 1. 目标与决策前提

开放注册，管理员能管理注册进来的账号。

三条已由使用者拍板的前提，设计围绕它们展开：

1. **完全开放注册** —— 不做待审核、不做邀请码。填用户名密码即可用。
2. **配置每账号一份，互不共享** —— 新用户不会继承任何人的 API Key，因此注册者消耗的是他自己的上游额度。
3. **管理能力四项** —— 查看列表、禁用/启用、删除、重置密码。不含"设置他人为管理员"。

### 1.1 已经成立的事实（无需新建）

实施前核对代码，以下两项已具备，避免重复建设：

**慢哈希加盐已经做到。** `core/security.py` 用 bcrypt，`gensalt()` 默认 cost=12（容器内实测 `(rounds=12, prefix=b'2b')`）。bcrypt 本身即自适应慢哈希，每个密码独立随机盐、盐嵌在 hash 串内。本设计不新建哈希机制，只补它的**边界约束**（见 §4）。

**配置隔离已经做到。** `crud/user.py` 的 `_get_or_create_config` 一律按 `user_id` 过滤，新用户首次访问是新建一行空配置（`baseurl=""`、`api_key=""`）。新注册者点生成会撞上 `deps.py` 的 400「请先在配置中填写 API Key」，必须填自己的 key。

因此"完全开放注册"在本项目的风险显著低于一般站点：注册者拿不到部署者的额度。

### 1.2 仍然存在的风险（已知悉并接受）

注册开放后，任何人可创建账号并占用数据库行与登录限流表条目。使用者已知悉并选择开放。设计中保留一个可关闭的开关（`ALLOW_REGISTRATION`，默认 `True`），使事后收口无需改代码。

---

## 2. 数据模型

`users` 表新增三列：

| 列 | 类型 | 默认 | 用途 |
|---|---|---|---|
| `is_admin` | Boolean | `False` | 管理员标记 |
| `is_active` | Boolean | `True` | 禁用开关 |
| `password_changed_at` | DateTime | `utcnow` | token 失效锚点 |

### 2.1 为什么需要 `password_changed_at`

JWT 有效期为 7 天（`ACCESS_TOKEN_EXPIRE_MINUTES = 60*24*7`），签发后服务端无法撤销。若只加 `is_active`，禁用一个账号后他手中的 token 仍可用满 7 天 —— 禁用形同虚设。

引入该列后，`get_current_user` 比对 token 的 `iat` 与此列：签发早于变更时刻即拒绝。禁用则直接读 `is_active`。两项判断都在 `deps.py` **已有的那次用户查询**之后完成，不增加数据库往返。

### 2.2 已有数据库的升级

沿用 `bootstrap.ensure_schema()` 中已存在的回填模式（该函数已做过 UNIQUE 索引回填）：`PRAGMA table_info(users)` 检查列是否存在，缺失则 `ALTER TABLE users ADD COLUMN`。SQLite 的 `ADD COLUMN` 是 O(1) 元数据操作，不重写表。

**回填值的选择**：`password_changed_at` 对既有行回填为一个**足够早的固定时刻**（`1970-01-01`），而非 `utcnow()`。若回填为"现在"，当前有效 token 的 `iat` 会早于它而立刻失效 —— 升级即把所有人登出。回填为早期时刻可使现有会话平滑保留。

### 2.3 第一个管理员

`settings.DEFAULT_USERNAME`（默认 `147ai`）：

- 全新库：`seed_default_user` 创建时置 `is_admin=True`。
- 既有库：`ensure_schema` 补列后，将该用户名的 `is_admin` 置 1 一次（幂等）。

使既有部署升级后原账号直接具备管理员身份，无需手工改库。

---

## 3. 接口

```
POST   /api/v1/auth/register              公开，成功返回 token（自动登录）
GET    /api/v1/admin/users                管理员
PATCH  /api/v1/admin/users/{id}           管理员，body: {is_active: bool}
POST   /api/v1/admin/users/{id}/password  管理员，body: {password: str}
DELETE /api/v1/admin/users/{id}           管理员
```

管理端新增 `get_current_admin` 依赖，架在 `get_current_user` 之上。后者已查询用户并加载完整列，故判断 `is_admin` 不产生新的数据库往返。非管理员返回 403。

管理路由放入新文件 `api/admin.py`，与 `auth.py` 平级注册。理由：`auth.py` 已承载登录、限流、注册三类逻辑，再并入五个管理端点会使单文件承担过多职责。

### 3.1 限流

注册复用 `throttle.py` 现有的按 IP 限流（8 次 / 5 分钟，超限锁 15 分钟），但**使用独立的桶键** `reg:{ip}`，与登录的 `{ip}` 分开。

`_buckets` 本就以任意字符串为键，因此这不需要改动 `throttle.py`。

**必须分开的原因**：`auth.py` 在登录成功时调用 `clear_attempts(ip)`，而该函数是整桶 `pop`。若两者共用一个桶，攻击者可用「注册 → 登录成功 → 注册」的序列在每次注册后把计数清零，注册限流将完全失效 —— 每个账号仅需两个请求。

分开之后的取舍：大量注册尝试不再连带锁住同 IP 的登录。这是可接受的，两个计数面本就应当独立计量。

**注册成功后不调用 `clear_attempts`。** 注册与登录不同 —— 登录成功证明调用方是账号主人，清零合理；而注册成功恰恰是要限制的那个动作本身，清零会让限流只对失败的注册生效。

---

## 4. 密码策略

沿用项目既有的分层写法（`ImageConfigBase` 无约束 / `ImageConfigUpdate` 带约束）：新增 `UserRegister` 承载校验，`UserCreate` 保持不变。

| 字段 | 约束 | 理由 |
|---|---|---|
| `username` | 3–50 字符，去首尾空白 | 50 对齐 `String(50)` 列宽 |
| `password` | 8–72 **字节** | 下限防弱口令；上限是 bcrypt 硬边界 |

**72 字节而非 72 字符**：中文一字 3 字节，即约 24 个汉字。

**为何必须挡住上限**：bcrypt 在 72 字节处**静默截断**。实测确认 —— 72 个 `A` 生成的 hash 与 100 个 `A` 校验返回 `True`。不挡则用户以为设置了长密码，实际超出部分未参与运算。

**为何 `UserCreate` 不加约束**：`bootstrap.seed_default_user` 用它构造种子账号。若加校验，一个 `DEFAULT_PASSWORD` 偏短的**全新部署**会在启动时直接崩溃。约束属于客户端提交的数据 —— 该原则已写在 `schemas/image_config.py` 的注释中，此处沿用。

---

## 5. 三个必须处理的边界

### 5.1 用户名撞车会 500

`create_user` 是裸的 `add + commit`，而 `username` 上有 UNIQUE 约束。两个请求同时注册同一用户名时，失败方抛 `IntegrityError` 且无人接管 —— 返回 500。注册关闭时不可达，开放后即暴露。

按 `_get_or_create_config` 已有的写法接住 `IntegrityError`，返回 400「用户名已被占用」。

### 5.2 删除账号必须级联清理配置（真实的密钥泄漏路径）

两张配置表的 `user_id` 是普通 Integer 列，**无外键约束**，因此没有级联删除。而 SQLite 的 `INTEGER PRIMARY KEY` 在未声明 `AUTOINCREMENT` 时按 `max(id)+1` 分配，**会回收已删除的最大 id**：

```
删除 id=5 的用户
      ↓
配置表中 user_id=5 的两行成为孤儿
      ↓
下一个注册者分配到 id=5
      ↓
_get_or_create_config 查到现成的孤儿行
      ↓
新用户直接继承前一个人的 baseurl + api_key
```

`DELETE` 必须在同一事务内清除 `user_image_configs` 与 `user_banana_configs` 中的对应行。

此项直接违背 §1 前提 2（配置不共享），是本设计中最高优先级的正确性要求。

### 5.3 管理员不能把自己锁死

三条服务端硬拦截，均返回 400：

- 不能删除自己
- 不能禁用自己
- 不能删除最后一个管理员

### 5.4 不开放 `is_admin` 的修改接口

使用者未要求"设置他人为管理员"，故 `is_admin` 仅由 `bootstrap` 授予 `DEFAULT_USERNAME`，无任何接口可修改。这消除了一类越权路径。日后需要时增加一个 PATCH 字段即可，改动很小。

---

## 6. token 失效机制

`create_access_token` 增加 `iat`（签发时间戳）。`get_current_user` 在既有用户查询之后追加两项判断：

```
解出 token 的 iat
      ↓
user.is_active 为假         → 401「账号已被禁用」
iat < password_changed_at   → 401「密码已变更，请重新登录」
      ↓
放行
```

选用时间戳而非版本号：`iat` 是 JWT 标准字段（RFC 7519），无需额外存储，且"重置密码"与"禁用"两种场景可共用同一锚点。

### 6.1 登录端点同样要拦

仅在 `get_current_user` 判断 `is_active` 是不够的。被禁用的账号若仍能通过 `POST /auth/login`，会拿到一个 200 与一枚**崭新的 token**（其 `iat` 为当前时刻，可通过 §6 的第二项判断），随后每一个业务请求才 401。表现为"能登录但什么都点不动"，既误导用户也让禁用看起来像故障。

因此 `login` 在密码校验通过之后、签发 token 之前，追加一次 `is_active` 判断，返回 403「账号已被禁用」。

此处**刻意不复用** §3 登录失败的统一文案 `用户名或密码错误`：该文案的用途是防止用户名枚举，而能走到这一步说明调用方已经提供了正确的用户名与密码，账号存在与否早已不是秘密。继续含糊只会让被禁用的用户反复重试。

### 6.2 一秒粒度陷阱

`iat` 按 RFC 7519 为**整秒**，而 `password_changed_at` 是微秒精度 datetime。若管理员重置密码后用户在同一秒内登录，新 token 的 `iat` 因向下取整而**小于** `password_changed_at`，刚拿到的 token 立即失效 —— 表现为"登录成功后马上被踢出"。

**处理**：比较时将 `password_changed_at` 一并向下取整到秒。

**代价权衡**：同一秒内签发的旧 token 可能逃过一次校验，该窗口无实际意义；而反方向（用户永远无法登录）是真实故障。

---

## 7. 前端

### 7.1 注册

`LoginView.vue` 的注册按钮与 `handleRegister` 已存在并已接好 `auth.register()`，当前仅因后端返回 403 而不可用。前端仅需补充与后端一致的密码规则校验（8–72 字节），使用户在提交前看到提示而非收到 422。

`api/auth.ts` 的 `register()` 签名（`LoginRequest` → `TokenResponse`）与新后端契合，无需改动。

### 7.2 管理页面

新增路由 `/admin/users` 与 `views/AdminUsersView.vue`：

```
用户名     注册时间           状态      操作
────────────────────────────────────────────────
147ai     2026-08-11 10:22   管理员    —
zhangsan  2026-08-20 15:03   正常      [禁用] [重置密码] [删除]
lisi      2026-08-20 15:47   已禁用    [启用] [重置密码] [删除]
```

使用 naive-ui 的 `n-data-table`（项目已依赖 2.39.0），沿用 `SideNav` 现有的 neumorphic 风格。删除操作以 `n-popconfirm` 二次确认。

### 7.3 入口可见性

侧边栏"用户管理"仅对管理员显示，需在 `types/index.ts` 的 `User` 与 `schemas/user.py` 的 `UserOut` 增加 `is_admin`。

**这只是 UI 隐藏，不构成权限。** 实际拦截在服务端的 `get_current_admin`。

管理页面使用 `api/http.ts` 中带 401 拦截器的 axios 实例，故账号被禁用后该页会正确触发登出。

---

## 8. 验证

按使用者的全局规则，不主动编写测试脚本。以下四条以手动执行并留存输出：

1. 注册新账号 → 确认其配置为空，未继承既有账号的 key
2. 禁用账号 → 确认其既有 token 立即失效（非等待 7 天过期）
3. 重置密码 → 确认旧会话被踢出，且新登录不被 §6.2 的一秒陷阱误伤
4. 删除账号后重新注册 → 确认未继承孤儿配置（§5.2 的实证）

第 4 条是本设计中最高优先级正确性要求的直接验证。

---

## 9. 改动清单

**后端**

| 文件 | 改动 |
|---|---|
| `models/user.py` | User 增加三列 |
| `core/bootstrap.py` | 列回填、既有库管理员标记 |
| `core/security.py` | `create_access_token` 增加 `iat` |
| `core/deps.py` | `get_current_user` 增加两项校验；新增 `get_current_admin` |
| `core/config.py` | 新增 `ALLOW_REGISTRATION` |
| `schemas/user.py` | 新增 `UserRegister`、`UserOut` 增加 `is_admin` 等 |
| `crud/user.py` | `create_user` 接住 IntegrityError；新增列表/禁用/重置/级联删除 |
| `api/auth.py` | 实现 register；login 增加 is_active 拦截 |
| `api/admin.py` | 新建，四个管理端点 |
| `main.py` | 注册 admin 路由 |

**前端**

| 文件 | 改动 |
|---|---|
| `views/LoginView.vue` | 注册密码规则校验 |
| `views/AdminUsersView.vue` | 新建 |
| `api/admin.ts` | 新建 |
| `router/index.ts` | 新增 `/admin/users` |
| `components/layout/SideNav.vue` | 管理员入口 |
| `types/index.ts` | `User` 增加 `is_admin` |
