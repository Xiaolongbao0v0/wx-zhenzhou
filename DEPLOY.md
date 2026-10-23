# 部署指南（给 AI 或新手的完整流程）

> 这份文档的写法是给**执行者**看的——不管你是人还是 AI，照着往下做就能跑起来。
> 每一步都有可验证的成功标志，出错时有对应处理。

---

## 0. 先确认三件事

在开始之前，需要知道这些：

| 需要什么 | 从哪来 | 备注 |
|---|---|---|
| **DeepSeek API Key** | https://platform.deepseek.com | 形如 `sk-xxxxxxxx`，按量计费 |
| **一部能扫码的微信** | 你自己的手机 | 用来绑定 Bot |
| **Node.js 22+** | https://nodejs.org 或你机器上已有的 | 见下一步 |

**问用户要 API Key。** 没有它跑不起来。

---

## 1. 环境检查

```powershell
node -v
```

**期望**：输出 `v22.x` 或更高。

**如果没有 node**：

- 装了 DeepSeek Harness 的 Windows 机器，可以直接用自带的：
  ```
  %LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe
  ```
- 否则去 nodejs.org 装 LTS 版，装完**重开终端**再验证。

> 注意：有的机器上 `where node` 能找到，但它是个 0 字节的空文件。
> 判断标准是 `node -v` 能不能真的输出版本号。

---

## 2. 放置项目

把项目文件夹放到一个**非中文、无空格**的路径，例如：

```
D:\liaotian\wx-bridge
```

然后进入目录：

```powershell
cd /d D:\liaotian\wx-bridge
```

**验证**：`dir` 能看到 `src`、`personas`、`data`、`package.json`。

---

## 3. 初始化配置

```powershell
Copy-Item data\config.example.json data\config.json
```

**验证**：`data\config.json` 存在。

---

## 4. 写入 API Key

在 `data\apikey.txt` 里写一行 Key（**不要有引号、不要有空格**）：

```powershell
Set-Content data\apikey.txt -Value "sk-你的真实Key" -Encoding UTF8
```

**验证**：

```powershell
(Get-Content data\apikey.txt -Raw).Trim().Length
```

**期望**：大于 20。

> ⚠️ **不要把 Key 写进 `~/.dsh/.credentials.yaml`。**
> 如果这台机器装了 DSH 桌面端，它重启时会按自己的格式重写那个文件，把外加字段抹掉。
> 曾经因为这个坑导致机器人启动后"API Key 缺失"、所有回复失败。

---

## 5. 启动并扫码

```powershell
node launch.js --mode=chat
```

**期望看到**：

```
  wx-bridge  ·  微信 iLink Bot
  ─────────────────────────────────────────
  API Key  : 已就绪（...\data\apikey.txt）
  人设     : 1 个可用，默认 mahiru
  ...
  https://liteapp.weixin.qq.com/q/xxxxx?qrcode=...&bot_type=3
  有效期约 2 分钟，等待扫码中…
```

**把那个链接给用户，让他用手机微信打开并确认登录。**

链接 2 分钟过期，程序会自动换新的（最多 8 次），不用重启。

**登录成功的标志**：

```
登录成功  账号=xxxxx@im.bot
已上报上线通知
开始长轮询，等待微信消息…
```

凭证会存进 `data/credentials.json`，之后启动不用再扫。

---

## 6. 配白名单（必做）

登录后让用户**给 Bot 发一条消息**，日志里会出现：

```
收到  来自=xxxxx@im.wechat  类型=文本  内容="..."
```

把 `来自=` 后面那串复制出来，写进 `data\config.json` 的两个字段：

```json
{
  "allowedUsers": ["xxxxx@im.wechat"],
  "doUsers": ["xxxxx@im.wechat"]
}
```

**验证**：重启后启动横幅里应显示 `白名单 : 1 个用户`。

> **`allowedUsers` 留空 = 任何人给这个 Bot 发消息都会消耗你的 API Key。**
> 一定要填。

