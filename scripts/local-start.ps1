# 本地 Docker 一键启动脚本
# 用法: 在项目根目录运行 .\scripts\local-start.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent

# 原生命令（pnpm / docker）只要往 stderr 写字就会被 PowerShell 包成 ErrorRecord，
# 一旦调用方重定向了 stderr（`2>&1` / `2>$null` / 写日志），配合 Stop 就会在命令
# 执行中途直接抛异常——哪怕命令本身退出码是 0（pnpm 的 approve-builds 警告就是这样）。
# 所以运行原生命令时临时放开 ErrorActionPreference，改成事后检查退出码。
function Invoke-Step($Description, [scriptblock]$Command) {
    Write-Host "==> $Description" -ForegroundColor Cyan
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $Command } finally { $ErrorActionPreference = $prev }
    if ($LASTEXITCODE -ne 0) {
        throw "$Description 失败 (exit $LASTEXITCODE)"
    }
}

Set-Location "$root\frontend"
Invoke-Step "安装前端依赖..." { pnpm install --frozen-lockfile }
Invoke-Step "构建前端..."     { pnpm build }

Set-Location $root
Invoke-Step "启动 Docker 容器..." { docker compose -f docker-compose.local.yml up -d --build }

# up --build 只重建后端镜像，nginx 会保持 Running 不被重建。
# 它的配置是 bind-mount 的、且只在启动时读一次，所以 nginx/*.conf 的改动
# 必须靠一次显式 restart 才会生效。
Invoke-Step "重载 nginx 配置..." { docker compose -f docker-compose.local.yml restart nginx }

Write-Host ""
# 用 127.0.0.1 而不是 localhost: Windows 上 localhost 优先解析到 IPv6 ::1，
# 而 Docker 的端口映射只监听 IPv4。
Write-Host "✅ 本地环境已启动: http://127.0.0.1:8080" -ForegroundColor Green
