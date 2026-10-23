#Requires -Version 5.1
<#
  AI 微信聊天机器人 · 控制台
  ==========================================================================
  一个双击就能用的图形控制面板，替代原来那个命令行启动器。

  为什么不沿用 start.ps1：
    原来的流程是 START.cmd → start.ps1 → & node launch.js。
    中间任何一环因为 PATH 里的 0 字节 node 占位文件出问题，
    界面上只会显示"启动失败（退出码 ）"—— 退出码还是空的，完全看不出原因。
    这个面板把所有错误都显示在窗口里，并且自己按文件长度挑可用的 node。

  设计原则：
    1. 不做常驻进程，点开它只是操作 launch.js，关掉窗口机器人照常运行
    2. 所有 node 调用都用完整路径，绝不写裸的 node
    3. 状态、日志自动刷新，出问题当场看得见
#>

$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
try { $OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$Root = $PSScriptRoot
$PidFile = Join-Path $Root 'data\bridge.pid'
$LogFile = Join-Path $Root 'data\run.log'

# ── 找 node：按文件长度筛，跳过 PATH 里的 0 字节占位文件 ─────────────────
function Find-Node {
    $cands = @(Get-Command node -All -ErrorAction SilentlyContinue |
               Where-Object { $_.CommandType -eq 'Application' })
    foreach ($c in $cands) {
        if (-not $c.Source) { continue }
        if (-not (Test-Path $c.Source)) { continue }
        try { $len = (Get-Item $c.Source -Force -ErrorAction Stop).Length } catch { continue }
        if ($len -gt 1024) { return $c.Source }
    }
    foreach ($p in @('%LOCALAPPDATA%\Programs\nodejs\node.exe', 'C:\Program Files\nodejs\node.exe',
                     "$env:ProgramFiles\nodejs\node.exe",
                     "$env:LOCALAPPDATA\Programs\nodejs\node.exe")) {
        if (Test-Path $p) {
            try { if ((Get-Item $p -Force).Length -gt 1024) { return $p } } catch { }
        }
    }
    return $null
}

$NodeExe = Find-Node

# ── 读日志（node 写的是 UTF-8，解不开再退回 GBK） ────────────────────────
#
# 注意：run.log 被 node 独占地打开着，不能直接 File.ReadAllBytes ——
# 那会报 "The process cannot access the file because it is being used by another process"。
# 必须显式声明 FileShare.ReadWrite 才能读到。
function Read-LogTail {
    param([int]$Lines = 60)
    if (-not (Test-Path $LogFile)) { return '（还没有日志，启动后会出现）' }

    $bytes = $null
    try {
        $fs = [System.IO.File]::Open(
            $LogFile,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            [System.IO.FileShare]::ReadWrite
        )
        try {
            $ms = New-Object System.IO.MemoryStream
            $fs.CopyTo($ms)
            $bytes = $ms.ToArray()
            $ms.Dispose()
        } finally {
            $fs.Dispose()
        }
    } catch {
        # 兜底：Get-Content 默认就带共享访问
        try {
            return ((Get-Content $LogFile -Tail $Lines -Encoding UTF8 -ErrorAction Stop) -join "`r`n")
        } catch {
            return "（读日志失败：$($_.Exception.Message)）"
        }
    }

    if (-not $bytes -or $bytes.Length -eq 0) { return '（日志为空）' }

    $text = ''
    try {
        $strict = New-Object System.Text.UTF8Encoding($false, $true)
        $text = $strict.GetString($bytes)
    } catch {
        $text = [System.Text.Encoding]::GetEncoding(936).GetString($bytes)
    }

    $arr = $text -split "`r?`n"
    if ($arr.Count -gt $Lines) { $arr = $arr[($arr.Count - $Lines)..($arr.Count - 1)] }
    return ($arr -join "`r`n")
}

# ── 查运行状态 ────────────────────────────────────────────────────────────
function Get-BridgeStatus {
    if (-not (Test-Path $PidFile)) { return @{ running = $false; pid = 0 } }
    try {
        $raw = (Get-Content $PidFile -Raw -ErrorAction Stop).Trim()
        if (-not $raw) { return @{ running = $false; pid = 0 } }
        $savedPid = [int]$raw
        $proc = Get-Process -Id $savedPid -ErrorAction SilentlyContinue
        if ($proc) { return @{ running = $true; pid = $savedPid } }
        return @{ running = $false; pid = $savedPid; stale = $true }
    } catch {
        return @{ running = $false; pid = 0 }
    }
}

# ── 跑 launch.js ──────────────────────────────────────────────────────────
function Invoke-Launch {
    param([string[]]$ArgList)
    if (-not $NodeExe) { return @{ ok = $false; text = '找不到可用的 Node.js' } }
    try {
        $out = & $NodeExe (Join-Path $Root 'launch.js') @ArgList 2>&1
        $code = $LASTEXITCODE
        $text = ($out | Out-String).Trim()
        if ($null -eq $code) { return @{ ok = $false; text = ("命令没有返回退出码`r`n" + $text) } }
        return @{ ok = ($code -eq 0); text = $text }
    } catch {
        return @{ ok = $false; text = $_.Exception.Message }
    }
}

# ══════════════════════════════════════════════════════════════════════════
#  界面
# ══════════════════════════════════════════════════════════════════════════
$form = New-Object System.Windows.Forms.Form
$form.Text = 'AI 微信聊天机器人 · 控制台'
$form.Size = New-Object System.Drawing.Size(900, 700)
$form.StartPosition = 'CenterScreen'
$form.BackColor = [System.Drawing.Color]::FromArgb(26, 28, 32)
$form.ForeColor = [System.Drawing.Color]::FromArgb(226, 228, 232)
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
$form.MinimumSize = New-Object System.Drawing.Size(760, 560)

$title = New-Object System.Windows.Forms.Label
$title.Text = 'AI 微信聊天机器人'
$title.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 17, [System.Drawing.FontStyle]::Bold)
$title.ForeColor = [System.Drawing.Color]::FromArgb(240, 242, 246)
$title.AutoSize = $true
$title.Location = New-Object System.Drawing.Point(24, 16)
$form.Controls.Add($title)

