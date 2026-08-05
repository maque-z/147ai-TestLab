# 本地 Docker 一键启动脚本
# 用法: 在项目根目录运行 .\scripts\local-start.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent

Write-Host "==> 构建前端..." -ForegroundColor Cyan
Set-Location "$root\frontend"
pnpm install --frozen-lockfile
pnpm build

Write-Host "==> 启动 Docker 容器..." -ForegroundColor Cyan
Set-Location $root
docker-compose -f docker-compose.local.yml up -d --build

Write-Host ""
Write-Host "✅ 本地环境已启动: http://localhost:8080" -ForegroundColor Green
