# Evo-Pi 设计文档 v2（Build-First）

| 元数据 | 值 |
|---|---|
| 状态 | Draft |
| 版本 | 2.0 |
| 日期 | 2026-07-13 |
| 前版 | [evo-pi-design-v1-full.md](./evo-pi-design-v1-full.md)（完整协议版，作为长期北极星与升级参考） |

## 0. v2 的设计立场

v1 是一份"为对抗性审计而写"的设计：40+ 内容寻址协议对象、两级 provider permit、统计后验发布门、saga 发布事务。审计结论指出三个致命问题：

1. **证据供给矛盾**：单用户日常 workload 撑不起 `P(quality_delta ≥ -ε) ≥ 0.99` 这类统计门，自动发布路径实际永远走不通；
2. **复杂度与威胁错配**：第一版的 Meta 只是一个改 prompt 的订阅 coding agent，防御机制却按对抗性超级优化器设计；
3. **首个价值闭环太深**：第一个候选发布前要建完整个控制面，数月工程换一次 prompt 段落调整。

v2 直接重写为"为被构建而写"的设计。五条原则：

1. **相信模型**。所有判断类工作——发现要优化什么、决定怎么优化、评价好不好、试用后回顾——由 LLM 直接阅读原始记录完成，产出**给人看的备忘录**，不做预定义分类 schema、优先级公式和统计门。
2. **机制只兜底三件事**：不可变版本 + 原子回滚；数据/代码分界；人批一次（对话式）。这三件是 v1 中真正值得硬编码的骨架，其余都可以是提示词。
3. **评价是给人的证据，不是自动门**。LLM-as-judge 是顾问，人是唯一 gate，试用期 + 一键回滚是兜底。判断错了的成本被可逆性吃掉，而不是被事前验证吃掉。
4. **每个里程碑 ≤ 2 周且独立有用**。Recorder 建成当周就要产出"我的 agent 这周哪里反复出错"的报告。
5. **复杂机制推迟到风险真实出现**。第 9 节升级路径表逐条写明"什么信号出现时，把 v1 的哪个机制请回来"。

### 0.1 外部佐证：Hermes 的做法

Nous Research 的 Hermes Agent（2026-02 开源）及其 `hermes-agent-self-evolution` 框架验证了这条路线可行：

- **信号**：直接读执行 trace，让模型理解"为什么失败"而不只是"失败了"；
- **生成**：GEPA 反思式变异——LLM 读 trace 提出针对性改动，不做随机搜索；
- **评价**：从 trace 生成小 eval 集 + 测试套件 100% 通过 + 确定性约束门（skill ≤15KB、工具描述 ≤500 字符、缓存兼容），Pareto 保留多个候选；**没有统计后验**；
- **发布**：全部走 PR 人审，绝不直接提交；
- **优化面**：分阶段扩大——先 skill（纯数据），再工具描述，再 system prompt 段落，最后才是工具代码。"Skills are data, not code"。

这与 v2 的设计逐条对应（见 §4.6），差异主要在：我们以本地 bundle + 指针回滚代替 PR 流程，并增加试用期回顾，因为我们的目标是个人日常 agent 而非开源仓库。

## 1. 架构总览

```text
                        Human（唯一 gate）
                             │
              TUI 提示 ←──── │ ────→ /evo permit 对话式审批
                             │
┌────────────────────────────┴───────────────────────────────┐
│                     packages/evo（一个库 + CLI，无常驻进程）  │
│                                                             │
│  Recorder        Bundle Registry      Reflector    Critic   │
│  (extension)     (文件 + 指针 + 锁)    (Meta-Pi run) (judge)  │
└──────┬──────────────────┬──────────────────┬────────────────┘
       │                  │                  │
   Pi Worker          stable pointer     headless Pi
   (日常使用)          原子 rename        (RPC/SDK, 定时或手动)
       │                  │                  │
       └────── JSONL 记录 + artifacts ───────┘
```

