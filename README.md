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

## 当前能力（2026-10-29）

| 能力 | 做法 | 关键开关 |
|---|---|---|
| 人设 | `personas/*.md`，每轮注入，存盘即生效 | `defaultPersona` / 微信里 `/role` |
| 短期记忆 | 最近 N 轮原话 + 更早压成摘要 | `historyRecentTurns` |
| 场景记忆 | 记住"你俩正在聊哪件事"，几小时内不断片 | `sceneEnabled` / `sceneTtlMinutes` |
| **长期事实** | 定期从对话里抽"关于他的稳定事实"，存 `data/profile/`，跨天不忘 | `profileEnabled` / `profileDistillMinutes` |
| **旧事检索** | 聊天归档转成 md 知识库，BM25 检索，回答"我们以前说过…" | `vaultPath` / `ragMinScore` |
| **识图** | 收到图先变成客观描述再回；没配方舟 Key 就用主模型看图 | `visionEnabled` |
| 联网搜索 | 说到"今天/最新/查一下"自动搜，带预算闸 | `searchHourlyLimit` |
| **节奏** | 气泡停顿按字数折算打字时间；12% 概率先晾几秒；30% 概率先冒个泡 | `bubbleGapMode` / `replyDelayChance` / `ackChance` |
| **连发合并** | 你连发几句，她看完一起回，不各答各的 | 无（自动） |
| 主动消息 | 静默一段时间后自己找你，可能顺口提一件旧事 | `proactive` / `proactiveRecallChance` |
| 情绪 | 判定当下情绪，影响颜文字/表情包/语气 | `kaomojiChance` / `emojiChance` |
| 表情包 | 按情绪发图（`allowStickers` 关掉就纯文字） | `allowStickers` |

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
| `node src/index.js --mode=chat` | **默认**：直连 API 聊天，只带人设+历史，快且省（约 2 秒/条） |
| `node src/index.js --mode=dsh` | 交给 DSH headless 处理，能调工具但每条约 7000~17000 tokens |
| `node src/index.js --mode=echo` | 回声模式：收到什么回什么（排查链路用） |
| `node src/index.js --login` | 强制重新扫码登录 |
| `node src/index.js --logout` | 清除登录凭证 |
| `node src/index.js --verbose` | 打印更多细节 |

### Bot 里能用的指令

| 指令 | 作用 |
|---|---|
| `/new` 或 `/clear` | 清空对话上下文（Bot 会忘记前面聊过什么，但长期事实档案还在） |
| `/role <名字>` | 换人设；`/role off` 关掉人设 |
| `/节奏 <快/中/慢>` | 调气泡之间的停顿（700~5000ms），嫌慢嫌急就用这个，不用改配置 |
| `/条数 <n>` | 一次回复最多拆几条 |
| `/库` | 看知识库状态：目录、片段数、检索阈值、自测结果 |
| `/场景` | 看当前在聊哪件事、聊到第几轮 |
| `/忙` `/闲` | 标记忙碌/空闲，影响她主动找你的频率 |
| `/sticker` | 表情包开关与分类列表 |
| `/搜 <关键词>` | 手动搜一次，不走自动判断 |
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

**5. 每个用户一条串行队列，但会合并未读**

同一个人连发多条消息时按顺序处理，不会并发把机器打满。不过不是"一条一条回"——处理期间进来的消息先攒着，这一轮结束后合成一次请求回掉。逐条回会变成客服按工单处理的样子，正常人是一次看完一起说。

---

## 六、已知限制

这些是**目前的天花板**，不是坏了：

- **只支持 1:1 私聊**，没有群。iLink API 本身不支持群聊。
- **主动消息依赖旧的 `context_token`**。iLink 官方要求 token 来自用户消息，隔太久（`proactiveContextTtlMinutes`）就会发送失败。
- **知识库语料只有文字**。聊天归档转出来的 md 不含图片，图片靠识图那一步临时看。
- **语料量决定检索质量**。刚接入时只有几天记录，问很久以前的事大概率捞不到；越聊越准。
- **节奏类改动无法用盲测验证**。实验台只读文本，看不见气泡间隔和打字速度，这部分只能靠真实聊天体感判断。
- **单进程、无健康监控**。服务挂了或 API 欠费，不会主动通知你，需要自己看日志。
- **成本不透明**。日志里没有 token 统计，花了多少只能看 DeepSeek 后台。

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

## 八、下一步

按性价比排（前面的更值钱）：

1. **偶尔不回消息**。正常人会漏看、会忘、会因为话题自然结束就不接了。现在她永远都回，这是最后一块"太像客服"的地方。做法上要能区分"该不该接"：纯感叹不该接，问句必须接。
2. **健康监控**。systemd 挂了、API 欠费、连续发送失败，现在都得你自己发现。加个定时检查 + 告警（邮件或另一个渠道）。
3. **成本可见**。日志里记 usage，按天汇总，知道一天花多少钱。
4. **主聊天关思考**。实测同一请求关掉思考后 1.4s→0.33s、推理 token 110→0，但说话的味道可能受影响，得先做对照实验。
5. **情绪判定改用模型**。现在是正则表，判得宽（多轮/边界场景容易误判 sad），但表情注入依赖它，改之前必须做 A/B。

至于老的"路线 C"（DSH 常驻服务）：默认模式早就换成直连 API 了，DSH 只在需要调工具时才用，这个改造已经没必要。
