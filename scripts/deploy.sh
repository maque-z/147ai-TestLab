#!/bin/bash
# 服务器端部署脚本 (在宝塔服务器上运行)
#
#   bash scripts/deploy.sh
#
# 幂等：重复执行安全。数据库在 docker volume 里，本脚本不会删除它。
set -euo pipefail

# 整个脚本体包在 { } 里，末尾 exit 0。
# 因为下面会 git pull，而 pull 会改写本文件——bash 是边读边执行的，
# 文件在运行中变长/变短会导致它从错误的偏移继续读，执行出乱码命令。
# 包成一个复合命令后 bash 会先完整解析再执行，exit 0 保证不再回去读文件。
{

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# 宿主机端口，与 docker-compose.yml 的 BACKEND_PORT 保持一致
BACKEND_PORT="$(grep -E '^BACKEND_PORT=' .env 2>/dev/null | cut -d= -f2- || true)"
BACKEND_PORT="${BACKEND_PORT:-8005}"

# docker compose (v2) 与 docker-compose (v1) 都支持
if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
else
  DC="docker-compose"
fi

if [ ! -f .env ]; then
  echo "✗ 缺少 .env。先复制模板并填写:"
  echo "    cp .env.example .env && nano .env"
  echo "  SECRET_KEY 可用 openssl rand -hex 32 生成"
  exit 1
fi

echo "==> 备份数据库..."
# 卷名由 compose 项目名决定，不能写死；容器没起来时 -aq 仍能拿到 ID
CID="$($DC ps -aq fastapi 2>/dev/null || true)"
if [ -n "$CID" ]; then
  VOL="$(docker inspect "$CID" \
    --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Name}}{{end}}{{end}}')"
  if [ -n "$VOL" ]; then
    mkdir -p backups
    docker run --rm -v "$VOL:/data:ro" -v "$ROOT_DIR/backups:/backup" \
      alpine tar czf "/backup/db-$(date +%F-%H%M%S).tar.gz" -C /data .
    # 只留最近 10 份
    ls -t backups/*.tar.gz 2>/dev/null | tail -n +11 | xargs -r rm --
    echo "    已备份到 backups/ (卷: $VOL)"
  fi
else
  echo "    首次部署，数据库还不存在，跳过"
fi

echo "==> 拉取最新代码..."
# 写死 origin main：服务器上如果是浅克隆或没设上游分支，裸 git pull 会直接报错
git pull origin main

echo "==> 构建前端..."
cd frontend

# 必须用 pnpm：仓库里锁的是 pnpm-lock.yaml，没有 package-lock.json。
# 之前这里跑 npm install --legacy-peer-deps，而 npm 读不了 pnpm 的 lockfile，
# 等于每次部署都把所有间接依赖重新浮动解析一遍——本地和线上是两棵不同的依赖树。
# 版本由 package.json 的 packageManager 字段钉住。

# Node 18+：vite 5 和 pnpm 10 都要求它。先在这儿拦一道，
# 否则报出来的是 pnpm 的 engine 错误或 vite 的语法错误，都不指向真正的原因。
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "✗ 需要 Node 18 或更高版本，当前是 $(node -v 2>/dev/null || echo '未安装 node')"
  echo "  宝塔: 软件商店 → Node.js 版本管理器 → 安装 18/20/22 并设为命令行版本"
  exit 1
fi

# pnpm 的取得方式按可靠性排序。每一种都当场验证能不能真的跑起来，
# 而不是只看命令存不存在——corepack 在旧 Node 上会因为签名 keyid 过期而失败，
# 那种情况下 command -v 是成功的，真正执行才报错。
PNPM=""
if command -v pnpm >/dev/null 2>&1 && pnpm --version >/dev/null 2>&1; then
  PNPM="pnpm"
elif command -v corepack >/dev/null 2>&1; then
  # Node 16.9+ 自带 corepack，它照 package.json 的 packageManager 字段拉对应版本
  corepack enable >/dev/null 2>&1 || true
  corepack prepare --activate >/dev/null 2>&1 || true
  # enable 会把 pnpm shim 装进 PATH，优先用它；不行再退回 corepack 代理执行
  if command -v pnpm >/dev/null 2>&1 && pnpm --version >/dev/null 2>&1; then
    PNPM="pnpm"
  elif corepack pnpm --version >/dev/null 2>&1; then
    PNPM="corepack pnpm"
  fi
fi
if [ -z "$PNPM" ]; then
  echo "    未找到可用的 pnpm，全局装一个..."
  npm install -g pnpm
  command -v pnpm >/dev/null 2>&1 && pnpm --version >/dev/null 2>&1 || {
    echo "✗ pnpm 安装后仍不可用，检查 npm 全局 bin 是否在 PATH 里:"
    echo "    npm bin -g"
    exit 1
  }
  PNPM="pnpm"
fi
echo "    包管理器: $PNPM $($PNPM --version)"

# 历史上这台机器可能被 npm install 装过一棵扁平的 node_modules。
# pnpm 不会去接管它，混着用会解析到意料之外的版本，所以先清掉。
if [ -d node_modules ] && [ ! -d node_modules/.pnpm ]; then
  echo "    检测到 npm 装出来的 node_modules，清除后改用 pnpm..."
  rm -rf node_modules
fi

# --frozen-lockfile: lockfile 与 package.json 不一致时直接失败，
# 而不是就地改写 lockfile——那样服务器就又开始自己解析依赖了。
$PNPM install --frozen-lockfile

# 宝塔建站时会往根目录放 .user.ini 并加 immutable 属性(chattr +i)，
# 导致 Vite 清空 dist/ 时报 ENOTDIR 直接失败。这两个文件对纯静态站点无用。
if [ -e dist/.user.ini ]; then
  chattr -i dist/.user.ini 2>/dev/null || true
  rm -f dist/.user.ini
fi
rm -f dist/.htaccess 2>/dev/null || true

$PNPM build
cd ..

# 宝塔 nginx 以 www 用户运行，root 构建出的文件它读不了 → 403。
# 只改 dist：项目根目录归 root，递归会破坏 git 和 docker 的权限。
if id www >/dev/null 2>&1; then
  echo "==> 修正 dist 权限 (www:www)..."
  chown -R www:www frontend/dist
fi

echo "==> 重建 FastAPI 容器..."
$DC up -d --build

echo "==> 等待后端就绪..."
for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${BACKEND_PORT}/api/v1/health" >/dev/null; then
    echo "    后端已就绪 (127.0.0.1:${BACKEND_PORT})"
    break
  fi
  [ "$i" -eq 30 ] && {
    echo "✗ 后端 30 秒未就绪，查看日志:"
    echo "    $DC logs --tail=50 fastapi"
    exit 1
  }
  sleep 1
done

echo ""
echo "✅ 部署完成"
$DC ps
echo ""
echo "浏览器请强制刷新 (Ctrl+Shift+R)，否则可能拿到缓存的旧页面"

exit 0
}   # <-- 闭合顶部的 {，勿删；见文件开头的说明