四个组件、一个 CLI，没有独立 Supervisor 进程：

| 组件 | 形态 | 职责 |
|---|---|---|
| Recorder | coding-agent extension | 只读记录会话、工具、结果、反馈；不做任何实时判断 |
| Bundle Registry | 文件目录 + 指针文件 + 文件锁 | 不可变 bundle、stable 指针、原子切换、回滚、历史 |
| Reflector | headless Pi run（手动或 quiet hours 定时） | 读记录 → 找痛点 → 写提案（含 diff） |
| Critic | 独立上下文的一次 judge run | 反驳式评审提案，写备忘录给人 |
| `/evo` CLI | extension 命令 + 本地库调用 | status / report / improve / permit / rollback 等 |

v1 中的 Supervisor 职责退化为：CLI 里的几个确定性函数（校验、指针切换、journal 写入）+ 文件锁。

## 2. 记录（Recorder）

### 2.1 原则

- **只记录，不判断**。实时路径上没有 feedback classifier、episode linker、opportunity detector；所有解读推迟到 Reflector 分析时进行，且分析产物（annotation）与原始记录分开存放，永不覆写原始记录。这是从 v1 保留的"raw fact append-only"原则，但去掉了协议机器。
- **session 即边界**。MVP 用 session 近似 episode，不做 linker。跨 session 的目标归属由 Reflector 阅读时自行判断。

### 2.2 记录内容

每个 session 一个 JSONL 文件，大对象（完整 diff、长工具输出）落到 `artifacts/sha256/` 只存引用：

```text
- 用户消息 / assistant 消息（含时间）
- tool call + result（截断 + artifact 引用）
- 验证类命令的退出码（test/lint/build，按命令名启发式识别）
- session 结束时的 git diff（若在 repo 内）
- provider usage（input/output/cache tokens，仅观测）
- 当前生效的 bundle digest
- 显式反馈：/evo note、用户说"以后都这样"之类被 extension 捕获的指令 → 追加到 inbox/
```

### 2.3 实现接入点

用 v1 §22.3 已核实的公开 seam，不打 core patch：

- extension 订阅 message/tool/session 事件 + `AgentSession.subscribe()`；
- 轻量引用走 `pi.appendEntry()`（不进入模型上下文）；
- cache 观测直接复用 usage 字段的粗粒度统计即可；v1 P0/P1 那套逐请求 correlation 只有在将来真的做 cache 优化候选时才考虑。

**验收**：关闭 extension 后 Pi 行为不变；开启后一次任务的输入、工具、验证结果、diff、纠正轮次能被人工串起来读懂。

## 3. Bundle 与激活/回滚

### 3.1 Bundle 结构

Bundle 是一个纯数据目录，被唯一固定的 `EvoPolicyRuntime` extension 解释：

```text
bundles/<digest>/
  bundle.json          # lock：文件清单 + 各文件 sha256 + parent digest + 一句话说明
  prompts/*.md         # system prompt 分段（含稳定前缀/动态后缀标记）
  skills/*/SKILL.md    # 技能（Hermes 同款思路：skill 是数据）
  policy.json          # context 选择、模型路由、验证策略等声明式参数
  memory/*.md          # 用户偏好与长期事实
```

`digest = sha256(canonical(bundle.json))`。bundle 不可变；任何修改产生新 digest。

### 3.2 数据/代码分界（保留 v1 的核心洞察）

- bundle 内**只允许 schema 校验通过的 markdown/json**；出现任何 JS/TS、可执行文件、新依赖、任意 shell 命令，编译直接拒绝；
- 想改代码（工具、hook、runtime，乃至 Evo 自身）走**代码提案流程**：Reflector 在隔离 worktree 出 git branch，人看完整 diff 后自己合并。代码永远不进自动 apply 路径；
- **代码合并 ≠ 功能生效**：`policy.json` 维护启用的 tool/hook 清单（数据）。新功能合并后处于休眠状态，"启用它"是一次普通的 data 提案，仍走指针切换 + trial + 回滚——功能坏了不用 revert 代码，切回指针即可下线；
- `EvoPolicyRuntime` 是人工审查、版本固定的唯一解释器，候选不为它生成新代码。

