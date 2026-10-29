# wx-bridge

用**手机微信**直接跟 **DSH** 聊天。

```
手机微信
   │  你给 Bot 发消息
   ▼
微信 iLink Bot 服务器（官方，https://ilinkai.weixin.qq.com）
   │  wx-bridge 长轮询取消息
   ▼
本机 wx-bridge
   ├─ 维护对话记忆（headless 是一次性的，上下文靠这里）
   ▼
dsh --profile headless "<你的话 + 上下文>"
   │  跑完返回最终答案
   ▼
回复发回你的微信
```

**这不是 hook 你的个人微信账号**，是微信官方的 iLink Bot API——扫码登录后你在微信里多了一个可聊天的 Bot 联系人。不封号。

---

## 一、启动

```bash
cd D:\wx-bridge
node src/index.js --mode=dsh
```

首次运行会打印登录链接，**用手机微信打开并确认**。凭证存到 `data/credentials.json`，之后启动自动复用，不用再扫码。

看到下面这样就绪：

```
[时间] 复用已有凭证  账号=xxxxx@im.bot
[时间] 开始长轮询，等待微信消息…
```

然后在手机微信里给 Bot 发消息即可。

**关掉终端窗口 = 停止服务。**

---

## 二、常用参数

| 命令 | 作用 |
|---|---|
| `node src/index.js --mode=dsh` | 正常模式：消息交给 DSH 处理 |
| `node src/index.js --mode=echo` | 回声模式：收到什么回什么（排查链路用） |
| `node src/index.js --login` | 强制重新扫码登录 |
| `node src/index.js --logout` | 清除登录凭证 |
| `node src/index.js --verbose` | 打印更多细节 |

### Bot 里能用的指令

| 指令 | 作用 |
|---|---|
| `/new` 或 `/clear` | 清空对话上下文（Bot 会忘记前面聊过什么） |
| `/help` | 显示帮助 |

---

## 三、配置

改 `data/config.json`（首次启动自动生成）：

```json
{
  "allowedUsers": [],
  "agentPreset": "standard",
  "taskTimeoutMs": 180000,
  "maxQueuePerUser": 3,
  "sendTyping": true,
  "workdir": ""
}
```

| 字段 | 说明 |
|---|---|
| `allowedUsers` | **建议设置**。只响应白名单里的微信用户 id，留空则任何能给 Bot 发消息的人都能用 |
| `taskTimeoutMs` | 单个任务超时毫秒数，超时会被杀掉 |
| `maxQueuePerUser` | 同一用户排队上限，防止连发把机器拖垮 |
| `sendTyping` | 是否发"正在输入"状态 |
| `workdir` | DSH 任务的工作目录，留空用本项目目录 |

**怎么拿到自己的微信 id**：发一条消息，日志里会显示 `来自=xxxxx@im.wechat`，复制过来填进 `allowedUsers`。

---

## 四、目录结构

```
wx-bridge/
├── src/
│   ├── ilink.js      微信 iLink Bot 协议层（扫码/长轮询/发消息）
│   ├── dsh.js        DSH 运行时（spawn headless 子进程）
│   ├── memory.js     对话记忆（每人一份历史，保留最近 6 轮）
│   ├── config.js     配置读取
│   └── index.js      主程序
└── data/
    ├── credentials.json   登录凭证（0600 权限，含 token，别外传）
    ├── config.json        运行配置
    ├── memory/            各用户的对话历史
    ├── dsh-home/          桥自带的 DSH 主目录
    └── logs/              失败的完整输出
```

---

## 五、几个设计决定（为什么这么写）

**1. iLink 协议是自己实现的，没用 Wechaty**

协议端点逆向自 `wechaty-puppet-claw-wechat@0.0.10` 源码，但用原生 `fetch` 重新实现，**零外部依赖**。好处是不用装 `@juzi/*` 那一大套，也不用担心它的版本更新把你的东西搞坏。

**2. 桥自带 DSH 主目录（`data/dsh-home`）**

DSH 默认要往 `~/.dsh/profiles/` 写文件。在某些受限环境下（沙箱、只读配置、杀软锁文件）这会报 `EPERM`。把 home 挪进项目内，桥就完全自包含，不会因为外部目录权限而挂掉。API Key 由桥自己从 `~/.dsh/.credentials.yaml` 读出后通过环境变量传给子进程。

**3. 子进程输出走文件而不是管道**

受限环境下 Node 无法创建匿名管道，`spawn` 用默认 `stdio:'pipe'` 会直接抛 `EPERM`。实测只有 `inherit` / `ignore` / 文件描述符可行。这里把 stdout 和 stderr 都绑到一个临时文件的 fd 上。

**4. 上下文记忆是自己维护的**

`headless` 是一次性任务、跑完就退出，不保留会话。所以每轮问答存在 `data/memory/<哈希>.json`，下次组装任务时把最近 6 轮塞进提示词。这也是为什么 `/new` 能生效——它只是清了这个文件。

**5. 每个用户一条串行队列**

同一个人连发多条消息时按顺序处理，不会并发把机器打满。

---

## 六、已知限制

这些都是**没做**的，不是坏了：

- **Bot 不能主动找你**。iLink 的硬限制：所有发送都需要 `context_token`，而它来自你发的第一条消息。它不能主动发起会话。
- **只支持 1:1 私聊**，没有群。iLink API 本身不支持。
- **只处理文字**。图片、语音、文件还没接（协议里有 `getuploadurl` / CDN 下载接口，做起来不难，只是路线 A 没做）。
- **每条消息 spawn 一个 DSH 进程**，约 2-3 秒。这是路线 A 的代价，升级到路线 C（SDK JSON-RPC 常驻服务）可以做到亚秒级且有原生会话。
- **记忆是简单的最近 N 轮**，不是 DSH 的原生会话压缩，长对话会丢早期内容。

---

## 七、排查

| 现象 | 原因与处理 |
|---|---|
| 启动报 `二维码过期` | 正常，会自动重取，最多 8 次。重新扫码即可 |
| 回复 `处理失败：DSH 退出码 1` | 错误信息里会带 DSH 的真实输出。完整日志在 `data/logs/failed-*.log` |
| 报 `缺少 context_token` | iLink 限制，必须先由用户发消息给 Bot |
| 重启后要重新扫码 | 凭证过期了（errcode -14 会自动触发重新登录） |
| 想换 key | 设环境变量 `DEEPSEEK_API_KEY` 后重启，优先级高于凭证文件 |
| 想用别的 DSH 主目录 | 设 `WX_DSH_HOME` 环境变量 |

---

## 八、下一步（路线 C）

路线 A 的瓶颈是"每条消息一个进程"。升级到路线 C 的做法：

DSH 有 `dsh-sdk-jsonrpc-server`，按换行分帧的 JSON-RPC 2.0，**一个常驻服务带多轮会话**。届时只需替换 `src/dsh.js` 里 `runTask` 的实现，`index.js` / `memory.js` 都不用动——这也是当初把运行时单独拆一个文件的原因。
