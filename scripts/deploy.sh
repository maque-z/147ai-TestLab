#!/bin/bash
# 服务器端部署脚本 (在宝塔服务器上运行)
#
#   bash scripts/deploy.sh
#
# 幂等：重复执行安全。数据库在 docker volume 里，本脚本不会删除它。
set -euo pipefail

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
git pull

echo "==> 构建前端..."
cd frontend
npm install --legacy-peer-deps

# 宝塔建站时会往根目录放 .user.ini 并加 immutable 属性(chattr +i)，
# 导致 Vite 清空 dist/ 时报 ENOTDIR 直接失败。这两个文件对纯静态站点无用。
if [ -e dist/.user.ini ]; then
  chattr -i dist/.user.ini 2>/dev/null || true
  rm -f dist/.user.ini
fi
rm -f dist/.htaccess 2>/dev/null || true

npm run build
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