这就是 v1 的 S0–S5 分级压缩成的三档：**数据（可自动 apply）/ 代码（人合并）/ 核心（不碰）**。

### 3.3 激活与回滚

```text
registry/
  stable               # 内容为当前 stable 的 bundle digest
  trial.json           # 可选：{digest, parent, startedAt, plan} 试用标记
  history.jsonl        # append-only：谁、何时、从哪个到哪个、为什么
```

- 新 session 启动时 launcher 读 `stable`（或 trial）指针，整个 session pin 住该 digest，不热切换；
- 切换 = 临时文件 fsync + 原子 rename，单指针，无 saga；
- `/evo rollback [digest]` 一条命令回滚，默认回 parent；保留最近 K 个 bundle 可启动；
- history 是 append-only 的 journal，同时充当 v1 的 audit ledger 和 decision journal（记录提案结论，供 Reflector 去重）。

## 4. 优化循环

这是回答"怎么判断需要优化、怎么生成优化、怎么评价"的核心章节。总览：

```text
observe（Recorder 持续记录）
  → reflect（Reflector 读记录，找痛点，引用证据）
  → propose（每个痛点一份单轴提案，含 diff）
  → check（L1 确定性门 + L2 场景重放 + Critic 备忘录）
  → permit（TUI 提示 → /evo permit 对话式人批）
  → apply（编译 → 新 digest → 指针切换 → journal）
  → trial（试用标记，正常使用 1 周 / K 个 session）
  → retrospect（Reflector 写前后对比回顾 → 人 keep 或 rollback）
```

其中 check 与 permit 的重量按提案分档裁剪（§4.3）：T0 一行提示 Enter 即过，T1 一页卡片，T2 才有重放与对话审批。

### 4.1 判断"要优化什么"：Reflector

**不做** opportunity schema、优先级公式、实时分类器。做法：

- 触发：`/evo improve` 手动触发，或 quiet hours 每晚最多一次；
- 输入：上次 review 以来的 session JSONL + `inbox/`（显式反馈）+ `history.jsonl`（历史提案与结局）+ 当前 bundle；
- 固定 role prompt，要求模型完成：
  1. 通读记录，识别重复出现的问题：用户纠正、同类失败、浪费的轮次、缺失的偏好/知识、明显低效的流程；
  2. 区分"agent 的错"与"需求本来就变了"——这是 v1 §14.9 反复强调的，v2 把它作为 prompt 中的一条指令而不是分类协议，相信模型读上下文的能力；
  3. 输出 `observations.md`：痛点榜单，每条**必须引用具体 session 与消息位置**作为证据。

两条 grounding 规则（写进 prompt，也是 permit 时人核查的点）：

- 一个痛点必须有 **≥2 次独立出现**的记录引用，或 1 次用户显式指令（"以后都这样"）；
- 必须先查 journal，**不重提已被拒绝或已回滚的同类方案**（失败也是资产，v1 §13.5 的极简版）。

痛点不是唯一入口。**显式功能请求**——用户在对话中说"帮我做一个 X"（被 Recorder 捕获进 inbox），或直接 `/evo request "描述"`——跳过"≥2 次出现"规则，直接进入提案。新功能几乎总是 code，走 T2 与代码提案流程（§3.2）。

### 4.2 判断"怎么优化"：Proposal

Reflector 从榜单取 top 1–2 个痛点，每个产出一份提案。**默认单轴**（一份提案只改一类东西），这是 v1 组合交互分析压缩后剩下的唯一规则——单轴改动人能看懂、坏了能归因。

