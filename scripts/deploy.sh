#!/bin/bash
# 服务器端部署脚本 (在宝塔服务器上运行)
set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "==> 拉取最新代码..."
git pull

echo "==> 构建前端..."
cd frontend
npm install --legacy-peer-deps
npm run build
cd ..

echo "==> 重启 FastAPI 容器..."
docker-compose up -d --build

echo ""
echo "✅ 部署完成。检查容器状态:"
docker-compose ps
