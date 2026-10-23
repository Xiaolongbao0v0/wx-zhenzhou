# ============================================================================
#  wx-bridge 启动器
#
#  中文放在这里而不是 .cmd 里：cmd.exe 按 GBK 解析批处理，UTF-8 中文会乱码闪退。
#  PowerShell 能正确处理 UTF-8，并且本文件带 BOM，Windows PowerShell 5.1 也认。
# ============================================================================

$ErrorActionPreference = 'Stop'

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $root

# ── 找 node ────────────────────────────────────────────────────────────────
#
# 为什么不能直接写 `& node`：本机 PATH 里 C:\Windows\System32\node 是一个
# **0 字节的空文件**，它排在真身 node 前面。
#   · cmd.exe 会跳过这个空文件，正确找到 node.exe（所以外层检查能过）
#   · PowerShell 的 Get-Command 会把它当成 node 返回，
#     一执行就失败，而且 $LASTEXITCODE 是空的 —— 于是界面上显示"退出码 "后面没东西
#
# 所以这里按文件长度筛，只认真实可执行的文件。
function Find-Node {
    $cands = @(Get-Command node -All -ErrorAction SilentlyContinue |
               Where-Object { $_.CommandType -eq 'Application' })
    foreach ($c in $cands) {
        if (-not $c.Source) { continue }
        if (-not (Test-Path $c.Source)) { continue }
        try {
            $len = (Get-Item $c.Source -Force -ErrorAction Stop).Length
        } catch { continue }
        if ($len -gt 1024) { return $c.Source }
    }
    # 兜底：常见安装位置
    foreach ($p in @('C:\Program Files\nodejs\node.exe',
                     "$env:ProgramFiles\nodejs\node.exe",
                     "$env:LOCALAPPDATA\Programs\nodejs\node.exe")) {
        if (Test-Path $p) {
            try { if ((Get-Item $p -Force).Length -gt 1024) { return $p } } catch { }
        }
    }
    return $null
}

$nodeExe = Find-Node

Write-Host ''
Write-Host '  wx-bridge  ·  微信聊天机器人' -ForegroundColor Cyan
Write-Host '  ---------------------------------------------' -ForegroundColor DarkGray

if (-not $nodeExe) {
    Write-Host '  错误 : 找不到可用的 Node.js' -ForegroundColor Red
    Write-Host ''
    Write-Host '  PATH 里的 node 都不能执行（可能是 0 字节的占位文件）。' -ForegroundColor Yellow
    Write-Host '  请安装 Node.js：https://nodejs.org' -ForegroundColor Yellow
    Write-Host ''
    Read-Host '  按回车关闭'
    exit 1
}

# ── 已经在跑就不重复启动 ───────────────────────────────────────────────────
$pidFile = Join-Path $root 'data\bridge.pid'
$running = $false
if (Test-Path $pidFile) {
    try {
        $savedPid = [int]((Get-Content $pidFile -Raw).Trim())
        $proc = Get-Process -Id $savedPid -ErrorAction SilentlyContinue
        if ($proc) {
            $running = $true
            Write-Host "  状态 : 已经在运行（PID $savedPid）" -ForegroundColor Yellow
            Write-Host ''
            Write-Host '  你不需要再启动一次。直接去微信给她发消息即可。' -ForegroundColor Yellow
            Write-Host ''
            Write-Host '  如果要重启：' -ForegroundColor DarkGray
            Write-Host "    $nodeExe launch.js --restart --mode=chat" -ForegroundColor DarkGray
            Write-Host '  如果要停止：' -ForegroundColor DarkGray
            Write-Host "    $nodeExe launch.js --stop" -ForegroundColor DarkGray
            Write-Host ''
            Read-Host '  按回车关闭此窗口'
            exit 0
        }
    } catch {
        # PID 文件坏了，当没运行处理
    }
}

if (-not $running) {
    Write-Host '  状态 : 正在启动…'
    Write-Host '  ---------------------------------------------' -ForegroundColor DarkGray
    Write-Host ''

    # 用 launch.js 启动：它会把 PID 写进 data/bridge.pid，
    # 以后停止/重启只针对这个 PID，不会误杀 DSH 等其他 node 进程。
    # 注意用解析出来的完整路径（$nodeExe），不要写裸的 node。
    $launchCode = 0
    try {
        & $nodeExe (Join-Path $root 'launch.js') --mode=chat
        $launchCode = $LASTEXITCODE
    } catch {
        Write-Host ''
        Write-Host "  启动失败：$($_.Exception.Message)" -ForegroundColor Red
        Write-Host "  用的是: $nodeExe" -ForegroundColor DarkGray
        Read-Host '  按回车关闭'
        exit 1
    }

    if ($null -eq $launchCode) {
        Write-Host ''
        Write-Host '  启动失败：命令没有返回退出码（node 可能根本没跑起来）' -ForegroundColor Red
        Write-Host "  用的是: $nodeExe" -ForegroundColor DarkGray
        Read-Host '  按回车关闭'
        exit 1
    }

    if ($launchCode -ne 0) {
        Write-Host ''
        Write-Host "  启动失败（退出码 $launchCode）" -ForegroundColor Red
        Write-Host "  用的是: $nodeExe" -ForegroundColor DarkGray
        Read-Host '  按回车关闭'
        exit $launchCode
    }

    # 等它真正开始轮询再报告成功
    Start-Sleep -Seconds 5

    $logPath = Join-Path $root 'data\run.log'
    $ok = $false
    if (Test-Path $logPath) {
        $log = Get-Content $logPath -Raw -ErrorAction SilentlyContinue
        if ($log -match '开始长轮询') { $ok = $true }
    }

    Write-Host ''
    if ($ok) {
        Write-Host '  =============================================' -ForegroundColor Green
        Write-Host '   启动成功，可以用了' -ForegroundColor Green
        Write-Host '  =============================================' -ForegroundColor Green
        Write-Host ''
        Write-Host '   去微信给 bot 发消息就行。'
        Write-Host ''
        Write-Host '   常用操作：' -ForegroundColor DarkGray
        Write-Host "     $nodeExe launch.js --status              看运行状态" -ForegroundColor DarkGray
        Write-Host "     $nodeExe launch.js --stop                停止" -ForegroundColor DarkGray
        Write-Host "     $nodeExe launch.js --restart --mode=chat 重启" -ForegroundColor DarkGray
        Write-Host ''
        Write-Host '   微信里可以用的指令：'
        Write-Host '     /new            清空对话上下文'
        Write-Host '     /role           看人设'
        Write-Host '     /do             看可执行的电脑操作'
        Write-Host '     /help          全部指令'
    } else {
        Write-Host '  启动可能没成功，请查看日志：' -ForegroundColor Red
        Write-Host "    $logPath" -ForegroundColor Red
    }

    Write-Host ''
    Read-Host '  按回车关闭此窗口（机器人会在后台继续运行）'
}