---

## 7. 端到端验证

让用户在微信里发一句：

```
在吗
```

**期望**：几秒内收到回复，且日志中出现：

```
收到  来自=...  类型=文本  内容="在吗"
已回复（1.2s，1 条，人设=mahiru）
```

**如果没回复**，看 `data\run.log` 最后几行。

---

## 完成标准

以下全部满足才算部署成功：

- [ ] `node -v` 输出 22+
- [ ] `data\config.json` 存在且 `allowedUsers` 非空
- [ ] `data\apikey.txt` 有 Key
- [ ] 启动横幅显示 `API Key : 已就绪`
- [ ] 启动横幅显示 `白名单 : 1 个用户`
- [ ] 日志出现 `开始长轮询`
- [ ] 微信发消息能收到回复

---

## 可选：启用 /do 干活能力

`/do 帮我写个脚本` 会拉起 DSH agent 真的执行。需要额外装 CLI：

```powershell
mkdir ..\dsh-cli
cd ..\dsh-cli
pnpm add "@deepseek-ai/dsh@0.2.1-rc.2"
```

**目录必须和 `wx-bridge` 同级**（代码按 `项目根/../dsh-cli/` 找）。

或者设环境变量：

```powershell
setx DSH_BIN "D:\liaotian\dsh-cli\node_modules\@deepseek-ai\dsh\lib\bin.js"
```

### 可能会踩的坑：Windows 沙箱权限

第一次跑 `/do` 自由任务可能报：

```
SetNamedSecurityInfoW failed (Win32 5): grantWrite(...\workspace)
```

原因：DSH 无法给受限令牌授予写权限。

修法（给项目父目录和工作区补当前用户的完全控制权）：

```powershell
icacls "D:\liaotian" /grant "%USERNAME%:(OI)(CI)F"
icacls "D:\liaotian\workspace" /grant "%USERNAME%:(OI)(CI)F"
```

`workspace` 不存在就先手动建一个。

---

## 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 启动即退出，日志「API Key : ⚠ 缺失」 | Key 没读到 | 检查 `data\apikey.txt`；或 Key 被写进了 `~/.dsh` 后被 DSH 重写掉 |
| 报 `EPERM` 打不开 `run.log` | 沙箱/权限 | 换个非系统保护的目录，或给目录权限 |
| 启动报「二维码过期」 | 正常 | 等它自动换新的，重新扫 |
| 微信发消息没反应 | 进程挂了 / 白名单不对 | `node launch.js --status` 看进程；看 `data\run.log` 最后一行 |
| 日志 `errcode -14` | 登录失效 | `node launch.js --restart --login` 重新扫码 |
| 回复报错 | 模型调用失败 | `data\logs\failed-*.log` 有完整输出 |
| 一条消息发 4 条以上的气泡 | `maxBubbles` 太大 | 调 `data\config.json` 的 `maxBubbles` |

---

## 日常运维

| 目的 | 命令 |
|---|---|
| 启动 | `node launch.js --mode=chat` |
| 状态 | `node launch.js --status` |
| 停止 | `node launch.js --stop` |
| 重启 | `node launch.js --restart --mode=chat` |
| 看日志 | `Get-Content data\run.log -Encoding UTF8 -Tail 40 -Wait` |

> ⚠️ **不要用 `Stop-Process -Name node`**，会误杀别的 node 程序（比如 DSH 桌面端）。
> 只用 `launch.js --stop`，它按 PID 精确停。

---

## 改人设

`personas\mahiru.md` 是纯文本，改完**存盘即生效**，不用重启。

想验证改得对不对，跑测试脚本：

```powershell
node tools\scenario-test.mjs
```

---

## 不要做的事

- ❌ 不要把 `data/` 提交进 git（里面有登录凭证和 Key）
- ❌ 不要把 Key 写进 `~/.dsh/.credentials.yaml`
- ❌ 不要用 `Stop-Process -Name node`
- ❌ 不要把 `allowedUsers` 留空