```ts
interface Proposal {
  id: string;
  createdAt: string;
  parentBundleDigest: string;
  kind: "data" | "code";           // 由实际 diff 内容自动判定，不由 Reflector 自报
  tier: "T0" | "T1" | "T2";        // 审批档位，同样由 CLI 从 diff 判定（§4.3）
  motivation: string;              // 痛点描述 + 记录引用（session/位置）
  diff: string;                    // data: bundle 文件 diff；code: branch 名 + diff
  expectedEffect: string;
  risk: string;
  verifyPlan: string;              // L2 用哪些场景验证
  trialPlan: string;               // 试用多久、看什么信号
  status: "pending" | "approved" | "rejected" | "trialing"
        | "kept" | "rolled-back";
}
```

保留 v1 的一条重要防线：`kind` 与 `tier` 由 CLI 检查实际 diff 判定（碰了 markdown/json 以外的东西就是 code），不信 Reflector 的自我声明；模型可以建议更严的档位，不能建议更松的。

### 4.3 分档：哪些一键过，哪些严格审

不同改动的错误成本与可验证性差别很大，用同一条审批流程会把便宜的事做贵。提案分三档，**档位由 CLI 从实际 diff 确定性判定**——判不进 T0/T1 的一律 T2（default-deny 向上不向下）：

| 档 | 覆盖 | 判定条件（CLI 可证明） | 验证 | 人批形式 |
|---|---|---|---|---|
| **T0 一键确认** | KV cache / token 布局优化；用户显式偏好直录 | 重排类 或 直录类（见下） | 仅 L1 | TUI 一行提示，Enter 应用 |
| **T1 轻审批** | 其余 data 改动：prompt 措辞、新 skill、context 参数 | kind=data 且不触 core 资产 | L1 + Critic desk review；真正评价靠 trial | 一页卡片，Enter 通过 |
| **T2 严格审批** | 所有 code；core 资产（system contract 核心段、模型路由、验证策略） | kind=code，或 diff 触及 `tier: core` 标记 | L1 + 场景重放 + Critic + trial | `/evo permit` 对话式审批 |

T0 的两个可证明条件：

- **重排类**（省 KV cache 的典型场景）：编译器证明新旧 bundle 的**规范化内容 digest 集合完全相同**，diff 只改变顺序、分段边界或稳定前缀/动态后缀的归属。语义近似不变，收益确定性可测（前缀稳定性、cache-read token 计数），不需要任何 LLM 评审——人看一行说明按 Enter 即可。
- **直录类**：新增 memory/preference 的内容能**逐字追溯**到 transcript 中用户的显式消息（recorder 保有原文引用），且只增不删既有条目。用户已经说过的话，不需要再验证一遍。

bundle 内资产可带 `tier: core` 标记（system contract 核心段、模型路由与验证策略、Reflector/Critic 提示词）；diff 触碰它们自动升 T2。模型可以建议升档，不能建议降档。

注意 T0 **按可证明性质定义，不按用途枚举**：cache 只是重排类里最常见的例子。任何满足"L1 能证明语义等价 + 收益可确定性度量"的改动（工具目录排序稳定化、稳定内容归位到稳定段、分段边界调整……）都自动落入 T0；实现时不得把 T0 写成按优化目标枚举的白名单。

### 4.4 评价：按档取层，没有统计门

**L1 确定性检查（所有档，自动，秒级）**
bundle schema 校验、编译、尺寸上限（借 Hermes 的经验值：单 skill ≤15KB、prompt 段落有 token 预算）、内容集合对比（T0 重排类的判定依据）；code 提案跑 lint + 相关测试。不通过直接打回 Reflector。

**L2 Critic 评审（T1 只做 desk review；T2 加场景重放）**
一个**独立上下文**的 Critic run，固定任务是**反驳**：改动会伤害其他场景吗？证据引用是真的吗（抽查）？期望效果兑现了吗？产出一页 `review.md` 给人。重放的省 token 做法见 §4.5。