$subtitle = New-Object System.Windows.Forms.Label
$subtitle.Text = "程序目录：$Root"
$subtitle.AutoSize = $true
$subtitle.ForeColor = [System.Drawing.Color]::FromArgb(138, 144, 156)
$subtitle.Location = New-Object System.Drawing.Point(26, 52)
$form.Controls.Add($subtitle)

# 状态条
$statusPanel = New-Object System.Windows.Forms.Panel
$statusPanel.Location = New-Object System.Drawing.Point(24, 82)
$statusPanel.Size = New-Object System.Drawing.Size(840, 56)
$statusPanel.BackColor = [System.Drawing.Color]::FromArgb(36, 39, 45)
$statusPanel.Anchor = 'Top,Left,Right'
$form.Controls.Add($statusPanel)

$dot = New-Object System.Windows.Forms.Label
$dot.Text = '●'
$dot.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 20)
$dot.AutoSize = $true
$dot.Location = New-Object System.Drawing.Point(14, 9)
$statusPanel.Controls.Add($dot)

$statusText = New-Object System.Windows.Forms.Label
$statusText.Text = '检查中…'
$statusText.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 12, [System.Drawing.FontStyle]::Bold)
$statusText.AutoSize = $true
$statusText.Location = New-Object System.Drawing.Point(46, 8)
$statusPanel.Controls.Add($statusText)

$statusSub = New-Object System.Windows.Forms.Label
$statusSub.Text = ''
$statusSub.AutoSize = $true
$statusSub.ForeColor = [System.Drawing.Color]::FromArgb(150, 156, 168)
$statusSub.Location = New-Object System.Drawing.Point(48, 32)
$statusPanel.Controls.Add($statusSub)

# 按钮辅助
function New-Btn {
    param($Text, $X, $Y, $W, $H, $Back, $Fore)
    $b = New-Object System.Windows.Forms.Button
    $b.Text = $Text
    $b.Location = New-Object System.Drawing.Point($X, $Y)
    $b.Size = New-Object System.Drawing.Size($W, $H)
    $b.BackColor = $Back
    $b.ForeColor = $Fore
    $b.FlatStyle = 'Flat'
    $b.FlatAppearance.BorderSize = 0
    $b.Cursor = 'Hand'
    $b.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10)
    return $b
}

