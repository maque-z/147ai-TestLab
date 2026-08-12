#!/bin/bash
# 一次性安装：注册 deploy / dlog / dps 三个全局命令
#
#   bash scripts/install-alias.sh
#
# 装完在任何目录下敲 deploy 都能更新部署，不用先 cd 项目目录。
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

cat > /usr/local/bin/deploy <<EOF
#!/bin/bash
exec bash "$ROOT_DIR/scripts/deploy.sh" "\$@"
EOF

cat > /usr/local/bin/dlog <<EOF
#!/bin/bash
cd "$ROOT_DIR" && exec docker compose logs -f --tail="\${1:-100}" fastapi
EOF

cat > /usr/local/bin/dps <<EOF
#!/bin/bash
cd "$ROOT_DIR" && exec docker compose ps
EOF

chmod +x /usr/local/bin/deploy /usr/local/bin/dlog /usr/local/bin/dps

echo "✅ 已安装，之后在任意目录直接用："
echo "    deploy   更新部署（拉代码+构建前端+重启容器）"
echo "    dlog     实时看后端日志 (Ctrl+C 退出)"
echo "    dps      看容器状态"