诚实边界（v1 §14.4 的教训，一句话版）：没有 workspace snapshot 就没有忠实的过程重放——所以重放一律"只生成、不执行"（§4.5），验证的是首步决策与表达；完整解决过程的证据只能来自 L3 试用，不伪装成受控实验。防自评偏置只用两招：**Critic 独立上下文** + **反驳式提示词**，不搞多裁判投票。

**L3 试用期回顾（T1/T2；T0 不设）**
真实使用本来就要花 token，因此这是**零边际成本的评价**——T1 的主要评价就是它：

- 批准后新 digest 带 trial 标记上线，正常使用 1 周或 K 个 session（`trialPlan` 指定）；
- 到期 Reflector 写 `retrospective.md`：对比试用前后的纠正次数、显式抱怨、revert、任务完成体感——**有数字用数字，没数字用引用记录的判断**，不硬造统计量；
- 人一条命令 keep 或 rollback；试用期内任何时候 `/evo rollback` 立即生效。
- T0 不设试用期：效果确定性可测（cache 指标），指标不对直接回滚。

LLM-as-judge 在这套设计里的定位：**备忘录作者，是给人的顾问，不是自动 gate**。唯一的自动 gate 是 L1；唯一的最终 gate 是人。

### 4.5 严格验证（T2）的省 token 做法

重放不等于重跑整个 session。按成本从低到高逐级升级，Critic 判断够了就停：

1. **Desk review（零重放 token）**：Critic 只读 diff + 提案引用的原始 trace 判断改动。多数 prompt 类改动到这层就够。
2. **单点反事实重放（默认重放形态，只生成、不执行）**：取痛点发生的那一轮，以当时的 transcript 为共享前缀 fork 对话，只重生成分叉的那一轮——old/new bundle 各一次，**不执行任何工具调用**。Critic 对比这一轮的两个输出：最终回答，或"打算采取的行动"（工具调用意图、计划）。因为不执行，此法天然零副作用，对涉及工具的场景同样适用——但只能验证**首步决策**是否变好，不能验证完整解决过程（fork 只复制对话不复制 workspace，工具链一旦需要真实执行就无法忠实延续，完整过程交给 trial）。
   cache 节省来自 **old/new 背靠背执行**：第一次全价写入前缀缓存，第二次以 cache-read 价读取（历史 session 的缓存早已过期，不存在"接着用"）。provider 差异（源码已核实）：Anthropic 按内容前缀缓存，与 session 无关，fork 重放天然可复用；OpenAI Codex 的 `prompt_cache_key` 由 session ID 生成（`openai-codex-responses.ts`），fork 产生新 ID——重放时需透传原 session identity，或接受略高成本。
3. **批量场景重放（3–10 个）**：仅重大 core 改动使用；场景 back-to-back 连续执行，在 cache TTL 内复用稳定前缀。
4. **裁判分档**：Critic 默认用低价模型/低 thinking 初筛，结论存疑或改动触 core 时才用强模型复核一次。

### 4.6 人批：按档的三种形态

- **T0**：TUI 状态栏/内联一行提示，例如 `evo: 建议把 repo context 移入 session-stable 段（内容不变，预计 cache read ↑）[Enter 应用 / d 详情 / x 忽略]`。Enter 即切指针；仍写 journal、仍可一键回滚。
- **T1**：`/evo permit` 打开一页卡片（动机 + 证据引用 + diff + trial 计划 + desk review 结论），Enter 通过；可选追问进入对话。
- **T2**：完整对话式审批——追问"为什么"（Meta 引用具体 trace 回答）、**当场要求修改**（"方向对，但别改 X，只改 Y"，Meta 现场修订 diff，L1 重新校验）、最后 approve / reject / defer。approve 时 CLI 对最终 diff 计算 digest 写入 journal，改一个字节就要重批。

通用规则：有 pending 提案时状态栏只显示提示（如 `evo: 2 pending`），不弹窗打断当前任务；reject 理由写入 journal，成为 Reflector 的去重输入；approve → L1 重验 → 编译 → 原子切指针（T1/T2 带 trial 标记）→ journal。代码提案的 approve 不自动合并——人看完整 diff 后自己合并 branch。