$accent = [System.Drawing.Color]::FromArgb(64, 120, 220)
$danger = [System.Drawing.Color]::FromArgb(190, 70, 70)
$neutral = [System.Drawing.Color]::FromArgb(54, 58, 66)
$white = [System.Drawing.Color]::White
$light = [System.Drawing.Color]::FromArgb(220, 224, 230)

$btnStart = New-Btn '启 动' 24 154 150 46 $accent $white
$btnStart.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10, [System.Drawing.FontStyle]::Bold)
$form.Controls.Add($btnStart)

$btnStop = New-Btn '停 止' 186 154 130 46 $danger $white
$form.Controls.Add($btnStop)

$btnRestart = New-Btn '重 启' 328 154 130 46 $neutral $light
$form.Controls.Add($btnRestart)

$btnRefresh = New-Btn '刷新状态' 470 154 120 46 $neutral $light
$form.Controls.Add($btnRefresh)

$btnOpenCfg = New-Btn '打开配置目录' 602 154 130 46 $neutral $light
$form.Controls.Add($btnOpenCfg)

$btnClearLog = New-Btn '清屏' 744 154 120 46 $neutral $light
$form.Controls.Add($btnClearLog)

$logLabel = New-Object System.Windows.Forms.Label
$logLabel.Text = '运行日志（每 2 秒自动刷新）'
$logLabel.AutoSize = $true
$logLabel.ForeColor = [System.Drawing.Color]::FromArgb(150, 156, 168)
$logLabel.Location = New-Object System.Drawing.Point(26, 214)
$form.Controls.Add($logLabel)

$logBox = New-Object System.Windows.Forms.TextBox
$logBox.Multiline = $true
$logBox.ReadOnly = $true
$logBox.ScrollBars = 'Vertical'
$logBox.WordWrap = $false
$logBox.BackColor = [System.Drawing.Color]::FromArgb(16, 17, 20)
$logBox.ForeColor = [System.Drawing.Color]::FromArgb(188, 194, 204)
$logBox.Font = New-Object System.Drawing.Font('Consolas', 9)
$logBox.Location = New-Object System.Drawing.Point(24, 236)
$logBox.Size = New-Object System.Drawing.Size(840, 400)
$logBox.Anchor = 'Top,Left,Right,Bottom'
$form.Controls.Add($logBox)

$form.Add_Resize({
    $statusPanel.Width = $form.ClientSize.Width - 48
    $logBox.Width = $form.ClientSize.Width - 48
    $logBox.Height = $form.ClientSize.Height - 236 - 16
    $btnClearLog.Left = $form.ClientSize.Width - 144
    $btnOpenCfg.Left = $form.ClientSize.Width - 288
})