**自我完善的边界**：Evo 自身的代码（Recorder、CLI、EvoPolicyRuntime）同样可以由模型起草 T2 代码提案——它们不是裁判，只是基础设施，安全由"人合并"保证。真正人独占、永不进任何提案流程的只有两样：**裁判提示词（`prompts/`）** 和 **apply/rollback 通路（registry 写入路径）**。这是 v1 Constitution Core 收缩到 v2 后的最终形态：被告可以给法院提装修建议，但不能写判决书模板，也不能碰执行庭。

分档默认可再配置：例如把 T0 直录类设为全自动（连 Enter 都不要，journal 留痕），或把某个高风险 repo 的所有改动强制 T2。

这三档替代了 v1 的 ApprovalPolicy 矩阵、standing/exact grant、ActionGateProfile 偏序编译器：standing approval 的对应物是 T0/T1 的 Enter 与可配置自动；exact approval 的对应物是 T2 的"批的就是这个 diff digest"。

### 4.7 预算与调度（替代 Plan Broker）

- Reflector/Critic 只在 quiet hours 或手动触发时运行，每天默认最多 1 次完整循环；
- 启动前检查前台活跃度（最近 X 分钟内有无 session 文件更新），活跃则不启动；
- 无 lease、无 permit、无容量估计；token 用量只记录、只在周报里展示；
- 用户随时 `/evo pause` 停掉一切后台运行。

**订阅前提**：全部模型调用经 Pi 现有 provider adapter 走订阅 OAuth（Anthropic Claude plan：`utils/oauth/anthropic.ts`；OpenAI Codex plan：`utils/oauth/openai-codex.ts`，均已内建）；Evo 不引入 embedding、外部 LLM 服务或任何独立 API-key 依赖，Recorder/L1/registry/判档零模型调用。若同时持有两家订阅，可把 Worker 与 Reflector/Critic 分别放到不同订阅（headless run 指定另一家模型即可）——零机制成本地获得 v1 "separate pool" 的前后台硬隔离效果。

单订阅、后台每天一次 run 的量级下，这就够了。多订阅硬隔离、后台大规模搜索出现时再升级（见 §9）。

### 4.8 与 Hermes 的对照

| 环节 | Hermes self-evolution | Evo-Pi v2 |
|---|---|---|
| 信号 | 执行 trace（理解为什么失败） | session JSONL + 显式反馈 inbox |
| 找机会 | GEPA 反思读 trace | Reflector 固定 prompt 读记录，引用证据 |
| 生成 | 反思式定向变异 | 单轴 Proposal + diff |
| 自动门 | 测试 100% + 尺寸/缓存约束 | L1 schema/编译/尺寸/测试 |
| 评价 | trace 生成的 eval 集 + Pareto | L2 场景重放 + 反驳式 Critic 备忘录 |
| 人审 | PR，绝不直接提交 | 分档人批：T0 Enter / T1 卡片 / T2 对话审批 |
| 优化面顺序 | skill → 工具描述 → prompt 段 → 代码 | memory/skill/prompt（数据）→ 代码 |
| 事后 | （无） | trial + retrospective + 一键回滚 |

结论：业界已验证"trace 反思 + 确定性门 + 人审"的组合可以工作，且同样是 data-first。v2 的增量是试用期回顾和指针回滚，这来自我们"个人日常 agent、没有 benchmark"的场景。

## 5. 安全底线

只保六条，全部是机制而非协议：

1. Reflector/Critic 只能写 `proposals/` 和自己的隔离 worktree，**没有写 registry 指针的路径**——apply 只由 CLI 在人批后执行；
2. 代码改动必须人看 diff 并自己合并；任何提案不得自动安装依赖；
3. `history.jsonl` / journal append-only；
4. bundle schema 校验挡住"数据里夹代码"；`kind` 由 diff 内容判定，不由提案自报；
5. Reflector/Critic 不向外网发任何请求（研究材料由人手动喂，见 §10）；
6. 最近 K 个 bundle 始终可启动，rollback 通路在每个里程碑都要实际演练。

## 6. 目录布局

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/evo/
  log/<session-id>.jsonl        # Recorder 原始记录
  artifacts/sha256/<digest>     # 大对象
  inbox/                        # 显式反馈、手动喂的研究材料
  bundles/<digest>/             # 不可变 bundle
  registry/stable               # 指针
  registry/trial.json
  registry/history.jsonl        # journal（发布 + 提案结论）
  proposals/<id>/               # proposal.json + observations.md + review.md + retrospective.md
  worktrees/                    # code 提案的隔离 worktree
  locks/
```

存储：JSONL + 文件，MVP 不引入 SQLite；查询需求靠 Reflector 直接读文件。数据量成为问题时再迁移（见 §9）。

## 7. 包结构与 Pi 接入

```text
packages/evo/
  src/
    cli.ts                     # /evo 命令实现（经 extension 转发）
    recorder/extension.ts      # Recorder extension
    recorder/schema.ts         # 事件 JSONL schema
    bundle/compile.ts          # 校验 + lock + digest
    bundle/runtime.ts          # EvoPolicyRuntime extension（固定解释器）
    registry/registry.ts       # 指针读写、原子切换、rollback、journal
    reflect/reflector.ts       # headless Pi run 封装（role prompts 在 prompts/ 下）
    reflect/critic.ts
    reflect/replay.ts          # L2 场景重放
    prompts/                   # reflector/critic/retrospective 的固定提示词（版本化，人工修改）
  test/