# ── 界面动作 ──────────────────────────────────────────────────────────────
function Append-Msg {
    param([string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return }
    $logBox.AppendText("$Text`r`n")
    $logBox.SelectionStart = $logBox.TextLength
    $logBox.ScrollToCaret()
}

function Update-Status {
    $s = Get-BridgeStatus
    if ($s.running) {
        $dot.ForeColor = [System.Drawing.Color]::FromArgb(90, 210, 150)
        $statusText.Text = "运行中（PID $($s.pid)）"
        $statusText.ForeColor = [System.Drawing.Color]::FromArgb(120, 225, 165)
        $statusSub.Text = '去微信给她发消息就行。关掉这个窗口不影响她运行。'
        $btnStart.Enabled = $false
        $btnStop.Enabled = $true
        $btnRestart.Enabled = $true
    } else {
        $dot.ForeColor = [System.Drawing.Color]::FromArgb(220, 90, 90)
        $statusText.Text = '已停止'
        $statusText.ForeColor = [System.Drawing.Color]::FromArgb(240, 130, 130)
        $statusSub.Text = if ($s.stale) { "上次的进程（PID $($s.pid)）已经不在了，点「启动」重新开" } else { '点「启动」开始运行' }
        $btnStart.Enabled = $true
        $btnStop.Enabled = $false
        $btnRestart.Enabled = $true
    }
    if (-not $NodeExe) {
        $btnStart.Enabled = $false
        $statusText.Text = '无法启动：找不到 Node.js'
        $statusText.ForeColor = [System.Drawing.Color]::FromArgb(255, 160, 90)
        $statusSub.Text = '请先安装 Node.js（https://nodejs.org）'
    }
}

function Set-Busy {
    param([bool]$On, [string]$What = '')
    foreach ($b in @($btnStart, $btnStop, $btnRestart, $btnRefresh)) { $b.Enabled = -not $On }
    if ($On) {
        $statusText.Text = "$What…"
        $statusText.ForeColor = [System.Drawing.Color]::FromArgb(150, 190, 255)
        $dot.ForeColor = [System.Drawing.Color]::FromArgb(150, 190, 255)
        [System.Windows.Forms.Application]::DoEvents()
    }
}

$btnStart.Add_Click({
    Set-Busy $true '正在启动'
    Append-Msg '──── 启动 ────'
    $r = Invoke-Launch @('--mode=chat')
    Append-Msg $r.text
    Start-Sleep -Milliseconds 800
    $s = Get-BridgeStatus
    if ($r.ok -and $s.running) { Append-Msg "✅ 启动成功，PID $($s.pid)" }
    elseif ($r.ok) { Append-Msg '⚠ launch.js 返回成功，但没检测到进程，请查看日志' }
    else { Append-Msg '❌ 启动失败，看上面的输出' }
    Set-Busy $false
    Update-Status
})

$btnStop.Add_Click({
    Set-Busy $true '正在停止'
    Append-Msg '──── 停止 ────'
    $r = Invoke-Launch @('--stop')
    Append-Msg $r.text
    Start-Sleep -Milliseconds 500
    Set-Busy $false
    Update-Status
    Append-Msg '已停止'
})

$btnRestart.Add_Click({
    Set-Busy $true '正在重启'
    Append-Msg '──── 重启 ────'
    $r = Invoke-Launch @('--restart', '--mode=chat')
    Append-Msg $r.text
    Start-Sleep -Milliseconds 1200
    $s = Get-BridgeStatus
    if ($s.running) { Append-Msg "✅ 重启完成，PID $($s.pid)" } else { Append-Msg '❌ 重启后没检测到进程' }
    Set-Busy $false
    Update-Status
})

$btnRefresh.Add_Click({
    Update-Status
    $logBox.Text = Read-LogTail 60
    Append-Msg ''
    Append-Msg "（已刷新 · $((Get-Date).ToString('HH:mm:ss'))）"
})

$btnOpenCfg.Add_Click({
    $dir = Join-Path $Root 'data'
    if (Test-Path $dir) { Start-Process explorer.exe $dir }
    else { [System.Windows.Forms.MessageBox]::Show("找不到 $dir", '提示') }
})

$btnClearLog.Add_Click({
    $logBox.Clear()
    Append-Msg '（已清屏，下面只显示操作记录；运行日志点「刷新状态」重新载入）'
})

# 定时刷新
$timerStatus = New-Object System.Windows.Forms.Timer
$timerStatus.Interval = 3000
$timerStatus.Add_Tick({ Update-Status })
$timerStatus.Start()

$timerLog = New-Object System.Windows.Forms.Timer
$timerLog.Interval = 2000
$lastLogText = ''
$timerLog.Add_Tick({
    # 只有用户没在手动翻看时才自动跟随（简单起见：始终跟随尾部）
    $t = Read-LogTail 60
    if ($t -ne $lastLogText) {
        $lastLogText = $t
        # 只在没有手动操作输出时覆盖；否则追加会造成混乱，所以直接替换
        if (-not $logBox.Focused) { $logBox.Text = $t }
    }
})
$timerLog.Start()

$form.Add_Shown({
    Update-Status
    $logBox.Text = Read-LogTail 60
    Append-Msg ''
    Append-Msg '──────────────────────────────────────────────'
    Append-Msg " 控制台已就绪（$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))）"
    if ($NodeExe) { Append-Msg " Node: $NodeExe" } else { Append-Msg ' ⚠ 找不到可用的 Node.js' }
    Append-Msg ' 这个窗口只用来操作，关掉它机器人照常运行'
    Append-Msg '──────────────────────────────────────────────'
})

$form.Add_FormClosing({
    $timerStatus.Stop()
    $timerLog.Stop()
})

[void]$form.ShowDialog()