```

十几个文件。Pi 接入沿用 v1 已核实的结论：`createAgentSessionServices()` → `extensionFactories` 注入 Recorder 与 EvoPolicyRuntime；Reflector/Critic 用 SDK 或 `pi --mode rpc` headless 跑；不打 core patch，不从 `cache-stats.ts` 内部路径 import。

注意：`prompts/` 下的 Reflector/Critic 提示词本身**不在**自动优化范围内（它们是裁判），人工修改、git 版本化。这是 v1 "evaluator epoch" 保留下来的最小形态：裁判换版本 = 人改一个文件 + git commit。

## 8. 里程碑

| 里程碑 | 内容 | 周期 | 退出条件 |
|---|---|---|---|
| M0 | Recorder + `/evo report`（周报：本周任务、反复出错处、纠正聚类） | 2 周 | 报告每条结论都能点回真实记录；关闭 extension 后 Pi 行为不变 |
| M1 | Bundle 化现有 prompt/skill/偏好 + stable 指针 + `/evo rollback` | 1 周 | 从 registry 启动日常 Pi；回滚实际演练一次 |
| M2 | Reflector + Proposal + 分档判定 + T0/T1 审批（一行提示 / 一页卡片）+ data apply | 2 周 | 一个 T0 重排类和一个 T1 改动分别走完 observe→确认→apply→rollback 全流程 |
| M3 | T2 对话审批 + 单点反事实重放 + Critic 备忘录 + trial/retrospective | 1–2 周 | 一个 T2 提案带着重放对比和回顾报告完成 keep/rollback 决策 |
| M4 | code 提案流程（worktree + branch + 人合并）+ nightly 自动 improve + `/evo pause` | 2 周 | 一个工具/hook 改动经人审 diff 合并并可回退 |

累计约 6–8 周达到"完整闭环 + 代码级候选"。M0 当周即有产出（周报），每个里程碑独立有用。

## 9. 升级路径：什么时候把 v1 的机制请回来

v1 全文归档于 [evo-pi-design-v1-full.md](./evo-pi-design-v1-full.md)。下表是"简化件 → v1 对应物 → 升级触发信号"，没有信号就不升级：

| v2 简化件 | v1 对应物 | 触发信号 |
|---|---|---|
| stable 指针 + history.jsonl | ChannelPointer / registry / audit ledger | 需要多 lineage 或多机；或需要防篡改审计 |
| Proposal + diff 判 kind | CandidateManifest + CandidateClassification | 提案量大到人批不过来，需要自动分类分流 |
| Critic 备忘录 | EvaluationReport + ActionGateProfile | 想要某类改动免人批自动 promote（standing gate） |
| trial + retrospective | shadow / canary + AssignmentEngine | 需要按任务分层试用、或并行对比多个候选 |
| 单点重放（只生成、不执行） | v1 shadow（只读多步影子运行）或 workspace snapshot replay | T2 试用回滚率持续偏高，且失败集中在"首轮看不出的中期决策错误" |
| quiet hours + 每日 1 次 | Plan Broker + lease/permit | 后台真实挤占前台额度；或引入第二个订阅池 |
| session 即 episode | Episode Linker + delayed outcome adapters | 跨 session 长任务多到 Reflector 归属经常出错 |
| 手动喂研究材料 | Research Scout + QueryFirewall | 想自动抓论文/仓库（届时出站脱敏边界必须一起上） |
| prompts/ 人工版本化 | Evaluator epoch manifest | 发现被优化对象反向迎合裁判提示词（Goodhart 实证出现） |
| JSONL 文件存储 | SQLite + CAS | 记录规模或查询延迟成为实际瓶颈 |
| usage 粗观测 | P0/P1 逐请求 cache correlation | 真的要做以 cache 为主张的优化候选 |

升级原则同 v2 原则 5：**看到信号再动**，且每次只升级一件。

## 10. 不做清单

v2 明确砍掉（理由见 §0 与审计结论）：

- LogicalProviderRequestPermit / ProviderAttemptPermit / PlanEnforcementEpoch / stream wrapper / credential proxy；
- ArtifactView / CapabilityGrant / AssignmentDecision / AssignmentSpec；
- ReleaseTransaction saga / LineageSetManifest / 多 lineage / Pareto archive；
- 统计后验、strata、credit ledger、gate profile 偏序编译器；
- 实时 feedback classifier / episode linker / opportunity 优先级公式；
- Research Scout 全套（QueryFirewall、fetch broker、provenance gate）——研究吸收 = 人把论文/链接丢进 `inbox/`，Reflector 下次循环读；
- shadow 运行、evaluator epoch 协议、GenesisGrant / CoreMigrationGrant；
- 训练模型权重、多 agent 默认并行（与 v1 相同）。

这些不是被否定，而是被推迟——每一项在 §9 有明确的回归条件。

## 11. 参考

- [Evo-Pi v1 完整协议设计](./evo-pi-design-v1-full.md)（本文档的北极星与协议库）
- [Hermes Agent（Nous Research）](https://github.com/NousResearch/hermes-agent-self-evolution)：DSPy + GEPA 的反思式自进化，data-first + 确定性门 + PR 人审
- [GEPA: Reflective Prompt Evolution](https://arxiv.org/abs/2507.19457)：用 trace 反思代替随机搜索/RL 的候选生成方法
- [Darwin Gödel Machine](https://arxiv.org/abs/2505.22954)：benchmark-fitness + archive 的对照路线（我们没有 benchmark，故取 Hermes 路线）
- Pi 接入点事实与 core patch 候选：见 v1 归档 §17.2、§22（已核实到 commit `8479bd8`，实施前需重验）

## 12. 最终设计决策

> Evo-Pi v2 是一个"记录一切、模型反思、单轴提案、确定性小门、对话式人批、试用可回滚"的个人 agent 自进化系统。它把 v1 中防御性协议的位置让给两样东西：模型阅读原始记录的判断力，和一条永远可用的回滚通路。

判断可以出错，因为出错是可逆的；人只需要在一个地方出现，因为那个地方之前有备忘录、之后有试用期。
