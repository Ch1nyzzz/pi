# Evo-Pi 设计文档

| 元数据 | 值 |
|---|---|
| 状态 | Draft for Audit |
| 版本 | 0.1 |
| 日期 | 2026-07-13 |
| 目标读者 | Evo-Pi 维护者、审批者、Evaluator 设计者和 Pi kernel 贡献者 |

## 0. 文档目的

本文定义一个基于 Pi 的个人日常 Coding Agent 自进化系统。设计目标不是让正在工作的 Agent 随时改写自己，而是建立一个持续观察真实工作、吸收外部研究、生成下一代 Agent、验证效果并按人类授权发布的完整系统。

本文覆盖：

- 第一性原理和系统目标；
- Worker、Meta-Pi、Supervisor、Evaluator 和 Research Scout 的职责；
- 哪些部分可以优化、哪些部分属于最小控制核；
- Prompt、Skill、Memory、Tool、Hook、Runtime、Cache、Verifier、Router、Planner、UI 等优化如何组合；
- 人类如何选择最大优化面和自动审批阶段；
- 日常使用、后台研究、候选生成、Replay、Shadow、Canary、Promotion 和 Rollback；
- 没有固定 benchmark 时的 credit assignment；
- Worker 和 Meta-Pi 均使用订阅 coding plan 时的容量、调度和 ROI 模型；
- 数据结构、协议、存储、状态机、测试和分阶段实施方案。

本文是架构和协议设计，不代表所有接口已经在当前 Pi 中实现。

### 0.1 建议审计路径

- 审总体边界：第 1、3、5、6 节；
- 审人类授权与最大开放范围：第 7、18、29 节；
- 审优化如何组装：第 8–10、13 节；
- 审日常 credit 与真实工作闭环：第 11、12、14 节；
- 审后台论文/架构吸收：第 15 节；
- 审 Worker/Meta 订阅 plan：第 16 节；
- 审 cache 作为完整实例：第 17 节；
- 审当前 pi2 的具体接入和 core patch：第 22–25 节；
- 审验收、风险和逐项检查：第 26–28 节。

## 1. 结论摘要

Evo-Pi 采用以下总体方案：

1. Pi 保留为可同步上游的 Agent kernel 和交互执行层。
2. 新增独立 Evo 控制面，而不是把自进化逻辑直接塞入当前 Worker。
3. 当前 Worker 在一次 interaction 内必须固定完整 Activation（BehaviorBundle + kernel + ExecutionClosure）；日常默认进一步固定到整个 active episode，优化只产生下一代不可变 candidate。
4. Prompt、Context、Memory、Skill、Model Router、Tools、Hooks、Runtime、Verifier、Cache、Compaction、Planner、UI、Research Scout、Optimizer，乃至 Pi Worker kernel，原则上都可以成为优化对象。
5. 只有授权、artifact 身份、激活、回滚、原始审计、凭据和订阅容量控制组成的极小 Constitution Core 不进入普通自动进化。
6. 人类审批使用两个独立维度：最大可优化面 `surface ceiling`，以及允许自动运行到哪一阶段的 `automation ceiling`。
7. 所有组件由 typed Policy Graph 组装成 BehaviorBundle；真正发布和回滚的单位是内容寻址的 Activation。
8. 本地真实任务是最终评价分布；论文、公开 benchmark 和其他 Agent 架构只提供候选机制。
9. Worker 和 Meta-Pi 都使用 subscription coding plan，因此主要资源目标是每个订阅窗口中的有效完成数、前台等待、限流风险和长期改进收益，而不是简单的 API 美元或 token 最小化。
10. 外部研究通过 Research Card 和 Candidate Proposal 进入实验，不直接进入 stable prompt 或源码。

## 2. 基线、假设与设计状态

### 2.1 当前源码基线

本文审计时本地仓库状态：

```text
repository: /data/home/yuhan/pi2
branch: main
local commit: 8479bd84743e8889f728acb21a62794102db0529
coding-agent package version: 0.80.6
```

本文把本地 `HEAD` 与本地 `origin/main` 的 `8479bd84743e...` 固定为源码审计快照。2026-07-13 最终复核时，远端 GitHub `main` 已前进到 `0e6909f050e...`；因此本文所有“当前源码”结论都指向固定快照，而不是移动中的远端分支。每个实施批次开始前必须先选择目标 Pi commit、重新同步并复跑源码/ABI 审计，不能把本文的行级判断直接套到更新后的上游。

当前成熟日常运行路径仍是 `packages/coding-agent` 的 `AgentSession`、`AgentSessionRuntime`、SDK、TUI 和 RPC。

`packages/agent` 已出现新的 `AgentHarness`，并已提供 typed `on()/subscribe()` facade、若干 event-specific result handlers、provider request/payload 的有序 transforms、turn snapshot、save point、resource、manual compaction 和 stream options。统一 provenance、registration scope、可扩展 reducer registry 和通用冲突语义尚未实现，retry、auto-compaction、半持久恢复以及 coding-agent 的 TUI/resource/package 迁移也仍在进行。因此第一版使用 coding-agent SDK，并通过 `PiKernelAdapter` 隔离未来迁移。

`packages/orchestrator` 当前是实验性 RPC 进程管理器，不是本文定义的 Evo Supervisor。Evo-Pi 不依赖其不稳定状态或协议；未来可以复用进程管理实现，但不能把它直接当作 registry、evaluator 或 release manager。

### 2.2 运行假设

第一版默认：

- 单用户、个人工作站；
- Linux/Node 环境；
- 本地工作区和本地 Evo 数据库；
- Worker 与 Meta-Pi 均通过订阅 coding plan 使用模型；
- 订阅可以相互独立，也可以共享同一容量池；
- 用户拥有最终审批和 rollback 权限；
- 初期不训练模型权重；
- 首先进化 harness、策略、工具、流程和知识资产；
- Candidate 运行与 stable Worker 分离；
- 外部内容和论文代码不是默认可信执行物。

### 2.3 规范词

- **必须**：违反即破坏系统核心语义或审计能力。
- **应该**：默认设计；只有明确理由才偏离。
- **可以**：可选能力。

## 3. 第一性原理

### 3.1 Agent 是可版本化程序组合

Agent 的行为不是单个 prompt，而是：

```text
Outcome = F(
  Kernel,
  PolicyGraph,
  Model,
  Thinking,
  Context,
  Memory,
  Skills,
  Tools,
  Hooks,
  Runtime,
  Verifier,
  Cache,
  Workspace,
  User
)
```

所以评价时必须识别完整 Activation，并把可组合行为表示为 BehaviorBundle。

### 3.2 更好只相对于真实 workload 成立

公开 benchmark、论文结果和其他 Agent 的最佳实践不能直接证明对个人日常任务有效。Evo-Pi 的最终证据来自：

- 用户是否接受结果；
- 是否通过真实验证；
- 用户需要多少次纠正；
- 结果是否被重写或 revert；
- 后续是否再次出现相同问题；
- 任务耗时和订阅容量；
- 是否造成安全、范围或外部副作用问题。

### 3.3 当前版本工作，下一版本进化

一次 interaction 开始后，Worker 的 activation、component digests、kernel digest、ExecutionClosure、evaluator epoch 和 workspace snapshot 身份必须固定。日常默认在整个 active episode 中保持同一 activation，避免用户纠正到一半时行为版本改变；用户可以明确结束 episode 或要求采用新版本。

Runtime 可以按固定策略作条件决策，但不能在当前任务中把组件实现升级成新版本。任何学习结果只能产生新 candidate。

### 3.4 最大优化面来自可逆性

开放优化不应主要依赖大量静态禁止，而应依赖：

```text
immutable candidate
+ explicit approval envelope
+ isolated execution
+ observable outcome
+ atomic activation
+ immediate rollback
```

因此除了最小 Constitution Core，Evo-Pi 可以允许 Meta-Pi 搜索整个 Worker 实现空间。

### 3.5 事实、评价、策略分离

系统必须区分：

1. 原始事实：事件、测试、diff、token、quota、用户消息和延迟结果；
2. 评价策略：Outcome schema、utility、threshold、task taxonomy；
3. 被评价策略：Worker/Meta BehaviorBundle 与对应 Activation。

Candidate 不能通过修改日志、任务分配或当前 evaluator 来证明自己更好。

### 3.6 局部优化，整体发布

组件可以分别生成候选和 credit，Policy Graph 以完整 BehaviorBundle 评价；部署发布单位则必须是完整 Activation。两个单独有效的组件组合后仍需 interaction replay，因为它们可能争夺 context、改变 cache prefix、重复工具或产生相互抵消。

### 3.7 订阅容量是算力预算

在 subscription coding plan 下，token 不一定线性对应账单，但仍影响上下文、延迟、cache 和隐藏 quota。真正稀缺的是：

- rolling quota；
- 高级模型可用量；
- 并发；
- 限流和 cooldown；
- 前台响应能力；
- 订阅窗口内可以完成的有效任务数。

Meta-Pi 的研究和实验也必须计入进化成本。

## 4. 术语

| 术语 | 定义 |
|---|---|
| Interaction | 一次用户输入到 Agent 稳定返回控制权，可包含多个模型 turn 和 tool call |
| Run | 某个固定 activation 在固定输入/环境 snapshot 上的一次执行；workspace 仅在适用时存在 |
| Episode | 一个可评价的连续工作目标，可跨多个 interaction 和 run |
| Policy Component | Prompt、Router、Tool、Runtime 等一个可版本化组件 |
| Policy Graph | 组件及其 typed 依赖、阶段、读写和合并关系 |
| BehaviorBundle | Policy Graph 编译后的完整、不可变 Agent 行为定义 |
| ExecutionClosure | 实际执行该行为所需的 build、依赖、loader、provider adapter 和环境契约 |
| Activation | `BehaviorBundle + kernel + ExecutionClosure` 的内容寻址发布单元 |
| Overlay | User、Repo、Task、Experiment 等对 Base BehaviorBundle 的结构化增量 |
| Candidate | 尚未成为 stable 的新 BehaviorBundle、ExecutionClosure、kernel 或组合 Activation |
| Stable | stable channel 当前指向、默认服务真实用户任务的 Activation |
| Shadow | 观察真实任务并给出决策，但不执行真实副作用的候选 |
| Canary | 被分配少量真实、可控任务的候选 |
| Meta-Pi | 分析机会、研究、构建和验证 candidate 的 coding agent |
| Supervisor | 非 LLM 的确定性控制面 |
| Evaluator Epoch | 一段时间内固定的评价策略版本 |
| Constitution Core | 不进入普通自进化的最小授权和发布控制核 |
| Plan Pool | 一个订阅 coding plan 的容量池和调度边界 |

## 5. 系统架构

```text
                               Human Owner
                                    │
                         approval policy / grants
                                    ▼
┌─────────────────────────────────────────────────────────────────┐
│                       Evo Supervisor                            │
│                                                                 │
│ Scheduler  Approval  Experiment Assignment  Registry  Rollback │
│ Plan Broker  Evaluator Epoch  Audit  Workspace Snapshot        │
└───────────────┬─────────────────┬─────────────────┬─────────────┘
                │                 │                 │
         stable/canary       opportunity       replay/shadow
            RunSpec            + evidence          RunSpec
                │                 │                 │
                ▼                 ▼                 ▼
       ┌────────────────┐ ┌────────────────┐ ┌────────────────┐
       │ Pi Worker      │ │ Meta-Pi        │ │ Replay Worker  │
       │ user-facing    │ │ background     │ │ isolated       │
       │ fixed bundle   │ │ candidate repo │ │ snapshots      │
       └───────┬────────┘ └───────┬────────┘ └───────┬────────┘
               │                  │                  │
               └──────── trajectory / artifacts ────┘
                                  │
                                  ▼
                 ┌────────────────────────────────┐
                 │ Evidence and Outcome Store     │
                 │ SQLite metadata + CAS blobs    │
                 └───────────────┬────────────────┘
                                 │
                                 ▼
                     Research Scout / Source Graph
```

### 5.1 Human Owner

人负责：

- 定义长期目标和评价优先级；
- 设置最大优化面；
- 设置每个阶段的 standing approval；
- 审批超出 standing policy 的候选；
- 决定 evaluator epoch 更新；
- 修改 Constitution Core；
- 暂停、恢复和 rollback。

人不需要逐条设计优化。Meta-Pi 负责搜索，Supervisor 负责执行授权。

### 5.2 Pi Worker

Worker 负责当前用户任务：

- 使用 stable 或 Supervisor 指定的 canary bundle；
- 读取任务和 workspace；
- 执行规划、工具、编辑和验证；
- 产生完整 trajectory 和 raw outcome；
- 识别潜在 pain，但不批准自己的优化；
- 在同一 interaction 中必须保持 activation 身份固定，默认在 active episode 中也不切换。

### 5.3 Meta-Pi

Meta-Pi 本身也是使用订阅 coding plan 的 Pi-based coding agent。它负责：

- 聚类纠正、失败和效率问题；
- 进行 root-cause analysis；
- 读取 Research Cards 和本地证据；
- 生成可证伪的优化假设；
- 修改 candidate worktree；
- 编写 Prompt、Skill、Tool、Hook、Runtime 和 Worker kernel 候选；
- 生成测试、Replay、Ablation 和 Rollback 计划；
- 输出结构化 promotion proposal。

Meta-Pi 可以在用户开放 S4 后修改几乎整个 Worker，但不能切换 stable channel 或改变当前 evaluator epoch。

### 5.4 Evo Supervisor

Supervisor 应尽量是小型、确定性的状态机，不使用 LLM 作最终授权判断。它负责：

- 加载人类 approval policy；
- 管理 candidate 状态机；
- 校验 candidate、classification、activation 和报告 digest；
- 分配 stable、shadow、canary 和 replay；
- 调度订阅容量；
- 写入 append-only audit；
- 原子切换 channel；
- 自动监控和 rollback。

### 5.5 Evaluator

Evaluator 消费原始事实，输出版本化 Evaluation Report。

Evaluator 可以被改进，但必须在 epoch 边界更新：

```text
epoch N:
  evaluator-vN 固定
  比较所有 worker candidates

epoch N+1:
  人工批准 evaluator-vN+1
  新候选按新 evaluator 评价
```

历史 raw outcome 不变；新 evaluator 可以重新计算历史派生指标。

### 5.6 Research Scout

Research Scout 负责低成本发现和结构化外部证据。它不直接修改 Agent，只输出 Research Card、repo observation 和 candidate hint。

### 5.7 Replay Worker

Replay Worker 使用与真实 Worker 相同的 kernel adapter，但运行在独立 workspace snapshot 和 bundle 中。它可以复用 Worker executable；区别由 RunSpec、权限和 assignment 决定。

## 6. Constitution Core 与优化边界

### 6.1 最小 Constitution Core

以下模块不进入普通 candidate pipeline：

| 模块 | 原因 |
|---|---|
| Human identity / approval engine | 决定谁有权授权什么 |
| Artifact hash / registry channel | 保证批准对象等于激活对象 |
| Atomic activation / rollback | 保证版本切换可恢复 |
| Append-only raw audit ledger | 保存不能由候选重写的事实 |
| Candidate/Worker launcher | 强制实际运行权限和 RunSpec |
| Credential broker | 管理模型和外部服务凭据 |
| Subscription Plan Broker | 保留前台容量，限制后台占用 |
| Outbound query/fetch broker | 对私有到公开的查询和网络访问执行不可绕过的边界 |
| Active evaluator epoch pointer | 防止候选替换自己的裁判 |
| Emergency stop | 恢复 stable 并停止后台任务 |

这里的“不进入普通进化”不代表永远不能更新。人可以通过独立 `core migration` 更新它：

```text
human initiated
→ exact diff
→ dual-version contract test
→ explicit new core digest approval
→ retain old boot/rollback path
```

### 6.2 可优化面分级

```text
S0 Knowledge
   preference、memory、repo fact、statistics

S1 Policy Data
   prompt、context、retrieval、cache、router、compaction parameters

S2 Workflow
   skill、verifier、tool schema、planner、workflow graph、sub-agent config

S3 Executable Behavior
   hooks、tools、runtime、research adapters、optimizer plugins

S4 Worker Kernel
   Pi agent loop、session、extension runner、resource loader、provider adapter

S5 Constitution Core
   只允许人工 core migration
```

与传统保守分层不同，S4 仍是合法搜索空间。区别只在发布需要什么审批。

### 6.3 Subsystem × Surface

S0–S4 不是只针对 Worker，而是每个可进化子系统的层级：

```ts
type EvolutionSurface = "S0" | "S1" | "S2" | "S3" | "S4";
type AutomationStage = "A0" | "A1" | "A2" | "A3" | "A4" | "A5";

type EvolvableSubsystem =
  | "worker"
  | "meta"
  | "research"
  | "evaluator"
  | "plan-scheduler";

type ExecutorProfile =
  | "worker"
  | "meta"
  | "research-fetch"
  | "research-parser"
  | "research-synthesizer"
  | "evaluator"
  | "plan-scheduler";

interface EvolutionTarget {
  subsystem: EvolvableSubsystem;
  surface: EvolutionSurface;
  componentKind: string;
  lineageId: string;
}
```

`ExecutorProfile` 是 run 级执行档位，不是新的可进化 subsystem。固定映射为 worker→worker、meta→meta、三种 research profile→research、evaluator→evaluator、plan-scheduler→plan-scheduler；候选不能通过改 profile 名称跨 subsystem 取得权限。所有 target 都显式指定 lineage，单 lineage MVP 使用 `general`。

S5 故意不属于 `EvolutionSurface`，因此不能出现在 Candidate、EvolutionTarget、ApprovalPolicy 或 standing/exact grant 中。它只走独立协议：

```ts
interface CoreMigrationTarget {
  coreComponentId: string;
  currentDigest: string;
  proposedDigest: string;
  migrationPlanDigest: string;
  recoveryPlanDigest: string;
}

interface CoreMigrationGrant {
  grantId: string;
  target: CoreMigrationTarget;
  approvedBy: string;
  independentReviewDigest: string;
  rehearsalReportDigest: string;
  issuedAt: string;
  expiresAt: string;
}
```

CoreMigrationGrant 不能由 ApprovalPolicy 生成，也不能被 standing approval 覆盖。

解释示例：

| Subsystem | S1/S2 | S3 | S4 |
|---|---|---|---|
| Worker | prompt/context/skill/workflow | tool/hook/runtime code | agent/session/provider kernel |
| Meta | detector/search/operator policy | optimizer/operator code | Meta executor/kernel |
| Research | agenda/ranking/extraction workflow | source adapters/parser code | Research engine |
| Evaluator | taxonomy/metric/gate policy | evaluator implementation | evaluation engine |
| Plan scheduler | reserve/priority/simulation policy | scheduling strategy code | scheduler engine |

Plan ledger、active plan-enforcement epoch、lease enforcement、前台优先权和 active evaluator epoch pointer 仍属于 S5 Constitution Core；可进化的是它们上面的 scheduling/evaluation policy。Evaluator 的 S1–S4 更新还必须遵守独立 epoch 流程。

## 7. 审批与自治模型

### 7.1 自动化阶段

```text
A0 Observe
   只记录、检测和报告

A1 Propose
   生成 Opportunity、Hypothesis 和 ChangeSpec

A2 Build
   修改 candidate、编译、静态检查和 targeted tests

A3 Evaluate
   Replay、Ablation 和 Shadow

A4 Scoped activation
   在有限 scope 中激活：Worker canary、Evaluator shadow epoch、Scheduler sampled cycle 等

A5 Default activation
   满足 gate 后成为该 subsystem 的默认版本
```

| Subsystem | A4 | A5 |
|---|---|---|
| Worker | `worker.canary` | `worker.promote` |
| Meta | `meta.canary-policy` | `meta.activate-policy` |
| Research | `research.canary-policy` | `research.activate-policy` |
| Evaluator | `evaluator.shadow-epoch` | `evaluator.activate-epoch` |
| Plan scheduler | `scheduler.canary-policy`（先离线 simulate） | `scheduler.activate-policy` |

### 7.2 两轴授权

审批策略必须分别指定：

```text
subsystem: worker | meta | research | evaluator | plan-scheduler
surface_ceiling: S0..S4
automation_ceiling: A0..A5
```

例如：

```text
surface_ceiling = S4
automation_ceiling = A3
```

表示 Meta-Pi 可以修改整个 Worker kernel，并自动完成 build、test、replay 和 shadow，但 canary 和 stable 仍需审批。

### 7.3 默认审批矩阵

| 优化面 | 发现 | Build | Replay/Shadow | Canary | Stable |
|---|---:|---:|---:|---:|---:|
| Preference / Memory | 自动 | 自动 | 自动 | 可选 | 可自动 |
| Prompt / Context / Cache / Router | 自动 | 自动 | 自动 | 可自动 | 可按 standing gate 自动 |
| Skill / Planner / Verifier / Workflow | 自动 | 自动 | 自动 | 可配置 | 默认 standing approval |
| Tool / Hook / Runtime | 自动 | 自动 | 自动 | 默认 exact approval | 默认 exact approval |
| Pi Worker Kernel | 自动 | 自动 | 自动 | exact approval | exact approval |
| Constitution Core | 只报告 | 独立迁移 | 独立迁移 | 不适用 | 人工迁移 |

### 7.4 预设模式

#### Observe

```text
surface_ceiling = S2
automation_ceiling = A1
```

#### Assisted

```text
surface_ceiling = S3
automation_ceiling = A3
```

#### Broad，推荐初始日常模式

```text
default surface_ceiling = S4
default automation_ceiling = A5

worker S0-S1: 满足 gate 后允许 A5
worker S2: 允许低风险 A4，stable 使用 standing approval
worker S3-S4: component rule 限制为 A3；canary/stable exact approval

meta:
  所有 target 可自动生成/构建/评价到 A3
  data policy 激活使用 standing approval
  executable/kernel 激活使用 exact approval

research:
  agenda/ranking data 可 standing promotion
  adapter/parser code exact approval

evaluator:
  自动构建和 replay 到 A3
  新 epoch 必须 exact human approval

plan-scheduler:
  自动 simulation/shadow 到 A3
  scheduling policy 激活需 standing/exact approval
```

这里的 default A5 只是策略语言的最大 envelope；subsystem/component rules 会把 S3/S4 收窄到 A3。任何更具体的规则都只能收窄 default envelope，不能扩大它。

#### Autonomous Lab

```text
surface_ceiling = S4
automation_ceiling = A5
scope = 指定实验 repo、task strata、capabilities、plan budget
```

即使使用 Autonomous Lab，S5 仍不进入普通进化。

### 7.5 Standing 与 Exact Approval

Standing approval 对候选类别生效，例如：

```text
允许 context/cache 单轴候选
在本地 coding repo
不增加 network/process capability
质量非劣
最多 10 个 canary interaction
满足 gate 可自动 promote
```

Exact approval 绑定：

```text
candidate digest
candidate classification digest
activation digest
BehaviorBundle/kernel/ExecutionClosure digests
activation destination digest（ChannelPointer；Phase 6 另含 LineageSetManifest；或 EvaluatorEpochManifest）
evaluation report digest
gate profile digest
allowed target actions
允许通过的最高阶段
作用域
过期时间
```

Candidate、classification、BehaviorBundle、kernel、ExecutionClosure、activation destination、evaluation report 或 gate profile 任一变化后，旧 exact approval 不再适用。

### 7.6 ApprovalPolicy

```ts
type ApprovalRequirement = "none" | "standing" | "exact";

type ActivationAction =
  | "worker.canary"
  | "worker.promote"
  | "meta.canary-policy"
  | "meta.activate-policy"
  | "research.canary-policy"
  | "research.activate-policy"
  | "evaluator.shadow-epoch"
  | "evaluator.activate-epoch"
  | "scheduler.canary-policy"
  | "scheduler.activate-policy";

interface CapabilitySet {
  filesystem: Array<{
    root: string;
    access: "read" | "write";
  }>;
  networkDomains: string[];
  processCommands: Array<{
    commandId: string;
    executableDigest: string;
    argvPatternDigest: string;
  }>;
  credentialHandles: string[];
  externalSideEffects: string[];
  limits: {
    maximumWallTimeMs: number;
    maximumOutputBytes: number;
  };
}

interface ComponentApprovalRule {
  surfaces: EvolutionSurface[];
  componentKinds: string[];
  capabilityCeilingOverride: CapabilitySet | null;
  automationCeiling: AutomationStage;
  actionRequirements: Partial<
    Record<ActivationAction, ApprovalRequirement>
  >;
  gateProfileOverrides?: Partial<Record<ActivationAction, string>>;
}

interface ScopedActivationBudget {
  unit: "interactions" | "episodes" | "runs" | "cycles";
  maximum: number;
}

interface EvidenceRequirement {
  unit: "interactions" | "episodes" | "runs" | "cycles";
  minimum: number;
  minimumDistinct: number;
  minimumLiveEvidenceWeight: number;
  minimumPerTargetStratum: number;
}

interface GateCondition {
  metric: string;
  comparison: "gte" | "lte" | "eq";
  threshold: number;
  requiredProbability: number | null;
  missingValue: "fail" | "insufficient-evidence";
}

interface ActionGateProfile {
  schemaVersion: number;
  profileId: string;
  subsystem: EvolvableSubsystem;
  action: ActivationAction;
  evaluatorEpochConstraint:
    | { kind: "active" }
    | { kind: "exact"; epochManifestDigest: string };
  evidence: EvidenceRequirement;
  conditions: GateCondition[];
}
```

```ts
interface ApprovalPolicy {
  version: string;
  defaultRule: {
    surfaceCeiling: EvolutionSurface;
    automationCeiling: AutomationStage;
  };

  subsystemRules: Array<{
    subsystem: EvolvableSubsystem;
    surfaceCeiling: EvolutionSurface;
    automationCeiling: AutomationStage;
    capabilityCeiling: CapabilitySet;
    executorProfileCeilings?: Partial<
      Record<ExecutorProfile, CapabilitySet>
    >;
    planBudget: {
      planPoolId: string;
      maxConcurrentRuns: number;
      maxReplayRunsPerCandidate: number;
    };
    scopedActivationBudgets: Partial<
      Record<ActivationAction, ScopedActivationBudget>
    >;
    actionGateProfiles: Partial<Record<ActivationAction, string>>;
    componentRules: ComponentApprovalRule[];
  }>;

  lineages: string[];
  repositories: string[];
  taskStrata: string[];
  riskLevels: string[];

  globalBudgets: {
    maxConcurrentRuns: number;
    maxReplayRunsPerCandidate: number;
    maxConcurrentScopedActivationRuns: number;
    expiresAt: string | null;
  };

  universalGates: {
    maximumRiskRegression: number;
    minimumEvidenceWeight: number;
  };
}
```

`ActionGateProfile` 是独立、内容寻址的 artifact；policy 中保存它的 digest。Subsystem 提供 action 默认 profile，component rule 只能用 `gateProfileOverrides` 换成经 policy compiler 证明更严格的 profile。缺少 action profile、profile 的 subsystem/action 不匹配，或 profile 绑定的 evaluator epoch 不满足约束时，action 直接拒绝。Research、Meta、Evaluator 和 Plan scheduling policy 不能借用 Worker 的较宽 standing approval 或质量 gate。

“更严格”由固定 metric catalog 的偏序判定：evidence minimum/distinct/stratum/live-weight 只能增加，condition 只能增加，required probability 只能提高，missing-value 只能从 insufficient-evidence 收窄为 fail；metric threshold 的方向由 catalog 声明。Epoch constraint 只能从 active 收窄为 exact。两个 profile 若 metric 语义不同或无法比较，compiler 不允许自动 override，只能通过人签发的新 ApprovalPolicy 引用。Scoped activation maximum 属于独立 budget lattice，component/profile 都不能把它放宽。

`scopedActivationBudgets` 只限制 A4 实验最多可消耗多少对应单位；`ActionGateProfile.evidence` 决定进入某个 action 至少需要多少证据。二者不能用 `min()` 混合不同 unit。`maxConcurrentScopedActivationRuns` 只是所有 subsystem 同时在途的 A4 run 上限，也不是 interaction/episode/cycle 的替代单位。

默认 gate profile 的关注点不同：

| Subsystem | 核心 gate |
|---|---|
| Worker | 任务质量非劣、纠正/返工、目标收益、复杂度与前台体验 |
| Meta | 候选有效率、promotion yield、搜索新颖性、单位 plan capacity 的长期收益 |
| Research | 来源精度、去重、可复现性、Research Card 到本地实验的转化质量 |
| Evaluator | 与确定性/人工结果的校准、抗扰动、holdout 泄漏与 Goodhart 回归 |
| Plan scheduler | 前台 SLO、额度耗尽概率、后台有效产出与抢占/恢复开销 |

`automationCeiling` 表示不发生新的人类动作时最多自动前进到哪一步；它不是 standing/exact approval 的上限。若 target action 要求 standing/exact，人签发且 `allowedThrough` 足够高的 grant 可以授权该候选越过自动化 ceiling，但仍不能越过 surface、capability、repo、risk 和预算 envelope。空 `componentKinds` 表示匹配该 surface 的全部 kind；`capabilityCeilingOverride=null` 表示沿用 subsystem ceiling，非空值必须逐字段与 subsystem ceiling 求交，不能扩大权限。

规则解析必须 default-deny。Supervisor 对 `effectiveTargets` 的每个 subsystem/surface/component/capability 找出所有匹配规则，再取 lattice meet：

```text
automation ceiling = min(all matched ceilings)
approval requirement = max(none < standing < exact)
capability = intersection
executor profile capability = intersection(profile ceiling, subsystem ceiling)
lineage/repo/task/risk scope = intersection
plan and run budget = component/subsystem/global minimum
scoped activation cap = matched action budget within its declared unit
gate profile = exact subsystem/action profile, with stricter component override
```

任何 target 无匹配规则、规则冲突不能求交，或候选要求的 target action 未声明时，classification 直接拒绝；绝不回退到 default A5。多 target 候选保留每个 action 的独立 resolution，不能压成一个较宽的最终等级。

## 8. BehaviorBundle：把可进化内容组装成一个确定程序

### 8.1 为什么不能只维护“插件列表”

插件列表缺少三个关键语义：执行阶段、写入冲突和组合优先级。两个单独有效的 hook，按不同顺序运行可能得到完全不同的 prompt、tool 参数或上下文。因此 Evo-Pi 的行为组装单元不是散装插件，而是经过编译的 `BehaviorBundle`；它再与 kernel 和 ExecutionClosure 组成可发布 Activation。

```text
versioned components
        ↓
dependency / capability validation
        ↓
stage ordering + conflict resolution
        ↓
prompt/cache layout compilation
        ↓
immutable BehaviorBundle + kernel + ExecutionClosure
        ↓
content-addressed Activation
        ↓
worker pins activation_digest for interaction; normally for active episode
```

一个 interaction 开始后固定 `activation_digest`。默认的新 activation 只影响下一个 eligible episode；即使选择 interaction 级 assignment，也不能在一个正在执行的 turn 中热替换行为。

### 8.2 Typed Policy Graph

所有组件必须声明自己位于哪个阶段、读取什么、写入什么、是否有副作用、与哪些版本兼容。

```ts
type PolicyStage =
  | "request.ingest"
  | "input.normalize"
  | "feedback.classify"
  | "task.classify"
  | "task.plan"
  | "resource.select"
  | "context.retrieve"
  | "context.compose"
  | "model.route"
  | "prompt.compose"
  | "provider.prepare"
  | "agent.turn"
  | "tool.prepare"
  | "tool.authorize"
  | "tool.execute"
  | "tool.normalize"
  | "verify.select"
  | "verify.execute"
  | "runtime.retry-or-stop"
  | "response.compose"
  | "episode.finalize"
  | "learning.extract";

type ComponentStage =
  | PolicyStage
  | `evolution.${string}`
  | `evaluation.${string}`
  | `scheduling.${string}`;

type CompositionMode = "exclusive" | "append" | "merge" | "arbitrate";

type PolicyGraphKind = "worker" | "evolution" | "evaluation" | "scheduling";

type InvocationScope =
  | "process"
  | "session"
  | "episode"
  | "interaction"
  | "turn"
  | "provider-request"
  | "tool-call"
  | "compaction"
  | "background-cycle";

interface ComponentManifest {
  id: string;
  version: string;
  digest: string;
  kind: string;
  graph: PolicyGraphKind;
  stage: ComponentStage;
  invocationScope: InvocationScope;
  cardinality: "once" | "zero-or-one" | "zero-or-many" | "exactly-one-per-parent";
  priority: number;
  composition: CompositionMode;
  reducerDigest: string | null;
  reads: string[];
  writes: string[];
  state: {
    owner: string | null;
    lifecycle: "stateless" | "interaction" | "episode" | "session" | "durable";
    schemaDigest: string | null;
  };
  dependencies: Record<string, string>;
  incompatibleWith: string[];
  capabilityRequest: CapabilitySet;
  piCompatibility: string;
  inputSchema: string;
  outputSchema: string;
  deterministic: boolean;
  cacheable: boolean;
}
```

组合语义：

- `exclusive`：同一阶段同一写目标只能选一个实现，例如 model router。
- `append`：按稳定排序追加，例如 prompt guideline。
- `merge`：按声明的 key 合并，冲突必须有确定规则，例如 tool catalog。
- `arbitrate`：多个组件提出建议，由单独的 arbiter 决定，例如 verifier 选择。

`merge` 和 `arbitrate` 必须给出确定性 `reducerDigest`；不能只写一个模式名。每个 durable state path 只有一个 owner，其他组件通过 typed event/request 修改。未声明的写冲突、重复 exclusive writer、scope/cardinality 不匹配或无 reducer 的 merge 都是 bundle 编译错误。

上面的 `PolicyStage` 是 Worker graph 的阶段。完整系统维护四张分别版本化的图：

```text
Worker Behavior Graph:
  input → context → model → provider/tool loop → verify → response

Evolution Graph:
  observe → opportunity → research → hypothesis → build → experiment → release-advice

Evaluation Graph:
  ingest facts → link episode/outcome → strata → posterior → gates

Scheduling Graph:
  observe plan state → estimate → rank → reserve/preemption proposal

Constitution Plan Broker（不属于可进化图）:
  clamp/validate proposal → issue lease/permit → enforce → account
```

Research、Meta、Evaluator 和 Plan scheduler 的组件使用各自 stage vocabulary，但共享 manifest、scope、state ownership、composition 和 artifact identity 规则。四张图不能通过未声明的共享可写状态耦合。

### 8.3 Overlay 层级

同一种策略允许按作用域叠加：

```text
Kernel defaults
  < Stable base policy
  < User policy
  < Language/framework policy
  < Repository policy
  < Task-lineage policy
  < Experiment overlay
```

后层不是无条件覆盖前层。每个字段定义 `replace`、`append`、`union`、`min`、`max` 或 `deny-wins` 合并方式。安全 capability 使用 `deny-wins`。

用户本轮指令、动态检索内容、当前 workspace state 和最近 tool result 属于 `ResolvedRunInput`，不是 Bundle overlay。用户指令可以在合法范围内覆盖 policy 的行为选择，但不会因此生成新的 BehaviorBundle digest。

### 8.4 Bundle 编译器

Bundle 编译必须是纯函数：相同稳定行为输入产生相同 digest。行为身份、执行闭包、来源、部署/审批和本轮输入必须分开。

1. 解析所有 component manifests。
2. 验证 Pi ABI、依赖、schema 和 capability。
3. 展开 overlay，并记录每个最终字段的 provenance。
4. 构造 stage DAG；检测环和未声明冲突。
5. 生成稳定执行顺序。
6. 将 prompt 分为稳定前缀和动态后缀。
7. 生成 tool catalog、hook graph 和 runtime policy。
8. 输出规范化 BehaviorBundle lock 并计算内容哈希。

```ts
interface BehaviorBundleLock {
  schemaVersion: number;
  subsystem: EvolvableSubsystem;
  piCompatibility: string;
  components: ComponentManifest[];
  stageOrder: string[];
  capabilityEnvelope: CapabilitySet;
  promptLayoutDigest: string;
  toolCatalogDigest: string;
  runtimePolicyDigest: string;
  dataArtifactDigests: string[];
  executableArtifactDigests: string[];
}

interface ExecutionClosure {
  schemaVersion: number;
  entrypointDigest: string;
  builtArtifactDigests: string[];
  dependencyLockDigests: string[];
  runtimeImageDigest: string | null;
  nodeVersion: string;
  os: string;
  architecture: string;
  loaderDigest: string;
  transpilerDigest: string | null;
  providerAdapterDigests: string[];
  protocolRange: string;
  environmentContractDigest: string;
  stateNamespacePolicyDigest: string | null;
  readableStateSchemaDigests: string[];
  writableStateSchemaDigest: string | null;
  migrationArtifactDigest: string | null;
  rollbackMigrationDigest: string | null;
}

interface ActivationTuple {
  schemaVersion: number;
  subsystem: EvolvableSubsystem;
  activationKind:
    | "data-policy"
    | "declarative-policy"
    | "executable-policy"
    | "kernel";
  behaviorBundleDigest: string;
  kernelDigest: string;
  executionClosureDigest: string;
}

interface BundleProvenanceRecord {
  behaviorBundleDigest: string;
  parentBundleDigests: string[];
  createdByRunId: string;
  provenance: Record<string, string[]>;
}

interface ChannelPointer {
  schemaVersion: number;
  subsystem: Exclude<EvolvableSubsystem, "evaluator">;
  lineageId: string;
  channel: "stable" | "canary";
  activationDigest: string;
  assignmentPolicyDigest: string | null;
  generation: string;
}

interface LineageSetManifest {
  schemaVersion: number;
  subsystem: Exclude<EvolvableSubsystem, "evaluator">;
  generation: string;
  routingPolicyDigest: string;
  entries: Array<{
    lineageId: string;
    stablePointerDigest: string;
    canaryPointerDigest: string | null;
    eligibleTaskStrata: string[];
  }>;
}

type AssignmentKind =
  | "stable"
  | "shadow"
  | "canary"
  | "replay"
  | "meta-build";

interface AssignmentDecision {
  schemaVersion: number;
  assignmentId: string;
  runId: string;
  attemptId: string;
  executorRole: EvolvableSubsystem;
  executorProfile: ExecutorProfile;
  decisionMode: "channel" | "evaluation" | "scheduler";
  lineageSetManifestDigest: string | null;
  eligibleChannelPointerDigests: string[];
  selectionPolicyDigest: string;
  featureViewDigest: string;
  cohortEpoch: string | null;
  selectedChannelPointerDigest: string | null;
  selectedLineageId: string;
  selectedActivationDigest: string;
  assignment: AssignmentKind;
  reasonCode: string;
}

interface ReleaseTransaction {
  schemaVersion: number;
  transactionId: string;
  activationDigests: string[];
  expectedRegistryGeneration: string;
  channelUpdates: Array<{
    subsystem: Exclude<EvolvableSubsystem, "evaluator">;
    lineageId: string;
    channel: "stable" | "canary";
    expectedCurrentPointerDigest: string | null;
    newPointerDigest: string;
  }>;
  lineageSetUpdates: Array<{
    subsystem: Exclude<EvolvableSubsystem, "evaluator">;
    expectedActiveManifestDigest: string | null;
    newActiveManifestDigest: string;
  }>;
  dependencyEdges: Array<{
    beforeActivationDigest: string;
    afterActivationDigest: string;
  }>;
  requiredActions: Array<
    Exclude<
      ActivationAction,
      "evaluator.shadow-epoch" | "evaluator.activate-epoch"
    >
  >;
  evaluationReportDigests: string[];
  approvalGrantIds: string[];
  compatibilityMatrixDigest: string;
  assignmentFenceDigest: string;
  rollbackSetDigest: string;
  atomic: false;
}

interface EvaluatorEpochManifest {
  schemaVersion: number;
  epochId: string;
  evaluatorActivationDigest: string;
  evaluationPolicyDigest: string;
  metricCatalogDigest: string;
  gateProfileDigests: string[];
  holdoutAssignmentPolicyDigest: string;
}

interface EvaluatorEpochTransition {
  expectedRegistryGeneration: string;
  expectedActiveEpochManifestDigest: string | null;
  newEpochManifestDigest: string;
  evaluationReportDigest: string;
  exactApprovalGrantId: string;
}
```

`capabilityEnvelope` 没有第二个手写来源；Bundle Compiler 从全部 `ComponentManifest.capabilityRequest` 计算规范化最小上界：filesystem 对相同 canonical root 取所需最高 access，domain/credential/side-effect/command 取去重并集，资源 limit 取满足任一组件所需的最大值。编译器重算值与 lock 不一致就拒绝。运行时实际 `CapabilityGrant` 再把该派生请求与 subsystem、executor-profile、task 和人工 policy ceiling 求交。

`behaviorBundleDigest = hash(canonical(BehaviorBundleLock))`，只表示稳定行为。`activationDigest = hash(canonical(ActivationTuple))`，表示真正可启动、可审批、可回滚的 subsystem release。Provenance 不参与行为 hash；approval policy、evaluator epoch 和 candidate state 也不参与。

每条 lineage 的 stable 与 canary 都指向内容寻址的 `ChannelPointer`；stable 必须令 `assignmentPolicyDigest=null`，canary 必须绑定非空 assignment policy。这样 lineage、activation 与“谁会被分配到 canary”作为一个 pointer artifact 一起 CAS/回滚，不会分别漂移。

MVP 的跨 subsystem `ReleaseTransaction` 是带前置 generation/pointer 比较的有序 saga，不承诺多文件原子切换。开始前，Assignment Engine 按 `assignmentFenceDigest` 停止受影响 subsystem 接收新的 eligible episode/run，并等待旧 pin 到达安全边界；`compatibilityMatrixDigest` 必须证明正向每个中间组合和逆向补偿组合都可运行。只有在逐项激活、健康检查和审计完成后才解除 fence；任一步失败就按 `rollbackSetDigest` 逆序补偿。若中间组合不能兼容，则只能在明确 maintenance quiescence 下执行，或等待单 root generation pointer，不能暴露半升级状态。Evaluator epoch 不允许与被它评价的 Worker/Meta/Research/Scheduler activation 出现在同一 transaction。未来若确实需要跨 subsystem 原子发布，必须把所有目标指针写成一个内容寻址的 registry-generation manifest，再只原子 rename 一个 root pointer；不能把多个独立 rename 称为原子事务。

Evaluator 的唯一权威激活状态是 Constitution 持有的 `active evaluator epoch manifest` pointer。普通 subsystem channel 不用于决定 active evaluator；`evaluator.shadow-epoch` 只注册 shadow manifest，`evaluator.activate-epoch` 通过 `EvaluatorEpochTransition` 原子替换这一个 pointer。Manifest 绑定 evaluator activation、评价 policy、metric catalog、gate profiles 和 holdout assignment policy，防止各字段分别漂移。

MVP 对 durable state 使用 activation/version namespace，新 activation 先双读旧 namespace、只写新 namespace。Rollback 窗口内禁止破坏性 migration；只有同时提供并验证 forward/rollback migration，才允许复用可写 namespace。这样旧 binary 存在不等于虚假的“旧状态一定可读”。

Executor 不直接提交 durable state。Supervisor 在 RunSpec context 中固定 `stateReadViewDigest + stateSnapshotDigest`；`ExecutorRunResult` 只返回 schema-validated write-set artifact。State owner 使用 compare-and-swap 检查 snapshot、读集和 namespace 后生成 `stateCommitId`，Supervisor 再写最终 `RunResult`。冲突时 finalization 标为 state conflict，并基于新 snapshot 创建新 attempt；不能静默 last-write-wins，也不能让 replay 写回 live state。

部署时另外生成：

```ts
interface AssignmentSpec {
  schemaVersion: number;
  assignmentId: string;
  runId: string;
  attemptId: string;
  assignmentDecisionDigest: string;
  sourceChannelPointerDigest: string | null;
  executorRole: EvolvableSubsystem;
  executorProfile: ExecutorProfile;
  lineageId: string;
  activationDigest: string;
  evaluatorEpoch: string;
  evaluatorEpochManifestDigest: string;
  artifactViewDigest: string;
  approvalGrantIds: string[];
  capabilityGrantDigest: string;
  planAuthorization: PlanAuthorization;
  planEnforcementEpochDigest: string;
  assignment: AssignmentKind;
}

interface ResolvedRunInput {
  taskArtifact: string;
  userInstructionArtifact: string;
  dynamicContextArtifacts: string[];
  artifactViewDigest: string;
  workspaceSnapshotId: string | null;
  stateReadViewDigest: string | null;
  stateSnapshotDigest: string | null;
  modelId: string;
  provider: string;
}
```

Assignment Engine 先把候选输入、task feature view、eligible stable/canary pointers、lineage-set manifest、选择 policy、cohort epoch、最终 pointer/activation 和 reason 写入不可变 `AssignmentDecision`，再生成 AssignmentSpec。真实 stable/canary 必须绑定被选中的 `sourceChannelPointerDigest`；shadow/replay 可由 evaluation plan 直接选择 activation，因此 pointer 可为空；meta-build 还要绑定实际执行 Meta kernel 的 stable pointer。RunSpec 只接受同 run/attempt、同 activation/lineage/assignment 的 AssignmentSpec。这样 cohort 随机化的秘密不进入 Worker view，但其 epoch、输入 digest 和结果仍可审计与重放。

同一 BehaviorBundle 可以在新 evaluator epoch 下重新评价而不改变 digest；同一行为在不同本地 build/dependency closure 下会有不同 activation digest。远程模型服务不能完全内容寻址，RunSpec 仍记录 provider/model/API capability observation，replay 报告必须注明这一外部非确定性。

### 8.5 Stable prefix 与 dynamic suffix

Prompt compiler 将内容按变动频率排布：

```text
[provider/cache-compatible stable prefix]
  core system contract
  stable tool schemas
  stable global policy
  stable skill index

[session-stable middle]
  user preferences
  repository contract
  selected long-lived context

[turn-dynamic suffix]
  current request
  retrieved snippets
  current plan/state
  recent tool results
```

编译器必须输出每段 token、digest、命中预期和失效原因，使 cache 优化成为可观测的普通优化轴，而不是特殊技巧。

## 9. 完整可优化表面

Evo-Pi 默认认为除 Constitution Core 外的行为都可被提出、实验和版本化。不同表面只在证据成本、审批上限和回滚粒度上不同。

### 9.1 交互与任务理解

可优化内容包括：输入归一化、意图识别、任务边界、风险级别、歧义检测、何时澄清、如何区分新需求与错误纠正、对用户偏好的建模。目标是减少错误假设和不必要打断，而不是机械减少对话轮数。

### 9.2 Planning

可优化：是否需要 plan、计划粒度、何时重新规划、依赖排序、读写验证顺序、长任务 checkpoint、失败后的替代路径。计划只是执行策略，不要求始终向用户展示。

### 9.3 Prompt

可优化：system contract、guidelines、few-shot、工具描述、输出约定、repo 指令摘要、模型特化模板。必须记录具体段落版本和 token 成本，避免只记录一个大 prompt 字符串。

### 9.4 Context 与 Retrieval

可优化：文件选择、symbol/repo map、历史 turn 选择、memory 检索、snippet 粒度、排序、去重、过期内容移除、动态预算和 context packing。应区分“模型没看到必要事实”和“看到了但推理失败”。

### 9.5 Memory 与用户偏好

可优化：抽取、作用域、置信度更新、合并、冲突、过期和遗忘。Memory 是有 provenance 的结构化事实，不是无限追加的自由文本。

### 9.6 Skill

可优化操作：`extract`、`generalize`、`specialize`、`merge`、`split`、`attach-precondition`、`attach-counterexample`、`rewrite`、`retire`。Skill 需要适用条件、反例、来源 episode、成功/失败统计和容量预算。

### 9.7 Model、thinking 与 escalation

可优化：首次模型、thinking level、失败升级、critic 模型、任务分层路由、上下文长度选择。目标是最大化单位 subscription capacity 的可接受完成量，而不是最小化一次调用的标称 token。

### 9.8 Tools

可优化：tool schema、描述、结果格式、批处理、symbol/AST/LSP 接口、编辑表示、precondition hash、timeout、重试、错误分类和输出截断。读工具可以并发；写工具必须尊重依赖和冲突。

### 9.9 Hooks 与 Policy Graph

可优化：hook 的选择、阶段、顺序、优先级、输入输出和冲突仲裁。候选可以新增 hook 或替换一个阶段，但不能绕过 bundle compiler 直接依赖隐式加载顺序。

### 9.10 Runtime

可优化：工具调度、并发、超时、重试、停止、compact 时机、失败恢复、模型升级、后台任务让步和 checkpoint。每个决定写入 trace，包含候选选择集和理由。

### 9.11 Verification

可优化：从 parse、typecheck、lint、targeted tests、broader tests、smoke test 到 LLM diff review 的选择和顺序。验证策略同时考虑风险、时间、subscription capacity 和测试可用性。

### 9.12 Cache、Artifact 与 Repo Index

可优化：provider prompt cache、前缀布局、retention、tool-result cache、repo index、artifact store、research source cache 和 replay 结果 cache。缓存必须声明 key、依赖、失效、纯度和敏感范围。

### 9.13 Compaction 与 Session

可优化：触发阈值、结构化摘要、必须保留字段、branch summary、跨 session 恢复、压缩质量验证。摘要应保存目标、约束、修改、证据、未决问题和验证状态，而非一般性复述。

### 9.14 Multi-agent

可优化：是否拆分、角色、并发度、上下文共享、合并和冲突处理。默认单 worker；只有可独立并行且预期收益超过额外 plan capacity 时才启用 sub-agent。

### 9.15 UI 与反馈采集

可优化：进度呈现、何时请求确认、diff 摘要、审批卡片、失败解释和快捷反馈。UI 事件本身也是结果信号，但不能把“用户没点差评”等同于成功。

### 9.16 Research Scout

可优化：查询主题、来源组合、检索频率、去重、论文筛选、经验抽取和本地实验映射。Research Scout 产生证据与候选，不直接改变 stable worker。

### 9.17 Meta optimizer

可优化：机会检测、候选生成器、搜索算法、消融策略、试验预算和 lineage 选择。Meta-Pi 自己也是版本化 bundle，但不能改变当前用于批准它的 evaluator epoch。

### 9.18 Evaluator

Evaluator 可以通过独立、人工批准的 epoch 升级，包括新指标和权重；不能与被测候选在同一次实验中共同变化。历史结果必须保留当时 epoch，并可按新 epoch 离线重算派生指标。

### 9.19 Worker Kernel

当扩展 API 已成为经证据确认的瓶颈时，可进化 agent loop、session runtime、tool runner、resource loader 和 provider bridge。这属于 S4：允许自动生成和评估，默认需要 exact approval 后 promotion。

## 10. 组合优化与交互效应

### 10.1 ChangeSet 是最小审计单位

```ts
interface ChangeSet {
  id: string;
  parentBundleDigest: string;
  hypothesis: string;
  targetMetrics: string[];
  changedAxes: string[];
  componentPatches: string[];
  expectedInteractions: string[];
  rollbackUnit: string;
}
```

默认一个 ChangeSet 只修改一个优化轴，便于归因。结构性改进允许多轴，但必须显式声明 interaction group。

### 10.2 组合实验

假设 prompt 候选 A 和 context 候选 B 均单独获胜，不直接发布 A+B。至少比较：

```text
baseline
A
B
A+B
```

由此估计：

```text
main_effect(A)
main_effect(B)
interaction(A, B) = gain(A+B) - gain(A) - gain(B)
```

当完整析因成本过高时，按共享写目标、同一 prompt segment、相同 token budget 或相同 runtime decision 将组件划为 interaction groups，只对高风险组做消融。

### 10.3 多 lineage 而非单 champion

Registry 可以同时维护：

```text
general/stable
typescript-bugfix
python-data
research-heavy
low-latency
high-assurance
experimental/kernel
```

Phase 1–5 可以在 archive 中保留多条 lineage，但只部署 `general`，避免文档先声称具备尚无协议表示的 kernel router。Phase 6 启用多 lineage 时，registry 为每个 subsystem 增加唯一 active `LineageSetManifest` pointer；manifest 同时绑定 routing policy、每条 lineage 的 stable/canary `ChannelPointer` 和 eligible strata。固定 Assignment Engine 解释已批准的 routing policy，在创建进程和 RunSpec 之前选择 lineage/activation，并把 manifest、eligible pointers、feature view 和结果写入 `AssignmentDecision`。

因此 router 可以选择不同 BehaviorBundle、ExecutionClosure 乃至 kernel，但不能在已开始的 interaction/run 内热切换；选择后的 `lineageId + activationDigest` 被 pin。一个全局平均较弱、但在某类任务显著更好的 bundle 不应被淘汰；一个当前最强但缺少继续探索价值的 bundle 也不应占据全部 meta 预算。Routing policy 是可进化声明式数据，Assignment Engine 的解释、scope clamp 和 pinning 仍属于固定控制面。

### 10.4 Pareto archive

候选按质量、纠正量、等待时间、subscription capacity、风险和可维护性形成 Pareto archive。只有面向具体部署 policy 时才做标量化。这样可以在“快速日常工作”和“高保障改动”之间选择，而不假装存在唯一最优分数。

## 11. 日常进化闭环

### 11.1 前台只工作，后台才进化

与 Pi 的日常对话不需要变成持续的实验界面。前台 worker 固定使用一个已激活 release 完成工作，同时记录证据；后台 Meta-Pi 在用户不等待时分析、生成和验证下一代。

```text
真实对话 / coding task
  → 固定 activation 执行
  → 记录 episode、决策点、成本和结果
  → opportunity detector 聚合重复痛点
  → Meta-Pi 提出 hypothesis + ChangeSet
  → 静态检查 / replay / shadow / canary
  → 人或 policy 审批
  → 下一个 eligible episode 激活
  → 监控延迟结果并决定保留或回滚
```

正在处理当前任务的 worker 不修改自身。它可以即时写入 memory、偏好候选和 feedback 标签，但这些记录只有通过各自的 approval policy 才进入 active view。

### 11.2 两类自然语言输入

用户发给 Pi 的下一条消息可能是：

1. 继续当前任务；
2. 纠正 agent 错误；
3. 补充原本缺失的需求；
4. 改变偏好；
5. 开始新任务；
6. 明确评价；
7. 要求系统以后都采用某种做法。

`feedback.classify` 必须给出标签、置信度和依据；低置信度时保持 `unknown`。用户说“以后不要这样”可以直接形成高优先级 preference proposal，但不能自动伪装成所有任务上的质量标签。

### 11.3 Opportunity Detector

Detector 不是让 LLM 随机“想改进什么”，而是从证据形成可排序的问题。

```ts
interface OpportunityRecord {
  id: string;
  surface: EvolutionSurface;
  taskStrata: string[];
  symptom: string;
  evidenceEpisodeIds: string[];
  occurrenceCount: number;
  estimatedImpact: number;
  estimatedFixability: number;
  uncertainty: number;
  expectedPlanCapacity: number;
  suggestedOperators: string[];
  status: "new" | "triaged" | "selected" | "deferred" | "closed";
}
```

初始优先级可用：

```text
priority =
  recurrence
  × user_impact
  × estimated_fixability
  × expected_future_frequency
  × evidence_confidence
  ÷ estimated_plan_capacity
```

这只是调度启发式，不是最终 reward。一次严重风险问题可通过 policy 直接提高优先级。

### 11.4 Pain-driven 与 frontier-driven

后台预算分成三类，比例由 Plan Broker 动态调整：

- exploitation：处理真实工作中反复出现的痛点；
- adjacent exploration：尝试与已知赢家相邻的小变体；
- frontier exploration：吸收论文、新 agent 架构和新工具接口。

初始可使用 70/20/10；额度紧张时首先暂停 frontier，不能影响前台 worker。这个比例必须在运行后根据候选 yield 校准，不是硬编码真理。

### 11.5 两种进化循环

Fast loop 面向低成本数据组件：

```text
feedback/memory/skill/context rule
  → validate schema
  → small replay
  → policy-allowed activation
```

Structural loop 面向代码与架构：

```text
tool/hook/runtime/kernel hypothesis
  → isolated worktree
  → type/contracts/tests
  → broad replay + interaction ablation
  → shadow
  → canary
  → exact/standing approval
```

### 11.6 搜索策略

不要用一个无限上下文的 Meta-Pi 反复重写整个 agent。每轮：

1. 选择一个 opportunity 或 interaction group。
2. 从 stable、同类 lineage 和 research cards 中检索有限证据。
3. 生成 2–5 个有明确差异的候选。
4. 用廉价 gates 淘汰明显失败者。
5. 使用 successive halving 给剩余候选增加 replay 配额。
6. 对前两名做配对 replay、消融和 shadow。
7. 保留赢家、代表性失败和 novelty 高的候选。

低维参数用 Bayesian/bandit 搜索；prompt/skill 用结构化 mutation；代码使用 patch generation；workflow 用 DAG mutation；多组件只在 interaction group 内联合搜索。

## 12. Trajectory、Episode 与可观测性

### 12.1 边界定义

- `session`：Pi 持久化的整棵对话树。
- `interaction`：一次用户输入到 agent 稳定返回控制权。
- `episode`：一个可评价工作目标，可跨多个 interaction。
- `run`：一个 activation 在指定输入/环境 snapshot 上的一次执行；stateless background run 可以没有 workspace。
- `decision`：router、context、tool、retry、verify 等可被反事实替换的局部选择。

日常 credit 以 episode 为主；cache/latency 等系统指标也记录到 interaction 和 provider request。

### 12.2 Episode 数据模型

```ts
interface EpisodeRecord {
  episodeId: string;
  sessionId: string;
  parentEpisodeId: string | null;
  startedAt: string;
  closedAt: string | null;
  status: "open" | "suspended" | "closed" | "split" | "merged";
  linkerVersion: string;
  boundaryEvidence: string[];

  task: {
    rawRequestArtifact: string;
    normalizedIntent: string;
    strata: string[];
    ambiguity: number | null;
    risk: string;
  };

  environment: {
    repository: string | null;
    baseCommit: string | null;
    workspaceSnapshot: string;
    stateSnapshotDigest: string;
    dependencyFingerprint: string | null;
    piCommit: string;
  };

  execution: {
    evaluatorEpoch: string;
    evaluatorEpochManifestDigest: string;
    interactionIds: string[];
    runIds: string[];
    assignments: Array<{
      interactionId: string;
      activationDigest: string;
      behaviorBundleDigest: string;
      kernelDigest: string;
      executionClosureDigest: string;
      runIds: string[];
    }>;
    mixedActivationEpisode: boolean;
    finalPatchArtifact: string | null;
  };

  outcome: OutcomeVector;
  outcomeEvidence: string[];
  delayedOutcomeDueAt: string | null;
}
```

### 12.3 事件与 trace

每条事件至少带：

```text
trace_id
span_id
parent_span_id
session_id
interaction_id
episode_id
run_id
activation_digest
behavior_bundle_digest
kernel_digest
execution_closure_digest
artifact_view_digest
plan_authorization_mode
component_id/version
evaluator_epoch
timestamp_monotonic
```

Background event 的 `session_id/interaction_id/episode_id` 可以为 null；workspace identity 由 RunContext 在适用时提供。Run、activation、artifact view 和 plan authorization identity 始终存在。

核心事件包括 prompt segments、provider request/usage、context selection、tool call/result、workspace mutation、verification、compaction、用户 correction、approval、candidate state 和 registry channel change。大内容写入 content-addressed artifact，只在事件中存 digest 和摘要。

### 12.4 原始事实与派生判断分离

```text
Raw fact:
  user sent message X at time T
  test command exited 1
  1,820 cache-read tokens reported

Derived annotation:
  X is an agent_error correction, confidence .82
  failure belongs to verifier-v4
  cache miss likely caused by tool schema reorder
```

原始事件 append-only；分类器升级只新增 annotation version，不覆写历史。这样 evaluator 或 feedback classifier 进化后可以重算，而不会改写事实。

### 12.5 结果信号层级

从强到弱：

1. 可复现的功能测试、类型检查、静态约束；
2. 用户明确接受、拒绝或回滚；
3. 最终 diff 保留比例、后续人工修改和重复修复；
4. 是否完成预期外部结果；
5. 用户纠正轮数及分类；
6. 独立 reviewer/LLM judge；
7. agent 自评。

缺失结果写 `null`，不能自动当作成功。LLM judge 用于补充语义质量和解释，不是唯一发布门。

### 12.6 延迟结果

Episode 结束后仍可追加：

- 1/7/30 天内 revert；
- 相同 bug 是否重现；
- 生成脚本是否继续使用；
- 用户是否大幅重写；
- 后续测试或 CI 是否失败；
- 是否多次触发相同 correction。

Promotion 后出现延迟退化时，Credit Ledger 和 lineage posterior 都要更新；达到 rollback policy 时自动回到上一个 stable digest。

### 12.7 Episode Linker 与延迟证据归属

Episode 不能只靠 idle timeout 切分。Linker 对每次新输入输出 `continue`、`new`、`split`、`merge`、`suspend` 或 `unknown`，并保存证据与置信度：

```text
显式“继续/修正上一步”          → continue
明确新目标且旧目标已完成         → close + new
同一 repo 但独立目标             → new 或 child episode
session branch 且目标不变         → continue with branch evidence
长期空闲                         → suspend，不自动判定成功
低置信度                         → unknown，保留人工纠正入口
```

Linker 版本变化只新增 boundary annotation。用户可执行：

```text
/evo episode status
/evo episode close
/evo episode split <interaction>
/evo episode merge <episode...>
/evo episode relabel <kind>
/evo episode link-outcome <artifact-or-event>
```

延迟 outcome 由独立 evidence adapters 产生：

- session/feedback adapter：显式接受、拒绝、纠正和新需求；
- workspace adapter：agent 初始 patch、后续 diff、revert/patch-id 和 touched-line provenance；
- verifier/CI adapter：与 activation/commit 能关联的测试结果；
- artifact-use adapter：脚本、命令或生成物的再次调用；
- manual adapter：用户手工标记复用、误归因或独立编辑。

归属规则：

1. 先要求 repo/worktree、时间、base commit 和 artifact lineage 匹配；
2. 只把能追踪到 agent-produced patch/line/artifact 的后续修改作为强证据；
3. 大量独立用户改动、rebase 或多 agent 混合后降低置信度，不强行归因；
4. “窗口内发生”本身不是因果证据；
5. 每条 delayed evidence 保存 adapter/version、原始 event、归属概率和反证；
6. 人工 split/merge/correct 产生修正事件，并重新计算派生 credit，不覆写原始事实。

这样“7 天内改过同一文件”不会自动算 Agent 失败，而“agent patch 被直接 revert、相同测试失败且 commit lineage 匹配”可以成为高权重负面结果。

## 13. Candidate 工厂与状态机

### 13.1 生命周期

```text
OBSERVED
 → TRIAGED
 → HYPOTHESIS
 → CHANGE_SPEC
 → BUILT
 → CLASSIFIED
 → STATIC_VALIDATED
 → REPLAYED
 → SHADOWED
 → CANARY_READY
 → CANARY
 → PROMOTION_READY
 → PROMOTED
 → MONITORING
 → SUPERSEDED
```

任一阶段可以进入 `REJECTED`、`BLOCKED`、`EXPIRED` 或 `ROLLED_BACK`。所有转换由 Supervisor 写入审计事件，且必须说明 gate、approval 或失败证据。

### 13.2 Meta-Pi 逻辑角色

下列角色可以由同一订阅 agent 在不同、可 checkpoint 的 run 中完成，不要求常驻多个 agent：

- Analyst：聚类失败和机会；
- Designer：写 hypothesis、ChangeSpec、实验设计；
- Builder：生成 component/patch；
- Critic：找交互、回归和过拟合风险；
- Experimenter：选择 replay strata 和预算；
- Release Advisor：把证据整理成审批建议。

角色之间通过结构化 artifact 传递，避免把完整历史塞进每个上下文。

### 13.3 Evolution Operator

```ts
interface EvolutionOperator<I, O> {
  id: string;
  inputSchema: string;
  outputSchema: string;
  applicableSurfaces: EvolutionSurface[];
  estimateCapacity(input: I): number;
  propose(input: I, context: EvolutionContext): Promise<O[]>;
  validate(output: O): ValidationIssue[];
}
```

Operator 示例：prompt section rewrite、context budget tune、skill merge、tool schema mutate、hook reorder、runtime threshold tune、workflow splice、kernel patch。每个 operator 都有最大变更面和回滚单位。

### 13.4 Candidate Manifest

```ts
interface CandidateManifest {
  candidateId: string;
  parentActivationDigests: string[];
  opportunityId: string;
  changeSetDigest: string;
  hypothesis: string;
  predictedEffects: Record<string, number>;
  changedFiles: string[];
  componentDigests: string[];
  artifactDigests: string[];
  declaredTargetHints: EvolutionTarget[];
  requestedCapabilityHints: string[];
  targetTaskStrata: string[];
  evaluationPlanDigest: string;
  producedByMetaBundle: string;
  producedByPlanRun: string;
}

interface CandidateClassification {
  candidateManifestDigest: string;
  classifierVersion: string;
  inspectedDiffDigest: string;
  dependencyClosureDigest: string;
  effectiveTargets: EvolutionTarget[];
  effectiveCapabilities: CapabilitySet;
  activationTuple: ActivationTuple;
  activationDigest: string;
  approvalResolutions: Array<{
    target: EvolutionTarget;
    action: ActivationAction;
    automaticThrough: AutomationStage;
    requirement: ApprovalRequirement;
    matchedRuleDigests: string[];
    effectiveScopeDigest: string;
    effectiveCapabilityDigest: string;
    effectiveBudgetDigest: string;
    gateProfileDigest: string;
  }>;
  matchedApprovalPolicyDigest: string;
  classificationReasons: string[];
}
```

`declaredTargetHints` 和 `requestedCapabilityHints` 只是 Meta-Pi 的说明。Supervisor 在 build 后根据实际 diff、artifact type、依赖闭包、代码执行形式和固定 data/code 分类规则生成 `CandidateClassification`。Candidate 不能提供自己的 `requiredApproval`，也不能通过把 S3 代码标成 S1 数据降低门槛。任何 artifact 变化都会重新计算 manifest、classification、activation 和 approval applicability。

一个 Candidate 可以同时修改同一 subsystem 的多个 surface/component，但只产生一个该 subsystem 的 Activation。若 ChangeSpec 同时影响 Worker 与 Evaluator、Meta 与 Scheduler 等多个 subsystem，Supervisor 必须拆成各自独立 classification/activation 的 candidate；非 Evaluator subsystem 可用 `ReleaseTransaction` 描述依赖、联合实验和有序 saga，Evaluator epoch 则必须单独先后迁移。每个 activation 分别求最严格规则、分别评价和审批。不能把多个审批域压进一个 ActivationTuple，也不能让新 evaluator 评价并同时放行自己或同批 subject。

### 13.5 失败也是资产

Failure archive 保存：候选 digest、失败 strata、触发输入、根因、已试修复和禁止重复条件。生成候选前检索相似失败，减少 Meta-Pi 在不同 wording 下反复提出同一无效方案。

## 14. 评估、Credit Assignment 与发布门

### 14.1 Outcome 是向量

```ts
interface OutcomeVector {
  quality: {
    taskDone: boolean | null;
    verificationPassed: boolean | null;
    testsPassed: number | null;
    testsFailed: number | null;
    acceptedDiffRatio: number | null;
    revertedWithinWindow: boolean | null;
    regressionCount: number | null;
  };
  efficiency: {
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    logicalProviderRequests: number;
    providerTransportAttempts: number;
    toolCalls: number;
    retries: number;
    wallTimeMs: number;
    foregroundWaitMs: number;
  };
  experience: {
    agentErrorCorrections: number;
    missingRequirementTurns: number;
    newRequirementTurns: number;
    unnecessaryClarifications: number | null;
    manualEditRatio: number | null;
    abandoned: boolean | null;
  };
  risk: {
    policyBlocks: number;
    outOfScopeWrites: number;
    forbiddenSideEffects: number;
    secretExposureEvents: number;
  };
  subscription: {
    planPoolId: string;
    estimatedCapacityUnits: number | null;
    throttleEvents: number;
    cooldownMs: number;
    exhaustionContribution: number | null;
  };
  systemHealth: {
    behaviorBundleBytes: number;
    stablePromptTokens: number;
    componentCount: number;
    executableComponentCount: number;
    directDependencyCount: number;
    policyOverlapScore: number | null;
    buildTimeMs: number | null;
    startupTimeMs: number | null;
    upstreamPatchLines: number;
    upstreamPatchCount: number;
    declaredFailureSurfaceCount: number;
  };
}
```

数据库保留整个向量。部署 policy 可以在硬约束后选择 Pareto 点，但不能只保留一个 reward。`systemHealth` 防止候选通过不断增加 prompt、skills、hooks、依赖和 core patch 获得短期收益；不同 lineage 可以有不同 complexity budget，但增长必须可见。

### 14.2 任务分层

至少记录：

```text
task kind: bugfix / feature / refactor / review / research / docs / infra / automation
language/framework
repository
estimated size
initial ambiguity
risk level
test availability
interactive vs autonomous
foreground urgency
```

Credit 在 strata 内计算，再按真实工作分布聚合。否则优化器可能通过偏爱简单任务制造表面提升。

### 14.3 Credit 的四层递进

第一层：activation credit。先回答完整可执行候选是否比 baseline 好，这是所有发布的必要证据；只有 kernel/closure 相同的实验才可进一步简写成 bundle credit。

第二层：单轴 credit。默认 ChangeSet 只换一个组件，使用配对任务估计边际效果。

第三层：局部反事实。在相同 transcript 决策点、workspace snapshot 和模型条件下替换 router/context/tool/verify 决策；固定可固定的后续条件，估计局部差异。

第四层：长期 production credit。用真实用户纠正、revert、复用和维护成本更新 posterior。

默认一个 episode 只对应一个 activation。若用户明确要求在 active episode 中切换，记录 `mixedActivationEpisode=true`：可以在切换点拆成父/子 episode，或只对可定位的 interaction/run 分配 credit；不能把整个结果归给最后一个 activation。

### 14.4 可复现 Replay 的真实边界

Pi 的 session tree fork 只复用 transcript，不等于环境反事实。Replay snapshot 至少包含：

- base commit 和 tracked tree；
- staged/unstaged/untracked patch；
- 相关外部文件 artifact；
- `artifactViewDigest` 及其精确可达 artifact 集合；
- 持久状态的只读视图与 snapshot；
- dependency/lock fingerprint；
- command/tool fixture；
- provider/model 参数；
- bundle 和 evaluator epoch；
- 必要时的网络响应 fixture。

不能稳定复现的外部操作只做 shadow 或人工评估，不伪装成确定 replay。

### 14.5 配对与不确定度

优先使用同一任务 baseline/candidate 配对差值，随后用分层 Bayesian posterior 或 bootstrap 区间聚合。Ledger 保存：

```text
activation/component/bundle digest
task stratum
mean/posterior delta per metric
credible interval
effective sample size
replay/live evidence weight
last updated
evaluator epoch
```

不输出“context-v7 = 0.73”这种失去条件的分数。

### 14.6 Evidence 权重

默认关系：

```text
live accepted outcome > faithful paired replay > synthetic replay
deterministic verification > human explicit feedback > LLM judge
recent matching stratum > distant stratum
```

Replay 可快速淘汰候选，但不能长期替代真实 workload。Live canary 数量小，却应在 posterior 中有更高现实权重。

### 14.7 Promotion gate

每个 activation action 的最终门是三者的交集：Constitution 通用硬门、解析后的 `ActionGateProfile`、有效 ApprovalGrant。一个候选至少满足：

1. capability、scope、预算和审批范围没有越界；
2. Constitution/Core contracts 通过；
3. universal risk 指标零退化或在明确容忍范围；
4. EvaluationReport 绑定 active evaluator epoch manifest 与解析后的 gate profile digest；
5. profile 要求的 unit、distinct、live evidence weight 和目标 strata 覆盖达到最小值；
6. profile 的全部 metric conditions 通过，高权重 strata 无 profile 禁止的负迁移；
7. subscription capacity 和前台等待在对应 subsystem 的预算内；
8. system-health/complexity 没有越过 lineage budget，或收益满足 profile 明示的 complexity tradeoff；
9. rollback artifact 已存在并验证；
10. 所需 approval grant 有效且所有 digest 匹配。

Worker promotion profile 的示例，而不是其他 subsystem 的固定 gate：

```text
P(quality_delta >= -epsilon) >= 0.99
P(target_utility_delta >= minimum_gain) >= 0.95
risk_regression <= allowed_risk
canary_interactions >= worker.promote.profile.evidence.minimum
```

Meta profile 可以用 candidate yield 和长期 ROI；Research profile 用精度、可复现和转化率；Evaluator profile 用校准、扰动鲁棒性和泄漏检查；Scheduler profile 用前台 SLO、耗尽风险和后台有效产出。它们都受 universal risk/approval/rollback contract 约束，但不能被迫套用 Worker 的 `quality_delta`。样本不足时状态是“证据不足”，不是失败，也不能自动 promoted。

### 14.8 Evaluator epoch 与 Goodhart 控制

Candidate 只能看到公开 contract、训练/evolution set 和上一轮失败摘要；temporal holdout、live assignment 和部分质量门保留在 Supervisor。Evaluator 升级建立新 epoch，不能与 candidate 的比较基线同时改变。定期检查某指标改善但真实接受率、revert 或维护成本恶化的代理失真。

### 14.9 用户需求变化不扣错分

反馈分类至少为：

```text
agent_error
missing_requirement
new_requirement
preference_change
normal_continuation
explicit_positive
explicit_negative
unknown
```

只有 `agent_error` 直接进入错误纠正指标。`missing_requirement` 是否归因于 agent，取决于当时是否存在足够线索以及澄清成本；`new_requirement` 不算失败。

## 15. Research Scout：持续吸收全网经验

### 15.1 目标

Research Scout 不是每天生成一篇泛泛综述，而是维护“外部证据 → 本地可测试假设”的供应链。任何论文、仓库或工程方案要进入候选池，都必须回答：

1. 它解决了什么可观察问题；
2. 依赖哪些假设和接口；
3. 对应 Evo-Pi 的哪个 surface/stage；
4. 如何做最小本地实验；
5. 成功、非劣和停止条件是什么；
6. 预计消耗多少 subscription capacity。

### 15.2 来源层

按稳定性和用途分层：

- P0 官方资料：provider API、prompt cache、模型、SDK、Pi upstream；
- P1 原始研究：arXiv、OpenReview、会议 proceedings；
- P2 学术图谱：OpenAlex、Semantic Scholar、Crossref；
- P3 工程实现：GitHub releases、commits、issues、agent 仓库；
- P4 开放网络：研究团队博客、技术文章、讨论。

P0/P1 提供事实和方法；P2 用于引用图、作者和去重；P3 用于可执行结构与失败经验；P4 用于发现线索。Research Card 明确来源等级，不能把博客转述当作论文实证。

### 15.3 数据管线

```text
Research Agenda
  → query planner
  → public query boundary
  → source-specific adapters
  → raw response CAS + HTTP metadata
  → normalize identifiers
  → deduplicate / version-link
  → citation + implementation graph
  → deterministic filters
  → Research synthesizer triage top-N
  → ProposedResearchCard
  → deterministic provenance gate
  → ResearchCard
  → local seam mapping
  → Meta-Pi candidate design
  → Opportunity / Candidate
```

所有 Research run 的 `executorRole=research`，但必须再选择一个固定 `executorProfile`；Capability Resolver 对 profile ceiling、research subsystem ceiling 和 task grant 求交，缺少 profile rule 直接拒绝：

| Executor profile | 模型/plan | 网络与文件能力 | 唯一输出 |
|---|---|---|---|
| `research-fetch` | `planAuthorization=none`；无 coding-plan credential | 只能向 Constitution fetch broker 提交 PublicResearchQuery；可写 source-cache staging，无 provider 直连 | raw response/metadata artifact |
| `research-parser` | `planAuthorization=none`；无 coding-plan credential | 默认断网；只读指定 raw artifacts，可写 parsed staging | normalized/version observation artifact |
| `research-synthesizer` | observe-only 迁移期可 observed，enforced 后必须 leased | 无 source network、无 raw cache 写；只读精确 ArtifactView，只写 card staging | `ProposedResearchCard` |

API/RSS 拉取、去重和元数据解析不使用 coding plan。摘要理解和跨文献综合可以复用与 Meta-Pi 相同的 coding-agent executable、模型订阅和底层 runtime，但取得独立 PlanLease/ArtifactView。`executorRole=meta` 只消费通过 schema/provenance gate 的 `ResearchCard`，负责本地 seam mapping 和 candidate design，不读取 raw source cache。任何 run 同时得到 fetch network/cache-write 与 coding-plan credential 都是 grant compiler error。

由私有 episode 生成检索词时，只把问题抽象成公开 taxonomy 和机制问题；不把私有代码、diff、路径、用户原话或凭据发送给公共搜索服务。这一转换同时在私有映射表记录 internal pain ID，ID 本身不进入 outbound query。

```ts
interface PublicResearchQuery {
  queryId: string;
  publicTerms: string[];
  taxonomyTags: string[];
  mechanismHints: string[];
  allowedSourceIds: string[];
  firewallReportDigest: string;
}
```

Constitution-owned `QueryFirewall` 是发送前的确定性边界，不依赖 LLM 自己保证脱敏，也不属于可进化 query planner。它从 allowlisted taxonomy/术语构造 public query，拒绝绝对/工作区路径、私有 URL、用户标识、长代码片段、secret pattern、高熵 token 和未批准的原始文本；再把最终请求 payload digest、source、时间和 verdict 写入只追加出站审计。无法确定是否公开安全时 fail closed，进入人工 review；private pain ↔ public query 的映射只保存在 Supervisor view。Research 可以优化 query proposal 和 taxonomy，但不能绕过 firewall。

### 15.4 ResearchSource 接口

```ts
interface ResearchSource {
  id: string;
  discover(
    query: PublicResearchQuery,
    cursor: string | null,
    validators: {
      etag: string | null;
      lastModified: string | null;
    },
    budget: {
      maximumRequests: number;
      maximumItems: number;
      deadlineAt: string;
    },
  ): AsyncIterable<RawResearchRecord>;
  normalize(rawArtifact: string): Promise<NormalizedResearchRecord[]>;
  enrich(
    item: NormalizedResearchRecord,
    fields: string[],
    budget: {
      maximumRequests: number;
      deadlineAt: string;
    },
  ): Promise<SourceObservation[]>;
  rateLimitPolicy: {
    requestsPerWindow: number;
    windowMs: number;
    minimumBackoffMs: number;
  };
}

interface ResearchIdentifier {
  scheme:
    | "doi"
    | "arxiv"
    | "openreview"
    | "proceedings"
    | "openalex"
    | "semantic-scholar"
    | "fuzzy";
  value: string;
  sourceId: string;
  firstObservedAt: string;
}

interface ResearchWork {
  workId: string;
  aliases: ResearchIdentifier[];
  mergedIntoWorkId: string | null;
  title: string;
  authors: string[];
  codeRepositories: string[];
  publishedAt: string | null;
  references: string[];
  citations: string[];
}

interface ResearchVersionObservation {
  observationId: string;
  workId: string;
  sourceId: string;
  sourceVersionId: string;
  version: string | null;
  abstractArtifact: string | null;
  fullTextArtifact: string | null;
  contentDigest: string;
  updatedAt: string | null;
  observedAt: string;
  provenanceUrl: string;
}

interface NormalizedResearchRecord {
  work: ResearchWork;
  version: ResearchVersionObservation;
}
```

外部 identifier 的匹配优先级：

```text
DOI
  > arXiv base id
  > OpenReview forum id
  > proceedings id
  > OpenAlex work id
  > Semantic Scholar paper id
  > normalized-title/author/year fuzzy key
```

`workId` 是首次入库时分配且永不重键的内部 ID；上面的优先级只用于提出 alias match，不用于替换主键。arXiv v1/v2、OpenReview revision、网页更新等都存为独立 `ResearchVersionObservation`，共享同一 work，证据必须引用具体 observation/content digest。后发现 DOI 时只追加唯一 alias。若两个 work 后来确认重复，事务写入 winner/loser merge record，并把 loser 的 `mergedIntoWorkId` 设为 winner；旧 evidence ref 继续可解析，不能批量重写后留下悬空引用。拆分错误 merge 需要显式 inverse record 和审计，不静默复用旧 ID。GitHub 仓库与论文通过显式 URL、README citation、作者和标题线索建立有置信度的边。

### 15.5 Research Card

```ts
interface ProposedResearchEvidenceRef {
  workId: string;
  versionObservationId: string;
  artifactDigest: string;
  locator: {
    kind: "page" | "section" | "paragraph" | "line" | "url-fragment";
    value: string;
  };
  excerptDigest: string | null;
}

interface ResearchEvidenceRef extends ProposedResearchEvidenceRef {
  sourceGrade: "official" | "primary" | "implementation" | "secondary";
  evidenceValidationDigest: string;
}

interface ProposedResearchAssertion {
  kind: "claim" | "mechanism" | "setting" | "assumption" | "limitation";
  text: string;
  stance: "support" | "against" | "neutral";
  evidence: ProposedResearchEvidenceRef[];
  inferenceHint: boolean;
}

interface ResearchAssertion {
  kind: "claim" | "mechanism" | "setting" | "assumption" | "limitation";
  text: string;
  stance: "support" | "against" | "neutral";
  evidence: ResearchEvidenceRef[];
  inference: boolean;
}

interface ResearchCardBody<TAssertion> {
  id: string;
  workIds: string[];
  versionObservationIds: string[];
  assertions: TAssertion[];
  reproducibility: "none" | "partial" | "artifact" | "locally-replicated";
  targetSurfaces: EvolutionSurface[];
  requiredSeams: string[];
  localHypotheses: string[];
  proposedExperiments: string[];
  expectedPlanCapacity: number;
  novelty: number;
  relevance: number;
  confidence: number;
}

type ProposedResearchCard = ResearchCardBody<ProposedResearchAssertion>;

interface ResearchCard extends ResearchCardBody<ResearchAssertion> {
  provenanceGateReportDigest: string;
}

interface ResearchReviewAnnotation {
  schemaVersion: number;
  annotationId: string;
  researchCardDigest: string;
  verdict: "accepted" | "qualified" | "rejected";
  notesArtifact: string | null;
  reviewedBy: string;
  issuedAt: string;
  signatureDigest: string;
}
```

Research synthesizer 只能输出 `ProposedResearchCard`。Constitution-owned provenance gate 从 source registry 派生 `sourceGrade`，并验证每个 evidence 的 work alias/merge resolution、version/content digest、artifact 是否属于该 synthesizer 的 ArtifactView、locator 是否可解析以及 excerpt digest 是否匹配。无 evidence 的 assertion 一律派生为 `inference=true`；外部事实若 producer 声称非 inference 却没有有效 evidence，proposal 直接拒绝。Gate 把通过的 artifact 标记为 `provenance-validated`，但它仍只是数据，不升级成 control instruction。

Claim、mechanism、evaluation setting、assumption 和 limitation 中的外部事实都逐条绑定具体 work/version/artifact/locator。人工 review 不由 producer 写布尔值，而是独立签名的 `ResearchReviewAnnotation`，可撤销或追加新 verdict，不改变原 Card digest。Card 允许结论为“不适用”；这也是有用结果，可以避免后续 Meta-Pi 反复重新发现同一方案。

### 15.6 Research Agenda

Agenda 同时由三类 query 组成：

- persistent themes：self-improving agent、credit、context、cache、tools、verification、runtime、memory、workflow；
- pain-directed queries：从近期 opportunity 自动生成，例如“tool output duplication coding agent”；
- lineage-neighbor queries：追踪已采用论文的后续引用、作者项目、代码 release 和批评性结果。

默认节奏：

```text
每小时：轻量 metadata/RSS 增量拉取
每天：去重、引用/仓库链接、deterministic 排序
每天空闲期：Research synthesizer triage top-N
每周：跨来源 synthesis + candidate shortlist
每月：research agenda、来源质量和失败假设审计
```

所有周期都由 plan 状态和用户 quiet hours 约束，不保证在额度紧张时运行。

### 15.7 从论文到代码的门

外部内容永远先变成 Research Card，不能直接成为可执行 extension。进入 Candidate 前必须指定：

```text
local seam
baseline
minimal mutation
target strata
observable metrics
capacity budget
rollback unit
approval level
```

论文报告数字只用于 prior，不作为本地 promotion 证据。代码仓库可作为实现参考，但依赖和许可先进入普通代码审查。

### 15.8 Source cache 与礼貌抓取

保存 ETag、Last-Modified、cursor、响应 digest、抓取时间和退避状态；遵守来源 API 的分页、速率和重试建议。原始响应进 CAS，解析器升级时可离线重放，避免重复请求。全文只在 license/接口允许时保存；否则保存元数据、摘要和链接。

Source adapter 只能通过 Constitution-owned fetch broker 请求自己声明的 HTTPS domain allowlist，不能接受文档内容提供的任意 URL 或自行开网络连接。Broker 在首跳和每次 redirect 后重新 canonicalize URL、解析 DNS，并拒绝 loopback、private、link-local、multicast、Unix socket 和云 metadata endpoint；限制 redirect 数、连接/读取时间、压缩前后字节、解压比、文档页数和嵌套深度。声明 MIME、magic-byte sniff 和所选 parser 必须一致。HTML/PDF/archive parser 在固定 sandbox launcher 创建的无凭据、默认断网、只读输入和有限 CPU/memory/output 的独立进程或容器中运行；超限产物标记为 rejected artifact，不交给模型。Research 可以优化 adapter/parser 实现，但不能修改 broker 或 sandbox envelope。

### 15.9 不可信外部内容与角色化 Artifact View

论文 PDF、网页、README、issue、代码注释和搜索摘要都是证据数据，不是 Evo-Pi 的控制指令。Research fetch/parser 不拥有 coding-plan credential；synthesizer 只能取得当前 run 的 brokered plan handle，不能读取原始凭据。三种 profile 都不拥有用户 workspace、active registry、审批密钥、temporal holdout 或审计账本写权限。解析结果先经过 schema、长度、URL、media type、字符集和 provenance 校验；文档中要求“执行命令、读取文件、安装依赖、忽略规则、上传信息”的文本只作为被引用内容保留，不进入 tool/control channel。

Supervisor 为每个 executor 生成内容寻址、只读、带过期时间的角色视图：

```ts
type ArtifactTrustClass =
  | "control"
  | "private-workload"
  | "public-metadata"
  | "external-untrusted"
  | "derived-untrusted"
  | "provenance-validated";

interface ArtifactView {
  schemaVersion: number;
  viewId: string;
  runId: string;
  attemptId: string;
  executorRole: EvolvableSubsystem;
  executorProfile: ExecutorProfile;
  activationDigest: string;
  rootDigest: string;
  readableArtifactDigests: string[];
  allowedTrustClasses: ArtifactTrustClass[];
  issuedAt: string;
  expiresAt: string;
}
```

Supervisor 在 assignment 时只生成一次 view，并把同一 `artifactViewDigest` 写入 AssignmentSpec、ResolvedRunInput、RunSpec context 和 CapabilityGrant；ExecutorRunResult/RunResult 必须原样回报。Launcher 只挂载该 digest 能到达的 artifact，replay 也固定同一 view。任何一处 digest 不一致、artifact 越出 view 或共享目录出现额外文件，run 在启动前或 finalization 时失败。

- Worker 只看当前任务、active activation 和必要用户/仓库上下文；
- Meta 看脱敏 trajectory、公开 gate contract、`provenance-validated` ResearchCard、candidate worktree 和失败摘要；raw/parsed source artifact 不得进入其 view，且它看不到 holdout membership、assignment salt、隐藏 anti-gaming probes、审批密钥或可变审计库；
- Research-fetch 只看公开 taxonomy/脱敏 query，Research-parser 只看指定 raw artifacts，Research-synthesizer 只看筛选后的 source evidence；三者都不看私有代码/diff/原始用户消息，且不能互换 profile grant；
- Evaluator 看固定 epoch 的 evidence view 与 holdout，但不能写 raw facts、candidate 源码、approval policy 或 active epoch pointer；
- Plan scheduler 只看聚合 arrival/usage/lease view，不能签发 permit 或修改 ledger。

Meta-Pi 从 Research Card 接收带 provenance 的 claim、mechanism、限制和实验提示，不把外部原文拼接成高优先级 system instruction。外部代码只有在许可检查后固定到 commit/content digest，并在无凭据、默认断网、受限文件系统/进程/资源、无 active registry 写权限的容器或 VM 中构建和测试；worktree 只提供版本隔离，不被视为执行边界。是否进入 candidate 仍由本地 ChangeSpec、CapabilitySet、EvaluationReport 和审批协议决定。

## 16. Subscription Coding Plan Broker

### 16.1 计费模型变化带来的核心结论

Worker 和 Meta-Pi 都通过订阅 coding plan 使用模型，因此优化目标不是传统的 `USD/token`。真正稀缺资源是一个可能不透明、按时间窗恢复、会 throttle/cooldown 的 plan capacity，以及用户前台等待时间。

系统应优化：

```text
accepted foreground tasks per plan window
foreground completion latency
probability of quota exhaustion before reset
meta improvements promoted per capacity unit
long-run improvement created per background run
```

Token、cache token 和 provider usage 仍记录，但它们是解释变量；除非实测证明，不假设 token 下降会线性增加订阅可用额度。

### 16.2 PlanPool 与适配器

```ts
type PlanState = "healthy" | "constrained" | "cooldown" | "exhausted" | "unknown";

interface PlanPool {
  id: string;
  provider: string;
  accountRef: string;
  sharing: "shared" | "separate";
  roles: EvolvableSubsystem[];
  poolEpoch: string;
  state: PlanState;
  resetAt: string | null;
  observedRemaining: number | null;
  estimatedRemainingUnits: number | null;
  confidence: number;
}

interface PlanAdapter {
  observe(): Promise<PlanPool>;
  classifyResponse(response: ProviderResponseSummary): PlanSignal[];
  estimateRun(request: RunEstimateRequest): CapacityEstimate;
}
```

Adapter 只使用 provider 合法暴露的信息、响应和本地观测；如果没有剩余额度 API，就维护带区间的估计，而不是伪造精确数字。Pi 当前只能通过 `ModelRegistry.isUsingOAuth()` 判断 OAuth，OAuth 本身不等于 coding-plan 计费。OpenAI Codex 的 `plan_type`、`resets_at` 等信息只在部分限额错误后出现，也没有主动查询精确余量的接口。因此部署配置必须明确某个 provider/account 是否属于实际 subscription pool，Plan Broker 把容量视为部分可观察状态。

`poolEpoch` 是 Broker 持久化的容量窗口身份。Provider 给出可靠 reset/window ID 时采用其哈希；否则由 `accountRef + observed reset boundary + broker generation` 生成保守 epoch。观察到 reset、账户切换或估计状态不连续时，Broker 原子 rollover：冻结旧 epoch、撤销未开始 permit、让已在途请求只收尾，并拒绝旧 epoch 创建新 permit。重启从 ledger 恢复 epoch，不能仅按本机时钟重新猜一个相同 ID。

### 16.3 Shared 与 separate plan

部署配置必须显式表示：

```text
shared:
  worker_pool == meta_pool
  foreground stops new background permits
  reserve is a probabilistic SLO under partial observability

separate:
  worker_pool != meta_pool
  each pool has independent policy
  meta exhaustion cannot block worker
```

若当前两个 Pi 使用同一订阅，默认按 shared 处理。若实际是两个订阅账户，则配置成 separate；不能从进程名推断。已经发出的 provider request 通常不能瞬时抢占，未知 quota 下也不能硬证明“保留 75%”。若用户要求前台容量的硬隔离，必须使用 separate plan，或只在严格 quiet-hours 运行后台模型调用。

### 16.4 Plan lease

```ts
interface PlanEnforcementEpoch {
  schemaVersion: number;
  epochId: string;
  mode: "observe-only" | "enforced";
  planPoolIds: string[];
  allowedObservedActivationDigests: string[];
  issuedAt: string;
  expiresAt: string;
}

interface PlanEnforcementTransition {
  schemaVersion: number;
  expectedActiveEpochDigest: string | null;
  newEpochDigest: string;
  reason: string;
  approvedBy: string;
  issuedAt: string;
  signatureDigest: string;
}

type PlanAuthorization =
  | { mode: "none"; reason: "deterministic-no-model" }
  | { mode: "observed"; usageCorrelationId: string }
  | { mode: "leased"; planLeaseId: string };

type PlanLeaseState =
  | "issued"
  | "reserved"
  | "active"
  | "consumed"
  | "revoked"
  | "expired";

interface PlanLease {
  leaseId: string;
  runId: string;
  attemptId: string;
  poolId: string;
  poolEpoch: string;
  planEnforcementEpochDigest: string;
  executorRole: EvolvableSubsystem;
  executorProfile: ExecutorProfile;
  costCenter: "foreground" | "evolution" | "research" | "maintenance";
  serviceClass: "P0" | "P1" | "P2" | "P3" | "P4" | "P5";
  estimatedUnits: number;
  maximumEstimatedUnits: number;
  consumedEstimatedUnits: number;
  maxLogicalProviderRequests: number;
  maxTransportAttempts: number;
  maxWallTimeMs: number;
  maxOutputTokens: number;
  preemptible: boolean;
  state: PlanLeaseState;
  checkpointArtifact: string | null;
  issuedAt: string;
  expiresAt: string;
}

interface LogicalProviderRequestPermit {
  permitId: string;
  leaseId: string;
  logicalRequestId: string;
  requestOrdinal: number;
  singleUseNonce: string;
  maximumOutputTokens: number;
  state: "reserved" | "active" | "consumed" | "revoked" | "expired";
  issuedAt: string;
  expiresAt: string;
}

interface ProviderAttemptPermit {
  permitId: string;
  leaseId: string;
  logicalRequestId: string;
  transportAttemptOrdinal: number;
  singleUseNonce: string;
  state: "reserved" | "active" | "consumed" | "revoked" | "expired";
  issuedAt: string;
  expiresAt: string;
}
```

Constitution registry 只有一个 active `PlanEnforcementEpoch` pointer。`observe-only` 是迁移期模式，必须有短期 expiry，并只允许 `allowedObservedActivationDigests` 中人工固定的可信 activation 使用 `observed`；候选 activation 不得进入 allowlist。切换为 `enforced` 后，任何会调用模型的 run 都必须使用 `leased`，wrapper/proxy 在 provider 请求前同时验证 active epoch digest，不能仅相信 RunSpec 自报模式。过期、非 active 或 pool 不匹配的 epoch 一律 fail closed。Epoch 只能通过人工签名、compare-current 的 `PlanEnforcementTransition` 更新；ApprovalPolicy、Plan scheduler 和普通 candidate 都不能生成 transition。回到 observe-only 必须新建更短 expiry 的人工 transition，不能静默降级。

每个需要模型的 run/attempt 先取得不可复用的 lease。一次 agent stream 调用消费一个 `LogicalProviderRequestPermit`；每次真实 HTTP/WebSocket/fallback/retry attempt 再消费一个 `ProviderAttemptPermit`。重复 nonce、跨 run lease、过期/撤销 lease 和超过任一硬计数预算的请求都被拒绝。`maximumEstimatedUnits` 只是软估计，不能冒充 provider quota enforcement。Meta/Research/Evaluator run 必须可在阶段边界 checkpoint；前台任务到达时，Supervisor 不启动新的低优先级 permit，并在安全边界暂停已有后台 workflow。

#### 可信 provider enforcement seam

普通 coding-agent `before_provider_request` extension 只能做观测/变换，不能承担 permit enforcement：当前 runner 会隔离 handler error，不能保证 fail-closed。MVP 的 Evo launcher 必须在 `createAgentSessionFromServices()` 返回后、把 session 暴露给 TUI/RPC 之前，捕获并替换公开的 `AgentSession.agent.streamFn`：

```text
Pi requests stream
  → Constitution-owned stream wrapper
  → validate RunSpec + active PlanEnforcementEpoch + PlanLease
  → atomically consume LogicalProviderRequestPermit
  → for eligible direct adapter, consume paired ProviderAttemptPermit
  → delegate to original Pi streamFn
```

Wrapper 不属于 BehaviorBundle；launcher 在每次 session/runtime replacement 后重新安装并验证其 digest。Direct-wrapper 模式只允许 adapter capability manifest 声明“可强制单 transport attempt、无隐藏 fallback”；launcher 固定 `maxRetries=0`，Broker 的 retry policy 必须重新调用 stream 并签发新的 logical/attempt permits。无法关闭内部 retry/fallback 的 adapter 不允许用 wrapper 宣称 attempt 级 hard accounting。

Wrapper 能对标准 Pi `streamFn` 路径 fail-closed，但不是任意同进程代码的 credential boundary：当前 extension 可经公开 ModelRegistry API 取得 provider 凭据，也可能自行发起网络请求。因此 wrapper 只用于固定、可信、没有凭据/网络旁路 capability 的 executor。任何 S3/S4 candidate、第三方 extension、不可证明单 attempt 的 adapter 或其他任意进程内代码都必须使用独立 provider/credential proxy 加 OS capability isolation：Worker 进程不持有原始订阅凭据，出站 provider domain 只允许到本地 proxy。Proxy 先消费 logical permit，并由自己在每个 upstream retry/fallback 前向 Broker 取得新的 attempt permit；客户端重放同一 nonce 会被拒绝。若将来 Pi core 提供不可绕过的 attempt-level provider authorization seam，可替代标准路径 wrapper；不能复用会吞错的普通 extension hook。

Assignment 与计费维度正交。例如真实 canary 的 `executorRole=worker`、`costCenter=foreground`，只是在 RunSpec 中 `assignment=canary`；paired replay 可同样由 Worker kernel 执行，但 `costCenter=evolution`。Evaluator 使用模型时必须取得自己的 lease，不能隐藏在 Worker/Meta 统计中。

### 16.5 优先级

```text
P0  用户等待中的 worker
P1  用户明确要求立即运行的分析/优化
P2  已获批 canary 的必要验证
P3  高价值 paired replay
P4  research triage / candidate build
P5  frontier exploration / archive maintenance
```

同级内按截止时间、机会价值和预计 capacity 排序。不能让大量短 Meta 任务通过拆分逃避总预算。

### 16.6 前台储备

Shared plan 为 worker 保留动态 reserve。初始可设置为窗口估计容量的 70%–80%，随后按用户工作时段、历史到达率、恢复时间和估计误差调整。

```text
available_for_meta =
  conservative_remaining_estimate
  - foreground_reserve
  - in_flight_commitments
  - uncertainty_margin
```

reserve 是按历史 arrival/throttle 校准的概率性 SLO，不是不变量。状态为 `unknown` 或置信度低于 policy threshold 时，默认禁止新的后台模型 permit，只保留 deterministic ingestion、静态检查和已在途请求收尾。用户可临时选择“今天全力进化”或“暂停所有后台 plan 消耗”。

### 16.7 使用账本

```ts
interface PlanUsageRecord {
  schemaVersion: number;
  usageRecordId: string;
  runId: string;
  attemptId: string;
  authorizationMode: "observed" | "leased";
  usageCorrelationId: string | null;
  leaseId: string | null;
  poolId: string;
  poolEpoch: string | null;
  planEnforcementEpochDigest: string;
  executorRole: EvolvableSubsystem;
  executorProfile: ExecutorProfile;
  costCenter: "foreground" | "evolution" | "research" | "maintenance";
  serviceClass: "P0" | "P1" | "P2" | "P3" | "P4" | "P5";
  assignment: AssignmentKind;
  purpose: string;
  modelClass: string;
  startedAt: string;
  endedAt: string;
  logicalProviderRequests: number;
  providerTransportAttempts: number;
  consumedLogicalPermitIds: string[];
  consumedAttemptPermitIds: string[];
  visibleInputTokens: number | null;
  visibleOutputTokens: number | null;
  cacheReadTokens: number | null;
  throttleSignals: string[];
  cooldownMs: number;
  estimatedCapacityUnits: number;
  estimateConfidence: number;
  usefulResult: boolean | null;
  resultingArtifact: string | null;
}
```

`estimatedCapacityUnits` 通过真实 throttle/reset 观测定期校准。不同模型、thinking level、上下文长度和并发可能有不同消耗曲线。

### 16.8 Meta ROI

```text
meta_yield =
  expected_future_workload
  × posterior_improvement
  × expected_lifetime
  ÷ (generation + evaluation + monitoring capacity)
```

偶发问题只记录；重复问题先用便宜的 policy/memory 修复；只有跨任务结构性瓶颈才花大量 plan capacity 修改 runtime/kernel。候选如果长期没有 promotion 或使用机会，其 lineage 自动降预算。

### 16.9 Plan-aware 降级

Plan 受限时依次：

1. 暂停 frontier research 的 LLM synthesis；
2. 暂停低优先级候选生成；
3. 缩小 replay cohort，保留状态；
4. 只运行 deterministic metadata ingestion 和本地静态检查；
5. 保留前台 worker reserve；
6. exhausted 时明确显示 reset/cooldown 估计，不做无意义重试。

Research 抓取和本地索引无需 coding plan 时可以继续，但不得制造随后必然积压的大量 Meta 队列。

### 16.10 调度器自身如何进化

Plan scheduler 的阈值、reserve、run size 和模型路由均可优化，但它只能提交排序、reserve 和 preemption proposal。Quota 账本、用户优先权、policy clamp、lease/permit issuance、enforcement 和 accounting 属于 Constitution Plan Broker。Scheduler 候选用历史 arrival trace 离线模拟，再在受限 canary 中上线；无论候选输出什么，Broker 都重新验证并可拒绝。

## 17. Cache 优化：完整进化协议的一个实例

### 17.1 五层缓存

1. Provider prompt cache：稳定前缀、tool schemas、retention 和 provider key。
2. Context/artifact cache：tokenized snippet、摘要、tool 大输出和 content digest。
3. Repo intelligence cache：symbol、依赖、diagnostic 和文件摘要。
4. Tool result cache：仅适用于声明为纯函数或带完整环境 fingerprint 的调用。
5. Research/replay cache：HTTP 响应、论文解析、snapshot 执行和 evaluator 中间结果。

每层都必须回答：key 是什么、依赖什么、何时失效、是否跨 repo/user、命中是否真的可复用。

### 17.2 当前 Pi 可利用的事实

当前 Pi 已经提供 input、output、cache read、cache write、cost 和 context usage 等 usage 信息，并有 session/model/provider 请求的扩展点。现有 `cache-stats.ts` 用前后 assistant message 的 prompt/cache usage 估计浪费，带 1,024-token noise floor，并在 compaction/branch summary 处重置。它适合作为基线启发式，但存在明确边界：

- 它是 coding-agent 内部模块，当前没有从 package public API 导出；
- 常见调用输入是 session append order，可能包含多 branch，而不是 provider request-ID 序列；
- 不能归因到具体 prompt segment；
- 不包含 compaction/branch-summary 自身的模型 usage；
- raw payload/header hook 能针对部分 provider 看到 key/retention 字段并近似测量到 headers 的时间，但缺少 provider-neutral typed effective options、稳定 request ID、usage/message 关联、完整 end-to-end latency，以及 provider 真正采用策略的确认。

因此 `packages/evo` 第一版应重实现这个很小的 scan 或先增加一个通用 public observation export，不能从内部路径建立长期依赖。

Provider 行为也不同。以下是当前 Pi adapter 的实现事实，不是 OpenAI/Anthropic 的永久通用 contract；上游 provider 改变后必须重新测量：

- OpenAI Responses adapter 默认 short；`none` 去掉 prompt cache key/affinity，`long` 在模型兼容时发送 `24h`，key 来自截断到 64 字符的 session ID；
- Anthropic adapter 默认 short；cache marker 放在 system prompt、最后一个 immediate tool，以及最终 transformed message 为 user 时其最后一个受支持 content block，`long` 在兼容时使用 1h；
- OpenAI Codex 和 Azure OpenAI Responses adapter 目前始终从 session ID 生成 `prompt_cache_key`，没有统一遵守 `cacheRetention`；Codex 还生成对应 session headers。

在 cache identity/retention 这一维，coding-agent 当前固定提供 `sessionId`，却没有在 settings、`CreateAgentSessionOptions` 或 `AgentOptions` 暴露 provider-neutral `cacheRetention`；它同时还会传递环境、timeout、retry、headers 和 transport 等其他 stream options。较新的 `AgentHarnessStreamOptions` 已有 `cacheRetention` 和有序 provider request option patch，这是 P2 core patch 的参考实现。

对实现 `onResponse` 的 adapter/transport，`after_provider_response` 可在消费 stream 前暴露 status/headers；它并非所有 provider/transport 普遍触发，例如部分 Mistral/Google 路径及 Codex 成功 WebSocket 路径没有等价回调。Usage 在之后的 assistant `message_end` 到达。目前缺少跨 adapter 稳定 provider request ID、完整 latency、effective cache policy 和实际 cache key，因此逐请求关联属于必要观测 patch。

第一阶段不先改 provider core，而是通过 recorder 记录：

```ts
type CacheEvidenceSource =
  | "policy"
  | "bundle"
  | "payload"
  | "provider"
  | "usage"
  | "inferred";

interface ObservedCacheValue<T> {
  value: T | null;
  status: "observed" | "absent" | "unknown";
  source: CacheEvidenceSource;
}

interface LogicalRequestCacheObservation {
  schemaVersion: number;
  logicalRequestId: string | null;
  requestOrdinal: number | null;
  correlationQuality: "exact" | "best-effort" | "unlinked";
  provider: string;
  requestedModel: string;
  finalResponseModel: string | null;
  assistantResponseId: string | null;
  successfulProviderAttemptId: string | null;
  providerAttemptObservationDigests: string[];
  activationDigest: string;
  behaviorBundleDigest: string;
  promptLayoutDigest: string;
  segmentDigests: string[];
  toolCatalogDigest: string;
  sessionIdentityIntent: string | null;
  promptCacheKeyIntent: string | null;
  transportAffinityIdentityIntent: string | null;
  finalObservedProviderCacheKey: ObservedCacheValue<string>;
  requestedRetention: string | null;
  finalEffectiveRetention: ObservedCacheValue<string>;
  identityControlStatus: "independent" | "coupled" | "unsupported" | "unknown";
  finalAssistantUsage: {
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    cacheWrite1hTokens: number | null;
  } | null;
  logicalRequestLatencyMs: number | null;
  outcomeEpisodeId: string;
  inferredMissReasons: string[];
  fieldSources: Record<string, CacheEvidenceSource>;
}

interface ProviderAttemptCacheObservation {
  schemaVersion: number;
  providerAttemptId: string | null;
  logicalRequestId: string | null;
  providerAttemptPermitId: string | null;
  transportAttemptOrdinal: number | null;
  transport: "http-json" | "sse" | "websocket" | "provider-sdk" | null;
  attemptReason: "initial" | "retry" | "fallback" | "resume";
  attemptOutcome: "success" | "error" | "fallback" | "cancelled" | "unknown";
  correlationQuality: "exact" | "best-effort" | "unlinked";
  provider: string;
  attemptedModel: string;
  providerHttpRequestId: string | null;
  observedProviderCacheKey: ObservedCacheValue<string>;
  effectiveRetention: ObservedCacheValue<string>;
  cacheControlStatus: "applied" | "unsupported" | "unknown";
  latencyToHeadersMs: number | null;
  attemptLatencyMs: number | null;
  exactAttemptUsage: {
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    cacheWrite1hTokens: number | null;
  } | null;
  fieldSources: Record<string, CacheEvidenceSource>;
}
```

`segmentDigests` 和 intent 来自 bundle/policy，不伪装成 provider 回执；payload/header 只说明 Pi 发出或收到什么；只有 provider 明确返回的字段才能标为 provider-confirmed。一次 logical stream 对应恰好一条 `LogicalRequestCacheObservation`，并通过内容 digest 引用零到多条不可覆盖的 `ProviderAttemptCacheObservation`，因此 P1 前即使 attempt ID 未知也不会丢失记录。`finalObservedProviderCacheKey` 和 `finalEffectiveRetention` 是成功 attempt 的便捷投影，不是第二份事实。最终 AssistantMessage 的 usage、`assistantResponseId` 和 concrete response model 只记在 logical record 一次；HTTP/SDK request ID、attempt latency 和只有 provider 明确逐 attempt 返回的 usage 才进入 attempt record。绝不能把 logical final usage 复制到每个 retry/fallback attempt，也不能把 AssistantMessage response ID 当成 HTTP request ID。

在 enforced epoch 中，每条真实 attempt record 必须通过 `providerAttemptPermitId` 精确绑定一个已消费的 `ProviderAttemptPermit`；observe-only 或 P1 前的 best-effort 记录可以为 null，但不能支持 hard-accounting 或强 promotion 结论。P1 前允许两类 ID 和 ordinal 为 null、使用 best-effort correlation。`requestedModel` 用于 logical routing 归因，`finalResponseModel`/`assistantResponseId` 用于最终模型响应分层，`attemptedModel`/`providerHttpRequestId` 用于 transport 诊断；1h cache write 与普通 cache write 始终分开保存。

### 17.3 Miss attribution

候选原因至少包括：

```text
model/provider changed
stable prefix content changed
stable prefix ordering changed
tool catalog/schema changed
cache key changed
retention expired
prefix below provider threshold
dynamic content leaked into prefix
compaction rebuilt prefix
provider did not expose/accept cache controls
unknown
```

归因优先使用 digest diff 和 provider usage，不让 LLM 凭感觉解释 cache miss。

### 17.4 Cache optimizer operators

- 稳定 prompt sections 的顺序和边界；
- task-conditioned skill metadata filtering、catalog stabilization 和 skill-bank merge/retire；Pi 已有 skill 正文按需加载，不重复实现；
- tool schema 稳定化与按需 tool catalog；
- session/repo cache key 路由；
- provider retention 选择；
- repeated tool output artifact 化；
- context snippet content addressing；
- repo index 增量失效；
- compaction 后 stable prefix 保留；
- replay result reuse。

每个 operator 仍走普通 Candidate pipeline。Cache hit rate 不是最终目标；目标是保持质量约束下的 plan capacity、前台 latency 和 provider workload 改善。

### 17.5 Retention router

```ts
interface CacheRetentionDecision {
  provider: string;
  requestedRetention: string | null;
  sessionIdentityIntent: string | null;
  promptCacheKeyIntent: string | null;
  transportAffinityIdentityIntent: string | null;
  expectedReuseWithinMs: number | null;
  expectedPrefixTokens: number;
  confidence: number;
  reason: string;
}
```

Router 根据 session 活跃度、后台 replay 批次、provider 能力和预测复用窗口做选择。不同 provider 的语义不能被抽象成一个假想的统一 TTL；adapter 保留原生能力，policy 使用统一意图。

在当前 coding-agent 中，这个结构首先是“决策与观测协议”；除 provider-specific raw payload/header hooks 外，`cacheKey/cacheRetention` 尚不能完整应用。Adapter 必须返回 requested、effective 和 unsupported 字段，不能把未采用的 intent 记为实际策略。

### 17.6 Cache 实验中的 session 控制

Pi 的 session ID 影响 OpenAI Responses、OpenAI Completions、OpenAI Codex、Azure OpenAI Responses、Mistral，以及显式启用 session-affinity 的 Anthropic-compatible provider；具体 adapter 是否把它用于 cache key、transport connection/fallback state、affinity 或 header 必须按固定源码版本记录。它不普遍决定 Anthropic 官方 prompt cache 身份。new/fork 会生成新 session ID，因此对受影响 provider 不能简单“为 A/B 各 fork 一个 Pi session”后把 cache 差异归因于 prompt policy。

Cache replay 必须显式声明：

```text
cache state: cold | warm
session identity
prompt cache key
transport/affinity identity
warm-up requests
model/provider
retention intent
idle interval
session transcript
workspace snapshot
```

质量实验可以使用独立 session；cache 实验需要等价 prompt key、transport/affinity state 和 warm-up，或把 cold-start 本身作为被测因素。P2 前若 provider 把这三种 identity 耦合，实验必须标为 partial-control，不能把 transport 重连或 affinity 变化归因于 cache policy。

### 17.7 Cache 实验例

```text
Opportunity:
  TypeScript 日常任务第二轮 cache-read 比例低，且 stable tool schemas 未变

Hypothesis:
  repo context 被插入到 tool schema 之前，使前缀每轮变化

Candidate:
  prompt compiler 把 repo context 移到 session-stable middle

Evaluation:
  相同 session 的真实 trace replay
  baseline vs candidate
  检查 cache-read、latency、context completeness、task quality

Promotion:
  quality non-inferior
  no required context loss
  cache-read/token or latency posterior improves
  shared plan exhaustion proxy does not worsen
```

这套“观测 → 归因 → operator → 配对实验 → gate → promotion”协议同样适用于 prompt、tools、runtime、skills、verification 和 model routing；cache 只是最容易量化的示例。

### 17.8 不做的错误假设

- 不把 cache-read token 当作必然减少 subscription quota；
- 不为了命中率保留已经过期或错误的上下文；
- 不跨用户/敏感 scope 复用 cache；
- 不缓存带未声明外部状态的 mutation tool；
- 不因 provider usage 字段缺失就填 0；
- 不让 prompt prefix 稳定性阻止必要的安全或用户规则更新。

## 18. Supervisor 协议

### 18.1 协议原则

Worker、Meta-Pi、Evaluator 和 Supervisor 通过版本化消息与 artifact 通信，不共享可任意修改的内存对象。所有协议具备：

- `schemaVersion`；
- 全局唯一 ID；
- 内容 digest；
- producer bundle/run；
- 时间和 parent trace；
- 可重放的状态转换；
- unknown/null 语义；
- 向后不兼容时的显式 migration。

### 18.2 RunSpec

```ts
interface RunContext {
  kind: "interactive" | "workspace-background" | "stateless-background";
  interactionId: string | null;
  episodeId: string | null;
  workspaceSnapshotId: string | null;
  stateReadViewDigest: string | null;
  stateSnapshotDigest: string | null;
  artifactViewDigest: string;
}

interface RunSpec {
  schemaVersion: number;
  runId: string;
  attemptId: string;
  context: RunContext;
  assignmentSpecDigest: string;

  executorRole: EvolvableSubsystem;
  executorProfile: ExecutorProfile;
  lineageId: string;
  assignment: AssignmentKind;
  costCenter: "foreground" | "evolution" | "research" | "maintenance";
  serviceClass: "P0" | "P1" | "P2" | "P3" | "P4" | "P5";

  activationDigest: string;
  behaviorBundleDigest: string;
  kernelDigest: string;
  executionClosureDigest: string;
  subjectActivationDigest: string | null;
  evaluatorEpoch: string;
  evaluatorEpochManifestDigest: string;

  resolvedRunInputDigest: string;
  taskStrata: string[];

  capabilityGrantDigest: string;
  approvalGrantIds: string[];
  planEnforcementEpochDigest: string;
  planAuthorization: PlanAuthorization;

  deadlineAt: string | null;
  checkpointArtifact: string | null;
}
```

`interactive` 必须有 interaction/episode/workspace；`workspace-background` 必须有 workspace、但 interaction/episode 可为 null；`stateless-background` 的三者均为 null。State read-view/snapshot 必须同时为 null 或同时非 null。Deterministic fetch、去重、静态检查和 scheduler simulation 使用 `planAuthorization.mode=none`；只有 active enforcement epoch 为 `observe-only`、activation 位于其 allowlist 且 epoch 未过期时，被动观测 run 才能使用 `observed`；active epoch 为 `enforced` 后，所有模型调用都使用 `leased`。任何真正发出 provider 请求的 run 都不得使用 `none`，也不得在 enforced epoch 使用 `observed`。

### 18.3 RunResult

```ts
type ExecutorTermination =
  | "completed"
  | "aborted"
  | "preempted"
  | "quota"
  | "error"
  | "policy-block";

interface ExecutorRunResult {
  schemaVersion: number;
  runSpecDigest: string;
  runId: string;
  attemptId: string;
  activationDigest: string;
  behaviorBundleDigest: string;
  kernelDigest: string;
  executionClosureDigest: string;
  evaluatorEpoch: string;
  evaluatorEpochManifestDigest: string;
  artifactViewDigest: string;
  trajectoryArtifact: string;
  rawOutcomeArtifact: string;
  workspaceResultArtifact: string | null;
  stateWriteSetArtifact: string | null;
  verificationArtifacts: string[];
  sideEffectArtifacts: string[];
  checkpointArtifact: string | null;
  termination: ExecutorTermination;
}

interface RunResult {
  schemaVersion: number;
  runSpecDigest: string;
  runId: string;
  attemptId: string;
  activationDigest: string;
  evaluatorEpochManifestDigest: string;
  artifactViewDigest: string;
  executorResultDigest: string;
  planUsageRecordId: string | null;
  stateFinalization: {
    status: "not-requested" | "committed" | "conflict" | "rejected";
    stateCommitId: string | null;
  };
  finalTermination: ExecutorTermination | "state-conflict" | "state-rejected";
  finalizedAt: string;
}
```

Executor 只能产生 `ExecutorRunResult`，不能自行声称 state 已提交或 plan 已结算。Supervisor 验证 executor artifact、完成 usage accounting，并让 state owner 对 write-set 执行 CAS 后，才写最终 `RunResult`。因此 state conflict/rejection 是 finalization 结果，不是 executor termination。

Finalizer 使用固定真值表，不能由 candidate 选择：

| Executor termination | write-set | state finalization | final termination |
|---|---|---|---|
| `completed` | null | `not-requested`，commit ID 必须为 null | `completed` |
| `completed` | 非空且 CAS 成功 | `committed`，commit ID 必须非空 | `completed` |
| `completed` | 非空且 CAS conflict | `conflict`，commit ID 必须为 null | `state-conflict` |
| `completed` | 非空但 schema/scope/policy 拒绝 | `rejected`，commit ID 必须为 null | `state-rejected` |
| `aborted/preempted/quota/error/policy-block` | 必须为 null；若 executor 回传则丢弃并记 protocol violation | `not-requested`，commit ID 必须为 null | 必须等于 executor termination |

Replay/shadow 或 capability 不含 durable-state write 时，任何 write-set 都按 schema/scope/policy 拒绝行处理且绝不提交。Workspace result 与 checkpoint 是独立 artifact，不因 state write-set 被丢弃而自动成为 live mutation。

### 18.4 EvaluationReport

```ts
interface EvaluationReport {
  schemaVersion: number;
  reportId: string;
  candidateManifestDigest: string;
  subjectActivationDigest: string;
  baselineActivationDigests: string[];
  evaluatorActivationDigest: string;
  evaluatorEpoch: string;
  evaluatorEpochManifestDigest: string;
  gateProfileDigest: string;
  evaluatedAction: ActivationAction;
  evaluationPlanDigest: string;
  taskStrataResults: string[];
  metricPosteriorsArtifact: string;
  regressionsArtifact: string;
  interactionAnalysisArtifact: string | null;
  evidenceWeight: number;
  planCapacityConsumed: number;
  recommendation:
    | "reject"
    | "more-evidence"
    | "shadow"
    | "canary"
    | "promote";
}
```

### 18.5 ApprovalGrant

```ts
interface ApprovalGrant {
  schemaVersion: number;
  grantId: string;
  approvedBy: string;
  policyDigest: string;
  candidateManifestDigest: string | null;
  candidateClassificationDigest: string | null;
  activationDigest: string | null;
  channelPointerDigest: string | null;
  lineageSetManifestDigest: string | null;
  evaluatorEpochManifestDigest: string | null;
  evaluationReportDigest: string | null;
  gateProfileDigest: string | null;
  effectiveTargets: EvolutionTarget[];
  allowedActions: ActivationAction[];
  allowedThrough: AutomationStage;
  scopeDigest: string;
  issuedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}
```

Exact grant 必须同时绑定 `candidateManifestDigest`、`candidateClassificationDigest`、`activationDigest`、`evaluationReportDigest`、`gateProfileDigest` 和明确的 `allowedActions`。普通 channel action 必须绑定完整 `channelPointerDigest`；若 subsystem 已启用 active lineage set，还必须绑定包含该 pointer 的最终 `lineageSetManifestDigest`。Evaluator epoch action 则只绑定 `evaluatorEpochManifestDigest`，不能同时绑定普通 channel/lineage destination。Standing grant 可以把八个 artifact-specific digest 留空，但必须用 scope/target/classification constraints 和 action 列表限定候选类别；Supervisor 对实际 artifact 重新分类、构造最终 destination 后才判断是否匹配。

#### GenesisGrant：唯一的无 EvaluationReport 激活

系统第一次接管现有 Pi 时还没有 baseline、replay bank 或 EvaluationReport，因此允许一个窄化 bootstrap 例外：

```ts
interface GenesisGrant {
  schemaVersion: number;
  grantId: string;
  subsystem: EvolvableSubsystem;
  activationDigest: string;
  evaluatorEpochManifestDigest: string | null;
  sourcePiCommit: string;
  sourceWorkspaceDigest: string;
  approvedBy: string;
  issuedAt: string;
  onlyIfActivationDestinationHasNoHistory: true;
}
```

GenesisGrant 只能在对应 activation destination 从未存在时，把当前人工确认的原始实现登记为 baseline：普通 subsystem 是 stable channel；Evaluator 是 `evaluators/active`，且必须同时绑定包含该 activation 的 epoch manifest。它不能创建 canary/shadow、升级 candidate、重复使用或绕过之后的 EvaluationReport。Supervisor 一旦写入第一条 destination history，就永久关闭该 subsystem 的 genesis path。

### 18.6 CapabilityGrant

Capability 是 run-specific 的实际权限，不等于 component manifest 的请求。

```ts
interface CapabilityGrant {
  schemaVersion: number;
  grantId: string;
  runId: string;
  attemptId: string;
  executorRole: EvolvableSubsystem;
  executorProfile: ExecutorProfile;
  activationDigest: string;
  artifactViewDigest: string;
  capabilities: CapabilitySet;
  issuedAt: string;
  expiresAt: string;
}
```

最终 grant 是 compiler 派生的 bundle capability envelope、subsystem ceiling、executor-profile ceiling、task scope 和 executor role 的交集。Filesystem 先做 canonical path containment 再取 access 下界；domain/credential/side-effect 取集合交；process command 必须同时匹配 command ID、executable digest 和 argv-pattern language；资源上限取最小值。Launcher 将 `artifactViewDigest` 物化为该 run 独占的只读 `run-artifact-view` mount，不能把它解析成共享的全局 artifact 根目录。Grant 在 launcher 启动时仍须未过期，且只能用于其绑定的 run/attempt/role/profile/activation。

S2 声明式 workflow/skill/verifier 只能引用 stable catalog 中已有的 command ID 和参数槽位。Artifact 一旦新增 raw shell command、可执行路径、argv template、command broker pattern 或扩大既有命令能力，Supervisor 自动分类为 S3/executable behavior，并要求相应 exact approval；不能借“声明式数据”取得 standing promotion。

### 18.7 协议不变量

- ExecutorRunResult 与最终 RunResult 的 `runSpecDigest` 必须指向同一不可变 RunSpec；run/attempt/activation、evaluator epoch manifest 和 artifact view identity 必须与其一致；BehaviorBundle、kernel、ExecutionClosure 和 evaluator epoch 由 ExecutorRunResult 与 RunSpec 一致性校验；
- `activationDigest` 必须等于 RunSpec 对应 `ActivationTuple` 的 canonical hash；
- RunSpec `executorRole`、ActivationTuple `subsystem`、BehaviorBundle `subsystem` 和目标 activation namespace 必须一致；普通 subsystem 映射到自身 channel，Evaluator 只通过 epoch manifest 映射；
- `RunSpec.assignmentSpecDigest` 必须解析到同 run/attempt/role/profile/lineage/activation/assignment 的 AssignmentSpec；其 decision digest 必须解析到同一选择，固定 Assignment Engine 重新验证 feature view、scope、strata、cohort 和 scoped budget。真实 stable/canary 的 selected/source ChannelPointer、activation、lineage 和 assignment policy 必须一致；
- AssignmentSpec、ResolvedRunInput、RunSpec context、CapabilityGrant、ExecutorRunResult 和 RunResult 的 `artifactViewDigest` 必须完全相同。ArtifactView 与 CapabilityGrant 的 run/attempt/role/profile/activation 必须匹配 RunSpec、均未过期；view 中每个 artifact 同时满足精确 digest、privacy scope 和 `allowedTrustClasses`，`ArtifactView.executorRole/profile` 不得跨角色复用；
- `planAuthorization=none` 当且仅当最终 RunResult 的 `planUsageRecordId=null`；`observed` 与 `leased` 必须使该字段精确指向同 run/attempt/enforcement epoch 的 `usageRecordId`。Observed record 的 `usageCorrelationId` 必须匹配授权，lease/pool epoch 与两类 permit 列表为空；leased record 的 correlation ID 为空，lease、pool epoch、run/attempt 和已消费 logical/attempt permits 必须与 Broker 账本一致；
- RunSpec、PlanLease 和 PlanUsageRecord 的 `planEnforcementEpochDigest` 必须等于请求发生时的 active pointer。`observed` 只允许未过期 observe-only epoch 的 allowlisted activation，且不得签发 permit；enforced epoch 的所有 provider call 必须 leased。Leased run/attempt/profile 必须与 PlanLease 一致，logical/attempt permit 只能归属于该 attempt；`none` 不得持有 coding-plan credential 或出现 provider attempt；
- 每个 logical provider request 只能产生一条 logical cache observation；其中的 attempt observation digest 集合和全部非空 attempt ID 必须与实际 attempt records 一致。Enforced epoch 的每条真实 attempt 必须绑定同 logical request、run/attempt 和 lease 的唯一已消费 `ProviderAttemptPermit`。Final AssistantMessage usage/response ID 只能计入 logical record 一次；attempt record 只能保存该 attempt 的 HTTP/SDK request ID 和 provider 明确逐 attempt 返回的 usage，不能复制 logical usage；
- Research profile 必须满足固定映射：fetch/parser 只能 `none` 且没有 coding-plan credential，synthesizer 不能拥有 source network/raw-cache write；任何混合 grant 启动前拒绝；
- 持久状态提交必须由 RunSpec context 的 `stateSnapshotDigest` 和 `stateReadViewDigest` 派生；replay 固定同一状态视图，ExecutorRunResult 只记录 write-set，最终 RunResult 才记录 CAS finalization；
- Executor termination、write-set、state finalization、commit ID 和 final termination 必须满足第 18.3 节真值表；失败/中断结果不能提交部分 durable state；
- exact approval 中的 candidate/classification/activation/destination/report/gate-profile digest 必须与待转换 artifact 一致，`allowedActions` 必须包含 EvaluationReport 的 `evaluatedAction`；
- RunSpec 与 EvaluationReport 引用的 epoch manifest 必须存在，且其中的 `epochId`、`evaluatorActivationDigest` 和 `gateProfileDigests` 必须分别覆盖记录中的 evaluator epoch、evaluator activation 和 gate profile；gate profile 的 subsystem/action 必须与 subject activation 和 `evaluatedAction` 匹配；
- 普通 channel 文件只指向已验证 `ChannelPointer` 的 digest；pointer 中的 lineage、activation 和 canary assignment policy 必须存在、已批准且满足 stable/canary nullability 规则。启用 LineageSetManifest 后，assignment 只能从唯一 active manifest 解析；
- Meta-Pi 的输出只能创建 candidate，不能直接创建 promotion event；
- Evaluator 只消费 raw facts 和指定 epoch policy；
- 同一 state transition key 重试必须幂等；
- 所有外部副作用必须有 RunSpec 和 side-effect event。

## 19. 数据、Artifact 与 Registry

### 19.1 默认位置

代码位于本仓库的 Evo package；个人运行状态默认位于：

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/evo/
```

项目可共享但不含私密运行数据的 policy 可位于：

```text
<repo>/.pi/evo/
```

用户级与项目级 overlay 的优先关系沿用第 8.3 节，但 active registry、审计和 subscription ledger 只由 Supervisor 管理。

### 19.2 目录建议

```text
evo/
  db/
    evo.sqlite
  artifacts/
    sha256/ab/cd/<digest>
  registry/
    behavior-bundles/<digest>/lock.json
    components/<digest>/manifest.json
    kernels/<digest>/manifest.json
    execution-closures/<digest>/manifest.json
    activations/<digest>/tuple.json
    channel-pointers/<digest>.json
    provenance/<digest>.json
    gate-profiles/<digest>.json
    evaluators/manifests/<digest>.json
    evaluators/active
    evaluators/shadow/<digest>.json
    channels/<subsystem>/lineages/<lineage-id>/stable
    channels/<subsystem>/lineages/<lineage-id>/canary
    lineage-sets/<subsystem>/active
    plan-enforcement/manifests/<digest>.json
    plan-enforcement/active
  approvals/
    policies/<digest>.json
    grants/<grant-id>.json
  workspaces/
    snapshots/<digest>.json
  checkpoints/
    <run-id>.json
  state/
    <subsystem>/<activation-digest>/
  reports/
    daily/
    weekly/
  locks/
```

### 19.3 SQLite 与 CAS 分工

SQLite（WAL）保存可查询 metadata、状态机、索引、关系、posterior 和队列；CAS 保存 transcript、大型 prompt/tool 输出、diff、源码 bundle、论文原文和报告。数据库只引用 digest。

CAS artifact metadata 至少包含：

```text
digest
media_type
schema
size
created_at
producer_run
privacy_scope
retention_class
compression
trust_class
```

相同内容只存一份，但访问控制按引用 scope 检查，不能因内容相同绕过用户/repo 隔离。`trust_class` 属于不可变 artifact reference metadata，不由 producer 自报提升；raw fetch 固定为 `external-untrusted`，parser/LLM 输出固定为 `derived-untrusted`。只有 Constitution provenance gate 能创建指向原 digest 的新 `provenance-validated` wrapper/reference，并附 validation report；它不原地改写原 artifact 的 trust class。

### 19.4 Channel 与原子激活

```text
registry/channels/<worker|meta|research|plan-scheduler>/lineages/<lineage-id>/stable -> ChannelPointer digest P1
registry/channels/<worker|meta|research|plan-scheduler>/lineages/<lineage-id>/canary -> ChannelPointer digest P2
registry/lineage-sets/<worker|meta|research|plan-scheduler>/active -> LineageSetManifest digest L（Phase 6）
registry/evaluators/active -> evaluator epoch manifest digest E
registry/plan-enforcement/active -> PlanEnforcementEpoch digest Q
```

Evaluator 与 plan enforcement 各自只有一个 Constitution-owned `active` pointer；UI 可以显示派生标签，但不得维护第二个权威来源。Phase 1–5 只有 `general` lineage channel 是部署来源；Phase 6 启用 `LineageSetManifest` 后，该 subsystem 的 active lineage-set pointer 成为唯一 assignment root，不能再同时从散落 channel 路径直接分配。单 pointer promotion、evaluator epoch transition 和 plan-enforcement 人工 transition 都以 compare-current + 临时文件 fsync + 单 pointer rename 实现；跨 subsystem 只使用前述 saga，直到引入单 registry-generation root pointer。

普通 subsystem Promotion 流程：

1. 重新计算并验证 candidate、classification、BehaviorBundle、kernel、ExecutionClosure、activation、assignment policy、ChannelPointer、approval、report、state namespace 和 migration digest；
2. 写 promotion intent；
3. fsync 新 pointer 的临时文件；
4. compare expected pointer/generation 后原子 rename channel 文件，使其一次指向完整的新 `ChannelPointer` digest；
5. 写 promotion completed event；
6. 对应 subsystem 的下一个满足 activation matrix、且未被既有 pin/lease 约束的进程读取新 activation；
7. 旧 activation 的 bundle、kernel、closure 和 rollback 窗口内的可读 state namespace 保持可启动。

Phase 6 某 subsystem 启用 active LineageSetManifest 后，第 4 步不再直接把 named channel path 当作 assignment authority：先保存新的 ChannelPointer artifact，再构造包含它的新 LineageSetManifest，最后 compare-current 并原子替换该 subsystem 的唯一 active lineage-set pointer。`ReleaseTransaction.lineageSetUpdates` 记录这一 root CAS；named channel 文件只能是派生索引，不能形成第二个可写权威源。

Evaluator epoch transition 单独执行：

1. 当前 active epoch 评价 proposed evaluator activation，另加确定性 calibration、扰动和泄漏测试；
2. 生成绑定 proposed activation、metric catalog、gate profiles 和 holdout policy 的新 `EvaluatorEpochManifest`；
3. 人签发只允许 `evaluator.activate-epoch` 的 exact grant；
4. Supervisor 校验 expected registry generation、当前 active manifest、report 和 grant；
5. fsync 临时 pointer，并原子 rename `registry/evaluators/active`；
6. 已开始的 evaluation run 继续 pin 旧 epoch，新 run 读取新 manifest；
7. 保留旧 manifest、activation 和派生重算路径，必要时用同一单 pointer 协议回滚。

不能把 `/reload` 当成发布协议；reload 可用于开发，但正式 activation 必须通过 registry。

### 19.5 数据保留

建议按类别配置：

- raw audit、approval、promotion：长期；
- outcome 和聚合指标：长期；
- 完整 prompt/tool artifact：按隐私和磁盘预算；
- workspace snapshots：保留可复现窗口；
- research raw responses：按来源许可与 cache policy；
- 失败 candidate：保留 manifest、报告和最小复现，源码可分级清理。

用户必须能执行 repo/session/episode 级 `forget`。删除内容后保留不含原文的 tombstone 和统计修正事件，避免 dangling digest 被误认为仍可 replay。

### 19.6 Schema migration

Migration 是显式、单向、可备份的 Supervisor 操作。原始 artifact 不原地重写；新增 normalized view。重大 schema 升级先复制 metadata DB、运行一致性检查，再切 active schema version。

## 20. 并发、恢复与回滚

### 20.1 进程模型

第一版使用独立进程而非在一个 Pi 进程内混合角色：

```text
evo-supervisor
pi-worker
pi-meta
evo-research-fetcher
evo-evaluator
```

Worker 和 Meta 可以都由 Pi SDK/RPC 驱动，但使用不同 RunSpec、数据目录 view、capability grant 和 plan lease。

### 20.2 并发原则

- 一个 interaction 必须固定 activation，默认整个 active episode 固定；
- 同一 workspace 同一时刻最多一个 mutation run；
- read-only replay 可并行；
- Meta candidate 各自在隔离 worktree；
- 同一 subsystem/channel 的 registry 切换串行；
- SQLite writer 短事务，artifact 先写后引用；
- foreground 到达时停止分配低优先级 plan lease。

### 20.3 Checkpoint

Meta workflow 在以下边界写 checkpoint：

```text
research cards selected
hypothesis complete
ChangeSpec complete
candidate patch complete
static gates complete
each replay cohort complete
evaluation report complete
```

Checkpoint 保存结构化 artifact 和下一可重入 step，不依赖恢复完整 LLM hidden state。Provider stream 中断后从最后边界重新开始，而不是假装 token stream 可续传。

### 20.4 幂等与 crash recovery

Supervisor 启动时：

1. 扫描未完成 state transitions；
2. 验证 artifact 是否完整；
3. 将无 lease 的 running run 标记 interrupted；
4. 对有 checkpoint 的可重入任务重新排队；
5. 回收过期 lease/worktree；
6. 验证 channel 指向存在的已批准 digest；
7. 若 stable 无效，恢复 last-known-good。

工具副作用重试需要 idempotency key 或显式“不允许自动重试”。本地代码 edit replay 使用 snapshot，不在用户当前工作树重复执行。

### 20.5 Shadow

Shadow candidate 接收与 stable 相同的脱敏输入和只读环境，生成决策、计划或 patch artifact，但不向用户显示，也不执行 mutation/external side effect。适用于 router、context、prompt、plan、tool choice 和代码候选比较。

Shadow 不适合精确评价所有交互，因为它看不到自己行为造成的新环境。需要闭环的候选仍要 snapshot replay 或 canary。

### 20.6 Canary

Canary assignment 只在 approval scope 内，按 task strata/risk 分配。用户在交互开始前或状态栏能看到 canary 标识，并可立即固定回 stable。

默认自动 rollback 信号：

- capability/policy violation；
- crash 或无法恢复的 state corruption；
- Constitution contract failure；
- 明确质量 gate 严重退化；
- 前台 plan exhaustion 超过 policy；
- 用户要求 rollback。

统计上的轻微波动进入“暂停分配、等待审计”，不必每次立即回滚。

### 20.7 Kernel 候选

S4 候选运行完整独立 worker binary/process，绝不在 stable 进程内动态替换 agent loop。它读取兼容的 RunSpec 和 BehaviorBundle；promotion 切换整个 `activationDigest`。旧 kernel/ExecutionClosure 继续存在，durable state 则依赖版本 namespace 和显式 readable/migration contract，不能只靠保留 binary 假设可回滚。

### 20.8 轻量隔离策略

不需要把每个 prompt 参数实验都放进重型 VM。隔离强度按候选能力决定：

```text
data-only policy: normal worker + immutable bundle
read-only code: restricted worktree/process
tool/hook/runtime code: separate process + scoped filesystem/network
unknown external code/kernel: mandatory credential-free container/VM
```

原则是确保回滚和作用域，而不是以防御本身替代实验。

## 21. 用户体验与审计界面

### 21.1 日常默认体验

正常使用保持 Pi 对话形式。Evo 系统在后台做三件可见但不打扰的事：

- 状态栏显示 stable/canary bundle 和 plan 状态；
- 任务结束时允许一键“接受 / 有问题 / 以后这样做”；
- 需要审批时生成一张可审计 proposal card。

用户无需每次打分。系统主要利用测试、保留 diff、自然语言 correction 和延迟结果；显式反馈用于校正歧义。

### 21.2 命令

```text
/evo status
/evo why <candidate-or-decision>
/evo review [candidate]
/evo approve <candidate> --through canary|promote
/evo policy
/evo mode observe|assisted|broad|lab
/evo quota
/evo research [topic]
/evo cache
/evo pause [meta|research|all]
/evo resume
/evo rollback [digest]
/evo pin <bundle>
/evo forget <session|episode|repo>
/evo exclude <repo|task-stratum>
```

命令最终调用 Supervisor API；extension 只负责 UI，不直接修改 registry 文件。

### 21.3 Proposal Card

审批卡必须在一个屏幕先给出：

```text
候选解决的问题与出现次数
修改 surface / components / files
是否单轴，若多轴为何不可拆
外部研究及原始链接
baseline、replay/canary strata
质量、纠正、延迟、cache、plan capacity 的差异和区间
已知退化与不确定项
新增 capability/dependency
所需审批阶段
canary 范围
rollback digest
```

用户可以选择：

```text
reject
request changes
approve exact candidate through stage X
create standing approval for this class
increase evidence
archive
```

### 21.4 “为什么”解释

每个 routing、context、tool、verification 和 promotion 决定都应能回答：

```text
用了哪个 bundle/component
输入了哪些可观察特征
有哪些候选选择
policy 为什么选择当前项
是否受 quota/approval 限制
对应 trace 和证据
```

解释来自结构化 decision event，不要求另一次 LLM 事后编造。

### 21.5 周报

周报保持决策导向：

- 本周真实 workload 分布；
- stable 的质量、纠正、等待和 plan 状态；
- 已发现机会及优先级；
- 候选漏斗：生成、淘汰、canary、promoted；
- promoted 后实际收益和回滚；
- Research Cards 中值得审批的 3–5 项；
- 下周预计 background capacity；
- evaluator/approval policy 是否需要调整。

## 22. 在当前 pi2 中的具体实现

### 22.1 总体选择

第一版新增独立 `packages/evo`，不把 Supervisor、研究库和实验数据库塞进 `packages/coding-agent`。Pi 保持可同步上游；Evo package 通过公开 SDK、RPC、extension 和 session custom entries 集成。

```text
pi2 upstream packages
  packages/ai
  packages/agent
  packages/coding-agent
        ↑ adapters only
  packages/evo
        ├── deterministic supervisor/control
        ├── policy compiler/registry
        ├── recorder/evaluator
        ├── meta/research/optimizer
        └── Pi adapters + UI extension
```

当公开 seam 不足时才创建小型、可单独 upstream 的 Pi core patch。业务策略不进入 core。

### 22.2 建议包结构

```text
packages/evo/
  package.json
  README.md
  CHANGELOG.md
  src/
    index.ts
    cli.ts

    protocol/
      ids.ts
      run-spec.ts
      run-result.ts
      assignment.ts
      artifact-view.ts
      lineage.ts
      candidate.ts
      activation.ts
      capability.ts
      durable-state.ts
      evaluation.ts
      evaluator-epoch.ts
      gate-profile.ts
      release-transaction.ts
      plan-lease.ts
      plan-enforcement.ts
      approval.ts
      schemas.ts

    supervisor/
      supervisor.ts
      state-machine.ts
      experiment-scheduler.ts
      assignment-engine.ts
      assignment-fence.ts
      run-finalizer.ts
      approval-engine.ts
      capability-resolver.ts
      artifact-views.ts
      query-firewall.ts
      research-fetch-broker.ts
      research-provenance-gate.ts
      sandbox-launcher.ts
      recovery.ts
      commands.ts

    storage/
      database.ts
      migrations/
      artifact-store.ts
      audit-ledger.ts
      workspace-snapshot.ts
      durable-state-store.ts

    registry/
      registry.ts
      channels.ts
      channel-pointers.ts
      lineage-sets.ts
      activation.ts
      evaluator-epochs.ts
      plan-enforcement.ts
      release-transactions.ts
      rollback.ts

    policy/
      component.ts
      graph.ts
      overlays.ts
      compiler.ts
      conflicts.ts
      prompt-layout.ts

    recorder/
      event-schema.ts
      episode-builder.ts
      feedback-classifier.ts
      outcome-linker.ts

    evaluation/
      evaluator.ts
      outcome-vector.ts
      strata.ts
      replay.ts
      shadow.ts
      posterior.ts
      gates.ts
      gate-profiles.ts
      credit-ledger.ts

    optimize/
      opportunity-board.ts
      operator.ts
      search.ts
      composer.ts
      research-card-mapper.ts
      failure-archive.ts
      operators/
        prompt.ts
        context.ts
        cache.ts
        skill.ts
        model-router.ts
        tool.ts
        hook.ts
        runtime.ts
        verifier.ts
        kernel.ts

    research/
      agenda.ts
      scheduler.ts
      fetch-cache.ts
      identity.ts
      graph.ts
      ranker.ts
      research-card.ts
      query-planner.ts
      parser-client.ts
      content-boundary.ts
      sources/
        arxiv.ts
        openreview.ts
        openalex.ts
        semantic-scholar.ts
        crossref.ts
        github.ts
        web-search.ts

    plan/
      broker.ts
      pool.ts
      lease.ts
      ledger.ts
      estimator.ts
      proposal-clamp.ts
      stream-authorizer.ts
      provider-proxy.ts
      adapters/

    adapters/
      coding-agent/
        worker-extension.ts
        launcher.ts
        resource-loader.ts
        session-recorder.ts
        rpc-executor.ts
        sdk-executor.ts
      agent-harness/
        harness-executor.ts

  test/
    protocol/
    policy/
    supervisor/
    evaluation/
    research/
    plan/
    integration/
```

MVP 可先把文件合并成较少模块；上述结构是责任边界，不要求第一天创建全部空文件。

### 22.3 当前 Pi 的无 core 修改接入点

| 需求 | 当前接入点 | 第一版做法 |
|---|---|---|
| 创建 headless worker/meta | `packages/coding-agent/src/core/sdk.ts`、RPC mode | TypeScript 内优先 SDK；需要进程隔离时启动 `pi --mode rpc` |
| 日常 TUI 观测与命令 | extension API | 加载一个 Evo UI/recorder extension |
| 输入、context、prompt | `input`、`before_agent_start`、`context` | 注入已编译 policy 并记录 provenance |
| provider payload/header | `before_provider_request`、header/response events | 记录 bundle 已知 layout digest、provider-specific payload observation 和 best-effort correlation；稳定 request trace 等待 P1 |
| provider permit | 固定可信路径由 launcher 包装公开的 `AgentSession.agent.streamFn`；S3/S4/第三方代码使用独立 provider proxy | Wrapper 只覆盖标准路径；任意同进程代码必须移除原始凭据并用 OS 网络约束强制经过 proxy |
| tool 调用和结果 | `tool_call`、`tool_result` | 记录 decision、阻止越界、规范化结果 |
| turn/message 生命周期 | agent/message/turn events | 构建 interaction 和 episode |
| session metadata | extension 的 `pi.appendEntry()`；外部 SDK 可直接用 `SessionManager` | 写入 bundle/run/episode ref，不污染 LLM context |
| 资源与 skill | `DefaultResourceLoader` 或自定义 `ResourceLoader` | 只暴露 bundle 选择的 resources |
| cache 浪费基线 | `packages/coding-agent/src/core/cache-stats.ts` 的算法 | Evo 重实现小型 scan，或先增加 public export；不从内部路径导入 |
| session replacement | `AgentSessionRuntime` | 在新 runtime 绑定 recorder；不让旧 extension context 泄漏 |
| 更低层 headless harness | `packages/agent/src/harness/agent-harness.ts` | 在 Meta/replay 中试用，日常 TUI 暂不强制迁移 |

具体构造路径优先使用 `createAgentSessionServices()`、`createAgentSessionFromServices()` 和 `createAgentSessionRuntime()`。通过 `DefaultResourceLoader` 构造参数中的 `extensionFactories` 字段注入一个人工审查、版本固定的 `EvoPolicyRuntime` extension；它只解释 BehaviorBundle 中已验证的声明式数据，并通过 resource/system-prompt overrides 暴露 bundle 选择的资源。记录同时使用 `AgentSession.subscribe()` 和 extension hooks；轻量 session reference 通过 `pi.appendEntry()`，完整 trajectory 仍写 Evo artifact store。

当前 `AgentHarness` 已提供 typed events、session abstraction、provider request/payload 的有序 transform、`cacheRetention`、manual compaction 和 session 能力，适合成为中长期统一 executor。大多数其他 result hook 仍是 last-result-wins，不等于完整 Policy Graph；它也尚无 coding-agent 的 TUI/resource/package parity、自动 threshold/overflow compaction、高层 retry 和 runtime session replacement。因此第一阶段保留两种 adapter，不等待全面迁移。

### 22.4 Worker 接入方式

第一阶段：

1. Evo launcher 在创建 `DefaultResourceLoader` 和 `AgentSession` 前解析、验证并 pin stable/canary activation；
2. launcher 按该 activation 注册 `worker-extension.ts`、工具、资源和 policy data；
3. extension 在 `session_start` 只验证/记录 activation digest 并建立 recorder；
4. 每个 interaction 生成 RunSpec ref 和 trace；
5. hook 只调用已编译 policy runtime；
6. message/tool/session 事件写入本地 recorder；
7. `/evo` 命令通过本地 IPC 调用 Supervisor。

初期 activation 以新 session/process 为边界，避免一次交互中混合版本。以后由自定义 coding-agent launcher 在新 episode 建立时向 Supervisor 取得 assignment，并在该 episode 内保持 pin；只有显式策略或用户命令才允许下一 interaction 改用新 activation。

### 22.5 Meta-Pi 接入方式

Meta-Pi 使用独立进程和数据 view：

```text
Supervisor
  → create PlanLease
  → create isolated candidate worktree
  → start pi --mode rpc or SDK executor
  → send structured role task + artifact handles
  → checkpoint at role boundary
  → collect CandidateManifest/patch
  → close lease and record usage
```

它通过同一类 subscription auth 使用 coding plan，但不直接读取 worker 的 auth 文件；launcher 以 credential handle 配置 provider。若实际部署不需要严格分离账户，handle 可以解析到同一订阅，Plan Broker 仍按 shared pool 调度。

### 22.6 固定 Policy Runtime 与数据/代码分界

S0/S1 被自动 promotion 的前提是它们仍是纯数据。第一版安装一个人工审查、版本固定的 `EvoPolicyRuntime` extension；Bundle Compiler 输出声明式 lock/data，由这个 runtime 解释，不能为每个 prompt/cache 候选生成新的 TypeScript。

```text
compiled-bundle/
  behavior.lock.json
  prompts/
  skills/
  workflow/
  policies/
  data/
  executable-refs.json
```

分类规则：

- S0/S1 artifact 只能是 schema-validated data，不得包含 JS/TS、native code、新依赖或任意命令；
- S2 可以是固定 interpreter 支持的声明式 workflow/skill/verifier graph；
- 任何生成的 JS/TS、tool implementation、parser、hook、custom reducer 或 dependency 都自动归类为 S3；
- 改 Agent/Session/provider 本体归 S4；
- 数据候选引用的 interpreter/reducer digest 必须进入 BehaviorBundle/ExecutionClosure。

这样 Broad 模式可以自动发布数据 policy，而不会把“改一句 prompt”悄悄变成同进程任意代码。

仍然只向 Pi 注入一个有名字的 `EvoPolicyRuntime`，因为当前 Pi 的组合规则并不统一：event handler 按 extension load order 串行；input/context/prompt/provider transform 会链式传递；extension 间同名 tool 是 first-wins，但 SDK custom tool 后应用并可覆盖 extension tool；prompt/theme collision 是 first-wins；shortcut 又有不同的 later-wins 行为；重复 command 会获得带后缀的 invocation name。S3 code components 由 runtime 引用已批准 artifact，不能回退到目录加载顺序作为 Policy Graph 语义。

### 22.7 Activation matrix

| Target | 最早允许的激活边界 | 当前 Pi 第一版 |
|---|---|---|
| S0 preference/memory/statistics data | 下一 interaction；默认下一 episode | 下一 episode |
| S1 prompt/context/cache/router data | 下一 interaction；默认下一 episode | 下一 episode，必要时新 AgentSession |
| S2 声明式 skill/workflow/verifier/tool catalog | resource/tool registry 可安全重建时 | 新 AgentSession |
| S3 tool/hook/runtime/research/optimizer code | 新进程或隔离 code runtime | 新进程 |
| S4 Worker/Meta/Research/Evaluator kernel | 新 binary + ExecutionClosure | 新进程/新 binary |
| Evaluator policy | 新 evaluator epoch | 新 epoch |
| Plan scheduling policy | 下一 scheduler cycle，旧 lease 不变 | 下一 background cycle |

MVP 可以统一采用“新 session/process”作为更粗的边界。UI 将候选显示为 `pending activation`，直到满足对应边界；`/reload` 不得绕过它。Activation 发生后，active episode 的 pin 仍优先，除非用户显式切换。

### 22.8 建议的 core patch queue

以下 patch 只有在外层实现验证价值后才进入 Pi 源码。

#### P0：Public cache observation

`packages/coding-agent/src/core/cache-stats.ts` 当前不属于 public API。二选一：

- Evo 重实现当前只能按 message/usage 顺序关联的 best-effort heuristic；或
- 将通用 observation 类型和 scan 以普通 Pi 也有价值的形式导出。

不能直接从包内部路径 import。P0 不声称拥有稳定 request identity；任何“基于 request ID 的严格实现”依赖 P1，不能作为 P0 独立分支。现有 heuristic 保留兼容测试，但不是最终 credit 数据源。

#### P1：请求/Turn ID、Latency 与 Effective Options

涉及：

```text
packages/agent/src/types.ts
packages/agent/src/agent-loop.ts
packages/agent/src/harness/types.ts
packages/agent/src/harness/agent-harness.ts
packages/coding-agent/src/core/agent-session.ts
packages/coding-agent/src/core/sdk.ts
packages/coding-agent/src/core/extensions/types.ts
packages/ai/src/types.ts
packages/ai/src/api/openai-codex-responses.ts
packages/ai/src/api/mistral-conversations.ts
packages/ai/src/api/google-generative-ai.ts
packages/ai/src/api/google-vertex.ts
packages/ai/src/api/bedrock-converse-stream.ts
```

在 agent stream 层生成稳定 `logicalRequestId`，在每次真实 HTTP/SSE/WebSocket/provider-SDK 调用前生成 `providerAttemptId + transportAttemptOrdinal`，同时记录 transport、initial/retry/fallback/resume reason、`providerHttpRequestId` 和对应的 `ProviderAttemptPermit.permitId`；另保留 `assistantResponseId`、`turnId/toolExecutionId`。将每个 provider attempt 的 start/end、latency、最终 stream options 和 response headers 串联到 attempt record，再把最终 usage/message 只关联到 logical record；只有 provider 明确返回逐 attempt usage 时才填写 `exactAttemptUsage`。`AgentSession` 的 stream options/extension events 实际在 coding-agent `sdk.ts` 组装；要保证跨 adapter end event，还必须补齐 `packages/ai/src/types.ts` 的 typed seam 以及当前缺少等价 `onResponse` 的 Mistral/Google adapter。先保证 passive observer 完整记录，不改变 agent 决策。

Bedrock 是不能遗漏的特殊 seam：当前 AWS SDK 可以在一次 `client.send()` 内部执行 Smithy retry，而外层 `onResponse` 只看到整个调用结束。可信 direct-wrapper 路径必须把该 client 固定为 `maxAttempts=1`，由 Broker 重新签发 permit 后再重试；若保留 SDK 内部 retry，则必须安装 AWS middleware，在每个 upstream attempt 前原子消费新的 `ProviderAttemptPermit` 并发出 start/end lifecycle。任何第三方 adapter 都必须在 capability manifest 声明并通过测试证明 `single-transport-attempt` 或 `attempt-middleware-enforced`；未知或无法关闭的隐藏 retry 只能标为 best-effort observer，或强制经过本地 credential proxy，不能宣称 hard accounting。

Run/bundle metadata 初期继续用 extension custom entry，不要求塞进所有 core event。

#### P2：Coding-agent Provider-neutral Stream Options

`AgentHarnessStreamOptions` 已支持 `cacheRetention`，但 coding-agent SDK/settings 没有等价入口。Extension 可以修改 provider-specific payload，也可通过 `before_provider_headers` 修改 headers，但缺少 typed、provider-neutral 的 stream-options hook。增加 provider-neutral 的 request options event/result，至少包括：

```text
cacheRetention intent
sessionIdentity
promptCacheKey
transportAffinityIdentity
timeout/retry options
metadata/headers
effective provider adaptation observation
```

涉及：

```text
packages/agent/src/agent.ts  # 若通过 AgentOptions 正式透传
packages/coding-agent/src/core/sdk.ts
packages/coding-agent/src/core/extensions/types.ts
packages/coding-agent/src/core/extensions/runner.ts
packages/ai/src/api/openai-codex-responses.ts  # 若统一 retention
packages/ai/src/api/azure-openai-responses.ts  # 若统一 retention
```

AgentHarness 和常见 provider adapter 已有部分相关能力，不默认修改。P2 必须把会话连续性、prompt cache key 与 WebSocket/affinity identity 作为三个独立 intent；adapter 若无法独立控制就回报 `unsupported/coupled`，该 provider 的 cache A/B 不能声称变量隔离。P2 主要补 coding-agent 入口、typed effective-option observation，并决定 Codex 和 Azure Responses 是否以及如何遵守 `none/short/long`；只有实际缺口才改相应 provider adapter。若要修改模型元数据，通过生成脚本再生成，不直接编辑 `packages/ai/src/models.generated.ts`。

#### P3：Tool hook 后重新验证

当前 agent loop 在 `beforeToolCall` 之前验证参数，而 coding-agent `tool_call` handler 可以原地修改 input。增加显式返回 `argsPatch` 或 `args` 的 typed contract，并在所有 hook 完成后再次执行 schema validation。保留 block 能力；修改后的参数成为实际执行和审计对象。

当前“不重新验证”是 extension 文档和测试覆盖的 trusted-hook 契约，因此这是行为兼容性变化。第一版先提供 opt-in strict policy；若要改变默认契约，必须单独批准并同时保留 trusted-hook/strict 两类 compatibility tests。

涉及：

```text
packages/agent/src/agent-loop.ts
packages/agent/src/types.ts
packages/coding-agent/src/core/extensions/types.ts
packages/coding-agent/src/core/extensions/runner.ts
```

#### P4：Compaction/Branch-summary Usage 与 Trace

将 compaction/branch summary 的 provider usage、request ID、input digest、summary artifact 和 parent trace 暴露给 observer。结构化摘要 contract 可在外部 policy 证明价值后再加，不与 usage observation 绑成一个大 patch。

#### P5：结构化 Prompt Segments

涉及：

```text
packages/coding-agent/src/core/system-prompt.ts
packages/agent/src/harness/system-prompt.ts
```

从只返回最终字符串扩展为：

```ts
interface PromptSegment {
  id: string;
  scope: "global" | "repo" | "session" | "turn";
  stability: "stable" | "session" | "dynamic";
  content: string;
  sourceDigest: string;
}
```

最终 provider 仍接收字符串，但 observer/cache optimizer 能看到段落 provenance、token 和 digest。先在 Bundle Compiler 外部生成 segments，证明接口后再改 core。

#### P6：Hook Phase/Priority/Effect Metadata

为 extension/component 声明可选 phase、priority、reads、writes 和 capability metadata，并在加载时检测冲突。当前各资源的 collision 规则不同，因此这是较大语义变化。必须先让外部 Bundle Compiler 运行一段时间并形成 compatibility corpus，再决定哪些语义下沉。

#### 暂不需要的 core patch

Workspace snapshot、bundle/run metadata、approvals、artifact registry、Plan Broker metadata 和 delayed outcome 都能在 Evo 外层实现；可信、无旁路的标准 Pi 路径可由 Constitution-owned stream wrapper 强制 permit，任何 S3/S4/第三方同进程代码必须经独立 provider/credential proxy 与 OS capability isolation，不能只靠普通 extension 或 wrapper。Session transcript fork 只复制对话树，不复制 git tree、untracked files、dependency/environment 或 side effects；这不是通过扩展 session entry 就能解决的问题，应由 `WorkspaceSnapshot` 负责。

### 22.9 不建议立即修改的地方

- 不重写 `AgentSession` 的全部 loop；
- 不替换现有 session JSONL 格式；
- 不把 Evo 数据塞进模型可见 message；
- 不让 package manager 自动安装 Research Scout 发现的依赖；
- 不依赖实验性的 `packages/orchestrator` 作为控制核；
- 不直接修改 generated model catalog；
- 不为每个 optimizer 建一个互相不协调的 extension。

### 22.10 上游同步策略

```text
upstream Pi commit
  + packages/evo (独立)
  + small patch queue P0..Pn
  + compatibility tests
```

每次同步上游：

1. 更新独立依赖/源码；
2. 逐个重放 patch queue；
3. 运行 ABI、session fixture、extension event 和 replay compatibility tests；
4. 重建一个旧 stable activation 和一个新 candidate activation；
5. 只有兼容报告通过才更新允许的 `piCommit` 范围。

能 upstream 的通用 patch 优先 upstream，Evo 专属 policy 留在 `packages/evo`。

## 23. 测试与验证策略

### 23.1 测试层

1. Protocol/schema：序列化、null、版本拒绝、RunContext/PlanAuthorization、AssignmentDecision/Spec、ExecutorProfile、ArtifactView binding、ExecutorRunResult/finalization truth table、state snapshot/read-view/write-set 与 CAS conflict。
2. Policy compiler：相同输入同 digest、DAG、冲突、overlay、派生 capability envelope 与 profile ceiling。
3. Supervisor：每个合法/非法状态转换、assignment decision、approval、幂等。
4. Registry：ChannelPointer 原子绑定 lineage+activation+assignment、LineageSetManifest 唯一 root、evaluator/plan-enforcement 唯一 active pointer、跨 subsystem compatibility/fence/saga、断电模拟、rollback。
5. Plan Broker：observe-only→enforced cutover、observed allowlist/expiry、shared/separate pool、前台抢占、未知 quota、cooldown、`maxRetries=0` direct wrapper、logical/attempt permits、S3/S4 外置 credential proxy、Bedrock/Smithy hidden retry、第三方 adapter capability manifest、retry/fallback 与旁路测试。
6. Recorder：事件关联、episode 边界、raw/annotation 分离。
7. Replay：workspace/state/ArtifactView snapshot 完整性、baseline/candidate 配对、外部不可复现标记。
8. Evaluator：strata、posterior、non-inferiority、missing outcome。
9. Research：fetch/parser/synthesizer profile 隔离、fixture adapters、QueryFirewall/DLP、出站审计、ETag/backoff、immutable work ID/alias/merge、逐 assertion deterministic provenance gate、signed review annotation、SSRF/redirect、parser bomb、外部 prompt injection 与角色 ArtifactView ACL。
10. Cache：logical request 与 provider attempt 分表、permit/ID/ordinal correlation、Assistant response ID 与 HTTP request ID 分离、logical usage 不重复计入 attempts、response model、1h write、prompt digest、miss attribution、retention/identity routing、quality gate。
11. Fault injection：进程 crash、部分 artifact、DB 重启、过期 lease、assignment fence 中断、saga 中间组合失败。
12. End-to-end：observe → candidate → replay → approval → canary → promote → rollback。

### 23.2 Pi 测试约束

- coding-agent 回归放在其现有 suite/harness，使用 faux provider；
- package 单测不调用真实 provider、订阅账户或付费 token；
- 网络 adapter 使用录制/手写 fixture；
- 只有人工明确发起的 smoke 才使用真实 coding plan；
- 修改测试文件后运行对应 test；
- 代码完成后运行仓库要求的 `npm run check`；
- 不把真实 auth、session 原文或私有 repo 内容放入 fixture。

### 23.3 Golden contracts

保留版本化 fixture：

```text
RunSpec/ExecutorRunResult/RunResult JSON
RunContext/PlanAuthorization
AssignmentDecision/AssignmentSpec
ExecutorProfile/ArtifactView/CapabilityGrant
BehaviorBundle lock
ExecutionClosure manifest
ActivationTuple
ChannelPointer/assignment policy/LineageSetManifest
EvaluatorEpochManifest/Transition
PlanEnforcementEpoch/Transition
ActionGateProfile
ReleaseTransaction
session custom entries
logical request cache observation/provider attempt cache observation
provider usage events
workspace snapshot
artifact trust metadata
state read view/write set/commit
approval grant
plan lease/logical request permit/transport attempt permit
ProposedResearchCard/ResearchCard/ResearchReviewAnnotation
evaluation report
promotion journal
```

上游 Pi 更新必须能读取旧 fixture，或提供明确 migration。

### 23.4 Replay 质量审计

对一组代表性历史任务，比较 live 原始运行和从 snapshot replay 的：

- 初始文件 digest；
- ArtifactView digest 与精确可达 artifact 集合；
- 执行命令环境；
- 关键 tool results；
- 最终 diff；
- 确定性 verifier；
- 不可复现来源。

只有 fidelity 足够的 strata 才允许 replay 承担高 evidence weight。

## 24. 分阶段交付

### Phase 0：规格冻结与只读观测

交付：

- protocol schemas；
- event/episode schema；
- subscription usage ledger；
- Evo recorder extension；
- cache/context/tool/runtime 基线报告；
- raw fact 与 annotation 分离。
- 最小 provider request/turn/tool correlation 和 effective-options 观测；若 public hook 不足，提前落地仅增加观测、不改变决策的 P0/P1 seam。

退出条件：连续日常使用能把一个任务从输入、工具、provider request、usage、验证到后续 correction 关联起来；observer patch 不改变 Pi 决策语义。

### Phase 1：BehaviorBundle、Activation 与审批控制面

交付：

- component manifest；
- Policy Graph/BehaviorBundle Compiler；
- CAS、SQLite、registry；
- approval policy/grant；
- Supervisor 状态机；
- 最小 deterministic assignment/pinning engine：只支持 `general` stable、人工指定 activation 和 maintenance fence，不自动分配真实 canary；
- `PlanEnforcementEpoch` registry 与短期 observe-only bootstrap manifest；此阶段只观测，不把它误称为 permit enforcement；
- 当前 Pi 的 BehaviorBundle/ExecutionClosure/Activation 建模和一次性 GenesisGrant；
- candidate 注册、ActionGateProfile、EvaluatorEpochManifest、ChannelPointer、单 pointer 原子 channel/epoch、跨 subsystem compatibility/fence/saga、crash recovery 和 rollback 机制；
- durable state read-view/snapshot/write-set/CAS 协议；
- `/evo status/review/policy/rollback`。

退出条件：能够把当前 Pi 作为 genesis activation 登记并从 registry 重启；普通 candidate 只能注册为 inactive，不能在没有 EvaluationReport 时进入 stable。普通 channel 和 evaluator active epoch 都只有一个权威 pointer；原子 pointer、state CAS、saga 补偿和 rollback 先通过故障注入验证。

### Phase 2：Replay、Evaluator 与 Cache 首个闭环

交付：

- workspace snapshot；
- rolling replay bank；
- OutcomeVector/strata；
- 配对 evaluator 和 Credit Ledger；
- foreground-only 的最小 Plan Broker、logical/attempt permit、可信 direct-wrapper/credential-proxy seam；在人类签署 `PlanEnforcementTransition`、active epoch 进入 enforced 且旁路/隐藏 retry 测试通过后，才允许任何 candidate live canary；
- cache observation/miss attribution；
- 第一个由确定性、非 LLM operator 自动生成、经 exact approval 进入个人低风险 repo 的限量 manual canary，并在 live evidence 后人工 promote/rollback 的 cache/context 候选；
- manual canary 的固定 interaction 上限、显式 UI 标记、stable 一键切回和 delayed monitor。

退出条件：active PlanEnforcementEpoch 已由人从 observe-only 切为 enforced，所有 stable/canary 模型调用均先取得 lease/permit，且 hidden retry 不可绕过 attempt accounting；候选报告包含质量非劣、cache/latency、subscription proxy、不确定度和 rollback；manual canary 提供 stable gate 要求的 A4 live evidence 后才允许人工 stable promotion。旧 cache heuristic 可以用于发现机会，但任何以 cache 改善为 promotion 理由的候选必须有稳定 request correlation；retention/key 候选还必须有 requested/effective/unsupported 证据，必要时先完成 P2。

### Phase 3：Meta-Pi 候选工厂

交付：

- Opportunity Board；
- Analyst/Designer/Builder/Critic/Experimenter artifacts；
- 把 Phase 2 的 foreground-only Plan Broker 扩展为 shared/separate pool、动态 foreground reserve、后台 checkpoint/preemption 和 plan-aware scheduler；
- prompt/context/skill/router/tool/runtime operators；
- failure archive 和 successive halving。

退出条件：后台能在不阻塞前台的情况下，从重复 pain 生成可审计候选并完成 replay。

### Phase 4：Research Scout

交付：

- arXiv/OpenReview/OpenAlex/Crossref/GitHub adapters；
- source cache、immutable work ID、identifier alias/merge/tombstone、引用/仓库图；
- fetch/parser/synthesizer executor-profile grants；
- QueryFirewall、fetch broker 与 parser sandbox；
- pain/frontier agenda；
- Research Card 和 candidate mapper；
- ProposedResearchCard → deterministic provenance gate → ResearchCard，以及 signed human review annotation；
- 外部内容 schema gate 与角色化只读 ArtifactView；
- 每周 research report。

退出条件：每条 proposal 都能追溯原始来源、迁移假设和本地 experiment；prompt-injection fixture 不能取得 workspace、secret、registry 或 control-channel 权限，也不能直接污染 stable。

### Phase 5：Shadow、Canary 自动化与 Standing Approval

交付：

- 将最小 assignment engine 扩展为 task-strata/lineage routing、随机 cohort 和 policy-driven assignment；
- shadow runner；
- canary strata；
- delayed outcome；
- 自动 pause/rollback；
- Broad mode 的 standing approval。

退出条件：S0–S2 候选可在 policy 内自动到 canary，S3/S4 可自动准备到 exact approval。

### Phase 6：结构与 Kernel 进化

交付：

- multi-axis interaction groups；
- lineage/Pareto archive；
- active LineageSetManifest、声明式 routing policy 与启动前 AssignmentDecision pin；
- periodic structural search；
- 独立 worker kernel artifacts；
- 验证 P0–P6 中确有价值的 core patches；
- S4 exact approval/promotion。

退出条件：可以构建并 replay 一个修改 Pi runtime/tool loop 的候选 binary，且 promotion/rollback 不影响 Constitution Core。

### Phase 7：Meta/Evaluator 演化

交付：

- Meta bundle 评价指标与 lineage；
- optimizer operator 自身候选；
- evaluator epoch migration；
- scheduler simulation/evolution；
- 长期 ROI 与 Goodhart 审计。

退出条件：Meta-Pi 能提出自己的下一代，但仍由固定 epoch 和 Supervisor 完成评估与激活。

## 25. 建议的首批实现单元

这些是可独立审查的变更单元，不代表现在已经实现。

### Change 1：Protocol 与最小存储

新增：

```text
packages/evo/package.json
packages/evo/src/protocol/*
packages/evo/src/storage/artifact-store.ts
packages/evo/src/storage/audit-ledger.ts
packages/evo/test/protocol/*
```

完成 `RunContext`、`PlanAuthorization`、`PlanEnforcementEpoch/Transition`、`AssignmentDecision/Spec`、`ExecutorProfile`、`RunSpec`、`ExecutorRunResult`、`RunResult`、`ArtifactView`、`OutcomeVector`、`BehaviorBundleLock`、`ExecutionClosure`、`ActivationTuple`、`ChannelPointer`、`LineageSetManifest`、`ActionGateProfile`、`EvaluatorEpochManifest/Transition`、`ReleaseTransaction`、`ApprovalPolicy`、`ApprovalGrant`、state read/write protocol、canonical JSON 和 SHA-256 digest。MVP metadata 可先使用 append-only JSONL；SQLite driver 作为单独依赖审查，优先评估 Node 22 的 `node:sqlite` 是否满足 WAL/备份需求。

验收：相同对象跨进程产生相同 digest；损坏、未知 schema 和 digest mismatch 被拒绝。

### Change 2：只读 Recorder Extension

新增：

```text
packages/evo/src/adapters/coding-agent/worker-extension.ts
packages/evo/src/adapters/coding-agent/session-recorder.ts
packages/evo/src/recorder/*
```

只订阅事件并写 artifact/custom entry，不修改 prompt/context/tool。将 Pi assistant usage 与现有 cache waste 统计纳入 interaction；若现有 public 事件无法稳定串联 provider request、response、usage 和 tool execution，本变更同时提交最小 P0/P1 observer seam。

验收：关闭 extension 后 Pi 行为一致；启用后完整记录 turn/tool/usage/session，且不把 Evo metadata 发给模型。

### Change 3：BehaviorBundle Compiler

新增 `policy/*`，先支持 prompt section、context selector、cache policy 和 observer 四类 component。编译为声明式 BehaviorBundle lock/data，由固定的 `EvoPolicyRuntime` 解释，不为每个数据候选生成 extension 代码。

验收：编译确定性；隐式冲突失败；每个输出字段能解释 provenance；activation 固定到 session/episode；S0/S1 数据中出现代码、命令或新依赖时分类失败。

### Change 4：Supervisor、Registry 与审批

实现状态机、channel、最小 stable/manual assignment、exact/standing approval、maintenance fence 和 rollback；增加本地 IPC 与 `/evo status/review/policy/rollback`。

验收：未授权状态转换不能发生；promotion 中途 crash 后单 channel/epoch pointer 要么保持旧值，要么完整指向新值；canary assignment 与 activation 不分离；跨 subsystem 先 fence 新 assignment、验证每个中间组合，失败后按 saga 逆序补偿；旧 stable/evaluator epoch 可启动。

### Change 5：Snapshot Replay 与 Evaluator

先支持本地 Git workspace、只读/可逆 coding task、确定性 verifier。创建小规模 rolling replay bank 和配对报告。

验收：能证明 workspace 与 durable-state snapshot fidelity；结果绑定 evaluator epoch manifest 和 action gate profile，保留 raw vector、strata 和区间；缺失结果不被填成成功。

### Change 6：最小 Plan Enforcement 与 Cache/Context 第一条自动闭环

先实现 foreground-only Plan Broker、PlanEnforcementTransition、logical/attempt permit，以及可信 adapter 的 direct wrapper 或强制 credential proxy；active epoch 切到 enforced 后，再实现 logical-request/attempt 两级 cache observations、prompt segment digest、miss attribution 和一个确定性 cache/context operator。Operator 只生成候选，人工审批 promotion。

验收：stable/canary provider call 都使用 lease/permit，Bedrock/第三方 adapter 的隐藏 retry 已被关闭、逐 attempt middleware 计量或强制代理；至少一个确定性 operator 候选完整走过 opportunity → build → replay → report → exact approval → limited manual canary → delayed monitor → promote/rollback；若 cache 是 promotion 主张，证据满足 Phase 2 的 request/effective-options 门槛。Meta-Pi 生成候选从 Change 7/Phase 3 开始。

### Change 7：后台 Plan Scheduler 与 Meta executor

在 Change 6 的 enforced Broker 上扩展 shared/separate pool、foreground reserve、后台 checkpoint/preemption、plan-aware scheduler 和 RPC/SDK Meta executor。先不追求准确 quota，只校准观测区间。

验收：模拟用户请求到达时不再启动 Meta provider call；可恢复 checkpoint；exhausted/cooldown 不进行重试风暴；enforced epoch 下 `observed` 不能发模型请求，标准路径绕过/复用/过期 permit 被 wrapper 拒绝，S3/S4 进程拿不到原始凭据且不能绕过 proxy 直连 provider。

### Change 8：Research Scout 最小集

先接 arXiv、OpenReview、Crossref、GitHub，完成 conditional fetch、去重、Research Card 与 pain-directed query。OpenAlex、Semantic Scholar 和通用搜索后续加入。

验收：重复论文收敛到稳定内部 work ID，后发现 identifier 只追加 alias，merge 后旧引用仍可解析且版本分别保留；每条 assertion 通过 source/hash/version/locator provenance gate；只有 top-N synthesis 消耗 research plan；fetch/parser/synthesizer profile 不能混权，私密查询、SSRF、redirect 绕过、parser bomb 和恶意外部内容在边界 fail-closed，不能扩大 ArtifactView 或触发执行。

### Change 9：Shadow/Canary

把已有 manual assignment 扩展为 task-strata/lineage cohort、shadow、standing grant、自动延迟结果和自动 pause/rollback。

验收：同一 interaction 不切 activation，默认 active episode 不切；canary 只进入允许 strata；用户一个命令恢复 stable。

### Change 10：首个行为性 Pi core patch

Phase 0 可能已经包含纯观测性的 P0/P1 seam。本变更只指改变行为或扩展可控行为面的 patch，优先 P3 tool 参数二次验证或经证据证明必要的 P2/P5；以实际 recorder/evolution 证据决定。每个 core patch 单独提交、测试并尝试上游。

验收：不依赖 Evo package 也能说明该 patch 对普通 Pi 的通用价值。

## 26. 系统级验收标准

### 26.1 正确性

- 每个 interaction 可还原 AssignmentDecision/Spec、lineage、actual activation、BehaviorBundle、kernel、ExecutionClosure、model、tools 和 approval；
- executor role/profile、BehaviorBundle subsystem、ActivationTuple subsystem 和 activation namespace 始终一致；Evaluator 只通过 active epoch manifest 解析；
- ArtifactView 与 CapabilityGrant 绑定同 run/attempt/role/profile/activation、未过期且 trust class 合法；
- Run finalization 严格满足 termination × write-set × CAS 真值表；失败/中断不能提交部分 state；
- CandidateManifest 只提供提示，Supervisor 能从实际 artifact/diff 独立重算 target、capability、data/code classification 和所需审批；
- raw facts 不被 evaluator 覆写；
- 每个 promotion 都能定位 candidate、报告和 grant；
- replay 明确区分 faithful、partial 和 non-replayable；
- replay 固定 workspace、ArtifactView 与 durable-state read view；live state 只接受 schema-validated write-set 的 CAS commit；
- 需求变化不被系统性误记为 agent failure。

### 26.2 可进化性

- S0–S4 均有 component/operator 表示或明确 patch operator；
- S0/S1 自动候选只能通过固定 `EvoPolicyRuntime` 解释为数据；生成代码、命令、依赖或自定义 reducer 会自动升级到 S3；
- Meta、Research、Optimizer 和 Evaluator 都可版本化；
- 单轴、多轴、interaction group 和 lineage 均能表达；Phase 6 的 LineageSetManifest 能在进程启动前选择不同 kernel/closure 并在 run 内 pin；
- 候选失败会影响下一轮搜索；
- 不需要修改 Supervisor 即可增加普通优化 surface。

### 26.3 人类控制

- 每个 subsystem 的 surface ceiling 与 automation ceiling 独立，具体规则只能收窄 default envelope；
- 多 target 候选按 default-deny 和 lattice meet 取最严格审批、能力、scope 与预算；
- Worker、Meta、Research、Evaluator 和 Scheduler 使用各自的 activation action gate；
- 每个 activation action 解析唯一 gate profile；证据 minimum 与 scoped activation maximum 保持各自声明的 unit；
- 支持 exact 和 standing approval；
- 每个自动动作可解释其授权来源；
- 用户可 pause、pin、exclude、forget、rollback；
- S5 只能走人工 core migration。

### 26.4 Subscription 体验

- foreground worker 永远高于后台默认任务；
- shared pool 有动态 reserve SLO，separate pool 提供硬隔离；
- 未知/低置信 quota 默认不发新的后台 provider permit；
- lease 绑定 run/attempt/pool epoch；每个 logical request 和真实 transport attempt 分别使用单次 permit；
- 每个 logical request 只有一条 usage/cache fact；每个真实 attempt 有独立 permit 和 HTTP/SDK request identity，最终 Assistant usage 不因 retry/fallback 被重复计量；
- Bedrock/第三方 adapter 的内部 retry 必须被关闭、由逐 attempt middleware 授权，或强制走 credential proxy；未知 transport 不宣称 hard accounting；
- active PlanEnforcementEpoch 为 enforced 后，`observed` 不能发 provider request；usage/lease/RunSpec 全部绑定同一 enforcement epoch；
- Meta workflow 可 checkpoint/preempt；
- 报告展示 plan capacity 和 optimization yield，而非虚假美元精度。

### 26.5 研究质量

- source adapter 有 provenance、cache 和 backoff；
- outbound query 只能来自 QueryFirewall 通过的 `PublicResearchQuery`，且有 payload digest 审计；
- 跨来源 work 使用不变内部 ID，identifier 只追加 alias，merge/tombstone 后旧 evidence ref 仍可解析，版本 observation 不覆盖；
- Research Card 的每条 assertion 都通过确定性 provenance gate 绑定具体 version/artifact/locator/source grade；人工 review 是独立签名 annotation；
- Research fetch/parser/synthesizer 使用不同 profile/grant；synthesizer 与 Meta candidate designer 使用不同 role/view/lease；
- fetch broker 和 parser sandbox 能拒绝 SSRF、redirect 绕过、压缩炸弹和 MIME 欺骗；
- 外部报告效果只作 prior；
- card 到 experiment、experiment 到 win 的转化可统计；
- 外部文档保持 untrusted-data 身份，各 executor 只得到最小化 ArtifactView。

### 26.6 运维

- Supervisor 重启可恢复；
- 单 channel、evaluator active 与 plan-enforcement active pointer 切换原子；Phase 6 每 subsystem 只有一个 active lineage-set root；跨 subsystem transaction 在 MVP 中按可补偿 saga 执行；
- last-known-good 可独立启动；
- GenesisGrant 只能在无 activation-destination history 时使用一次；
- 上游 Pi 更新有 compatibility report；
- artifact/DB 有备份、迁移、保留和删除策略。

### 26.7 可维护性

- 每个候选报告 BehaviorBundle/prompt/component/dependency/core-patch 增量；
- promotion 有 lineage-specific complexity budget，短期质量收益不能无限购买系统复杂度；
- build/startup、上游 patch burden 和 failure surface 不出现未审批的显著退化；
- activation 的 kernel、ExecutionClosure 和旧 schema reader 在 rollback 窗口内保持可启动；
- durable state 默认按 activation/version namespace 隔离，破坏性 migration 不进入 rollback 窗口。

## 27. 主要工程风险与应对

| 风险 | 真实原因 | 设计响应 |
|---|---|---|
| 稀疏日常信号 | 很多任务没有测试或显式评分 | 多信号 OutcomeVector、null、延迟结果、分层 posterior |
| 对个人历史过拟合 | replay bank 小且重复 | temporal holdout、task strata、live canary、多 lineage |
| 组件局部赢、组合输 | prompt/context/runtime 强交互 | typed graph、write conflict、A/B/A+B、整体 bundle gate |
| Meta 成本大于收益 | 订阅 plan 被候选搜索耗尽 | pain-driven、successive halving、Plan Broker、长期 ROI |
| 订阅 quota 不透明 | provider 不暴露精确剩余 | 观测 throttle/reset，区间估计，不伪造美元/token 线性 |
| Research 噪声 | 新论文结论未复现、实现条件不同 | Research Card、assumption ledger、本地最小实验 |
| 指标被钻空子 | proxy 改善而用户体验变差 | 原始向量、硬门、延迟结果、evaluator epoch、定期审计 |
| 上游漂移 | Pi API 和源码持续变化 | 独立 package、小 patch queue、ABI/golden compatibility |
| Replay 不真实 | transcript 相同但 workspace/外部状态不同 | workspace snapshot、fidelity 等级、shadow/canary 补充 |
| Memory/skill 膨胀 | 每次成功都写入经验 | 容量、merge/retire、匹配任务反事实、过期 |
| 后台影响前台 | shared subscription 和进程竞争 | lease、reserve、优先级、checkpoint、quiet hours |
| 审批疲劳 | 候选过多、报告过长 | standing policy、机会聚合、top-N、单屏 proposal card |

这些风险不是缩小优化范围的理由，而是决定实验设计、证据和回滚粒度的输入。

## 28. 审计清单

### 28.1 架构

- [ ] Constitution Core 是否仍然足够小且确定性；
- [ ] Worker、Meta、Evaluator、Supervisor 责任是否有循环；
- [ ] 当前运行版本是否会在 interaction 中改变；
- [ ] activation 是否完整绑定 BehaviorBundle、kernel 和 ExecutionClosure；
- [ ] activation subsystem、executor role 和 channel namespace 是否一致；
- [ ] AssignmentDecision/Spec、lineage、ChannelPointer、RunSpec 和实际启动 activation 是否一致；
- [ ] ArtifactView/CapabilityGrant 是否绑定同 run/attempt/role/profile/activation、expiry 和 trust class；
- [ ] 是否存在绕过 Registry 的加载路径。

### 28.2 Policy 与组合

- [ ] 每个 component 是否声明 stage/reads/writes/capability；
- [ ] BehaviorBundle capability envelope 是否完全由 component request 规范化派生，profile ceiling 是否再求交；
- [ ] 相同写目标是否有 exclusive/merge/arbitrate；
- [ ] overlay 是否有字段级合并规则；
- [ ] 多轴候选是否说明不可拆原因和最小 ablation；
- [ ] prompt/cache layout 是否可解释。
- [ ] S0/S1 是否始终是 schema-validated data，代码/命令/依赖是否自动升级到 S3；
- [ ] Worker、Evolution、Evaluation、Scheduling 四张图是否只通过 typed artifact/event 耦合。

### 28.3 数据与 Credit

- [ ] 原始事件和 annotation 是否分离；
- [ ] episode 边界是否正确；
- [ ] delayed outcome 是否通过 linker、workspace lineage 和 evidence adapter 归属，而不是只按时间窗口猜测；
- [ ] unknown 是否保持 null；
- [ ] agent_error/new_requirement 是否区分；
- [ ] replay fidelity 是否标级；
- [ ] activation credit 是否先于 bundle/组件 credit；
- [ ] delayed outcome 是否更新 ledger。
- [ ] durable state 是否固定 read view/snapshot，并通过 write-set + CAS 提交而非 executor 直写。
- [ ] Executor termination、write-set、CAS finalization 与 final termination 是否满足真值表。

### 28.4 审批与发布

- [ ] subsystem/surface/automation 三层约束是否独立且只能收窄；
- [ ] 多 target 是否对所有匹配规则取最小 ceiling、最强 approval、能力/scope 交集和最小预算；
- [ ] Worker canary/promotion、Evaluator epoch、Scheduler/Meta/Research policy activation 是否使用不同 action gate；
- [ ] exact grant 是否绑定 candidate、classification、ActivationTuple、report、范围、阶段和过期时间；
- [ ] GenesisGrant 是否仅在无 activation-destination history 时创建 baseline；Evaluator genesis 是否绑定 epoch manifest；
- [ ] promotion 是否验证 evaluator epoch；
- [ ] evaluator 是否只有一个 active epoch manifest pointer，且不能与同批 subject 一起切换；
- [ ] 每个 action 是否解析到匹配 subsystem 的 gate profile 和同 unit 的 evidence requirement；
- [ ] channel 切换是否原子；
- [ ] 跨 subsystem 发布是否按 MVP saga/rollback，而没有把多个 rename 误称为原子；
- [ ] canary assignment policy 是否与 activation 绑定在同一 ChannelPointer；saga 是否 fence 新 assignment，并验证所有正向/逆向中间组合；
- [ ] 实际 canary run 是否绑定 AssignmentDecision/Spec、source pointer、feature view、cohort epoch、lineage、strata 和 scoped budget；
- [ ] 启用 multi-lineage 后是否只有一个 active LineageSetManifest assignment root；
- [ ] rollback 是否实际演练；
- [ ] S4 与 S5 是否走不同流程。

### 28.5 Subscription

- [ ] Worker/Meta 是 shared 还是 separate pool；
- [ ] foreground reserve 是否被描述和校准为概率性 SLO，而非未知 quota 下的硬保证；
- [ ] 需要硬隔离时是否使用 separate plan 或 strict quiet-hours；
- [ ] Meta run 是否可 checkpoint；
- [ ] lease 是否绑定 run/attempt/pool epoch，logical request 与每个 transport retry/fallback attempt 是否分别单次原子消费；
- [ ] active PlanEnforcementEpoch 是否唯一、未过期；observe-only 是否只允许固定 activation，enforced 是否拒绝所有 observed provider call；
- [ ] throttle/cooldown 是否入账；
- [ ] token/cache 是否仅作为实测解释变量；
- [ ] 每个候选是否计算未来收益与 Meta capacity。
- [ ] 每个 lease/usage 是否标注 executor role、cost center、service class 和 assignment。
- [ ] Direct wrapper 是否强制 `maxRetries=0` 且仅用于可证明单 attempt adapter；其他路径是否移除原始凭据并强制 proxy 每 attempt 取 permit。

### 28.6 Research

- [ ] 查询是否来自明确 agenda/pain；
- [ ] outbound query 是否通过确定性 QueryFirewall/DLP，并保留 private mapping 与公开 payload 的分离审计；
- [ ] 内部 work ID 是否不变，identifier alias/merge/tombstone 和 version 是否正确；
- [ ] 每条 assertion 是否经 deterministic gate 回到当前 ArtifactView 内的 work/version/artifact/locator，source grade 是否由 registry 派生；
- [ ] fetch/parser/synthesizer 是否使用互斥 profile，任何 grant 是否避免同时拥有 source fetch/cache-write 与 coding-plan credential；
- [ ] 人工 review 是否为独立签名 annotation，而非 producer 自报布尔值；
- [ ] 是否记录反证、限制和适用条件；
- [ ] 是否先去重再用 Meta plan；
- [ ] Research synthesizer 是否只输出 ProposedResearchCard，Meta 是否只消费 gate 后的 ResearchCard 而不读取 raw source；
- [ ] fetch/redirect/parser 是否经过统一 broker、SSRF 检查和受限 sandbox；
- [ ] 是否明确本地 seam/experiment；
- [ ] 外部内容是否只生成 candidate。
- [ ] 外部文本是否始终作为不可信数据，Research/Meta 是否使用最小化只读 ArtifactView。

### 28.7 当前 Pi 源码

- [ ] 优先用 SDK/extension/custom entry 而非无必要 core patch；
- [ ] tool hook 修改后的参数是否重新验证；
- [ ] extension 顺序是否已由 bundle compiler 固定；
- [ ] logical request 与每个 transport attempt 是否分表并有独立 ID/ordinal/transport/retry-fallback reason；Assistant response ID/final usage 是否只在 logical record 出现一次，HTTP/SDK request ID/精确 attempt usage 是否只在 attempt record 出现；
- [ ] enforced attempt 是否精确绑定已消费 permit；Bedrock/第三方 adapter 的 hidden retry 是否被关闭、middleware 授权或 proxy 隔离；
- [ ] 两级 cache observation 是否保留普通/1h cache write，P2 是否分离 session、prompt-key 和 transport-affinity identity，unsupported/coupled 是否被明确记录；
- [ ] compaction 是否进入 usage/quality 评价；
- [ ] generated model 文件是否只通过生成脚本更新；
- [ ] 上游同步是否运行 compatibility fixtures。

### 28.8 复杂度与执行闭包

- [ ] ExecutionClosure 是否包含 entrypoint/build artifact、dependency lock、runtime image、loader、provider adapter、环境契约和 state schema/migration；
- [ ] channel 文件是否只指向完整 ChannelPointer digest，stable/canary 的 assignment-policy nullability 是否正确；
- [ ] report 是否展示 bundle bytes、prompt tokens、组件/依赖数、build/startup 和 core patch burden；
- [ ] 复杂度增长是否在 lineage budget 内，并由可测收益覆盖；
- [ ] last-known-good activation 是否已从冷启动实际恢复。

## 29. 需要用户最终确定的部署参数

设计本身不依赖这些答案，但实现前应把它们写入第一个 `ApprovalPolicy`：

| 参数 | 推荐初值 | 影响 |
|---|---|---|
| Worker/Meta plan | 若同一订阅则 shared；否则 separate | reserve 和抢占 |
| 默认模式 | Broad | S0–S2 高自动化，S3/S4 人批 |
| 激活边界 | 新 episode；MVP 新 session/process | 连续体验、credit 与 cache 稳定 |
| Meta 并发 | 1 | 防止额度与实验爆炸 |
| shared 前台 reserve | 75% 概率性 SLO，运行后校准 | 日常可用性；硬隔离需 separate plan |
| Research 比例 | pain/adjacent/frontier = 70/20/10 | 探索强度 |
| 首批可 canary repo | 指定个人低风险 repo | 真实证据 |
| raw artifact retention | 30–90 天，审计/聚合长期 | 磁盘与隐私 |
| delayed outcome 窗口 | 1/7/30 天 | 长期 credit |
| S3 promotion | exact approval | tool/hook/runtime |
| S4 promotion | exact approval | Pi worker kernel |
| evaluator 更新 | 独立人工 epoch | 防止共同漂移 |

### 29.1 Broad 模式配置样例

这是 schema 草案，用于把设计决策具体化：

```jsonc
{
  "schemaVersion": 1,
  "mode": "broad",
  "stateDir": "${PI_CODING_AGENT_DIR}/evo",

  "worker": {
    "executor": "coding-agent",
    "assignmentBoundary": "episode",
    "stableChannel": "worker/lineages/general/stable",
    "planPool": "primary"
  },

  "meta": {
    "executor": "coding-agent-rpc",
    "planPool": "primary",
    "maxConcurrency": 1,
    "checkpointAtRoleBoundaries": true,
    "quietHoursOnly": false
  },

  "approval": {
    "defaultRule": {
      "surfaceCeiling": "S4",
      "automationCeiling": "A5"
    },
    "subsystemRules": [
      {
        "subsystem": "worker",
        "surfaceCeiling": "S4",
        "automationCeiling": "A5",
        "capabilityCeiling": {
          "filesystem": [
            {"root": "workspace", "access": "write"},
            {"root": "run-artifact-view", "access": "read"}
          ],
          "networkDomains": [],
          "processCommands": [
            {
              "commandId": "pi-existing-bash-tool",
              "executableDigest": "sha256:GENESIS_TOOL_DIGEST",
              "argvPatternDigest": "sha256:EXISTING_WORKER_POLICY"
            }
          ],
          "credentialHandles": ["coding-plan:primary"],
          "externalSideEffects": [],
          "limits": {
            "maximumWallTimeMs": 3600000,
            "maximumOutputBytes": 104857600
          }
        },
        "planBudget": {
          "planPoolId": "primary",
          "maxConcurrentRuns": 1,
          "maxReplayRunsPerCandidate": 20
        },
        "scopedActivationBudgets": {
          "worker.canary": {
            "unit": "interactions",
            "maximum": 10
          }
        },
        "actionGateProfiles": {
          "worker.canary": "sha256:WORKER_CANARY_GATE_V1",
          "worker.promote": "sha256:WORKER_PROMOTE_GATE_V1"
        },
        "componentRules": [
          {
            "surfaces": ["S0", "S1"],
            "componentKinds": [],
            "capabilityCeilingOverride": null,
            "automationCeiling": "A5",
            "actionRequirements": {
              "worker.canary": "standing",
              "worker.promote": "standing"
            }
          },
          {
            "surfaces": ["S2"],
            "componentKinds": [],
            "capabilityCeilingOverride": null,
            "automationCeiling": "A5",
            "actionRequirements": {
              "worker.canary": "standing",
              "worker.promote": "standing"
            }
          },
          {
            "surfaces": ["S3", "S4"],
            "componentKinds": [],
            "capabilityCeilingOverride": null,
            "automationCeiling": "A3",
            "actionRequirements": {
              "worker.canary": "exact",
              "worker.promote": "exact"
            }
          }
        ]
      },
      {
        "subsystem": "meta",
        "surfaceCeiling": "S4",
        "automationCeiling": "A5",
        "capabilityCeiling": {
          "filesystem": [
            {"root": "candidate-worktrees", "access": "write"},
            {"root": "run-artifact-view", "access": "read"}
          ],
          "networkDomains": [],
          "processCommands": [
            {
              "commandId": "approved-build-toolchain",
              "executableDigest": "sha256:PINNED_BUILD_TOOLCHAIN",
              "argvPatternDigest": "sha256:BUILD_POLICY"
            }
          ],
          "credentialHandles": ["coding-plan:primary"],
          "externalSideEffects": [],
          "limits": {
            "maximumWallTimeMs": 3600000,
            "maximumOutputBytes": 104857600
          }
        },
        "planBudget": {
          "planPoolId": "primary",
          "maxConcurrentRuns": 1,
          "maxReplayRunsPerCandidate": 20
        },
        "scopedActivationBudgets": {
          "meta.canary-policy": {
            "unit": "runs",
            "maximum": 5
          }
        },
        "actionGateProfiles": {
          "meta.canary-policy": "sha256:META_CANARY_GATE_V1",
          "meta.activate-policy": "sha256:META_ACTIVATE_GATE_V1"
        },
        "componentRules": [
          {
            "surfaces": ["S0", "S1", "S2"],
            "componentKinds": [],
            "capabilityCeilingOverride": null,
            "automationCeiling": "A5",
            "actionRequirements": {
              "meta.canary-policy": "standing",
              "meta.activate-policy": "standing"
            }
          },
          {
            "surfaces": ["S3", "S4"],
            "componentKinds": [],
            "capabilityCeilingOverride": null,
            "automationCeiling": "A3",
            "actionRequirements": {
              "meta.canary-policy": "exact",
              "meta.activate-policy": "exact"
            }
          }
        ]
      },
      {
        "subsystem": "research",
        "surfaceCeiling": "S4",
        "automationCeiling": "A5",
        "capabilityCeiling": {
          "filesystem": [
            {"root": "research-source-staging", "access": "write"},
            {"root": "research-parsed-staging", "access": "write"},
            {"root": "research-card-staging", "access": "write"},
            {"root": "run-artifact-view", "access": "read"}
          ],
          "networkDomains": [],
          "processCommands": [],
          "credentialHandles": ["coding-plan:primary"],
          "externalSideEffects": ["research-fetch-broker:request"],
          "limits": {
            "maximumWallTimeMs": 1800000,
            "maximumOutputBytes": 52428800
          }
        },
        "executorProfileCeilings": {
          "research-fetch": {
            "filesystem": [
              {"root": "research-source-staging", "access": "write"},
              {"root": "run-artifact-view", "access": "read"}
            ],
            "networkDomains": [],
            "processCommands": [],
            "credentialHandles": [],
            "externalSideEffects": ["research-fetch-broker:request"],
            "limits": {
              "maximumWallTimeMs": 900000,
              "maximumOutputBytes": 52428800
            }
          },
          "research-parser": {
            "filesystem": [
              {"root": "research-parsed-staging", "access": "write"},
              {"root": "run-artifact-view", "access": "read"}
            ],
            "networkDomains": [],
            "processCommands": [],
            "credentialHandles": [],
            "externalSideEffects": [],
            "limits": {
              "maximumWallTimeMs": 900000,
              "maximumOutputBytes": 52428800
            }
          },
          "research-synthesizer": {
            "filesystem": [
              {"root": "research-card-staging", "access": "write"},
              {"root": "run-artifact-view", "access": "read"}
            ],
            "networkDomains": [],
            "processCommands": [],
            "credentialHandles": ["coding-plan:primary"],
            "externalSideEffects": [],
            "limits": {
              "maximumWallTimeMs": 1800000,
              "maximumOutputBytes": 10485760
            }
          }
        },
        "planBudget": {
          "planPoolId": "primary",
          "maxConcurrentRuns": 1,
          "maxReplayRunsPerCandidate": 5
        },
        "scopedActivationBudgets": {
          "research.canary-policy": {
            "unit": "runs",
            "maximum": 5
          }
        },
        "actionGateProfiles": {
          "research.canary-policy": "sha256:RESEARCH_CANARY_GATE_V1",
          "research.activate-policy": "sha256:RESEARCH_ACTIVATE_GATE_V1"
        },
        "componentRules": [
          {
            "surfaces": ["S0", "S1", "S2"],
            "componentKinds": [],
            "capabilityCeilingOverride": null,
            "automationCeiling": "A5",
            "actionRequirements": {
              "research.canary-policy": "standing",
              "research.activate-policy": "standing"
            }
          },
          {
            "surfaces": ["S3", "S4"],
            "componentKinds": [],
            "capabilityCeilingOverride": null,
            "automationCeiling": "A3",
            "actionRequirements": {
              "research.canary-policy": "exact",
              "research.activate-policy": "exact"
            }
          }
        ]
      },
      {
        "subsystem": "evaluator",
        "surfaceCeiling": "S4",
        "automationCeiling": "A3",
        "capabilityCeiling": {
          "filesystem": [
            {"root": "run-artifact-view", "access": "read"},
            {"root": "replay-workspaces", "access": "write"}
          ],
          "networkDomains": [],
          "processCommands": [
            {
              "commandId": "approved-test-toolchain",
              "executableDigest": "sha256:PINNED_TEST_TOOLCHAIN",
              "argvPatternDigest": "sha256:TEST_POLICY"
            }
          ],
          "credentialHandles": ["coding-plan:primary"],
          "externalSideEffects": [],
          "limits": {
            "maximumWallTimeMs": 3600000,
            "maximumOutputBytes": 104857600
          }
        },
        "planBudget": {
          "planPoolId": "primary",
          "maxConcurrentRuns": 1,
          "maxReplayRunsPerCandidate": 20
        },
        "scopedActivationBudgets": {
          "evaluator.shadow-epoch": {
            "unit": "runs",
            "maximum": 5
          }
        },
        "actionGateProfiles": {
          "evaluator.shadow-epoch": "sha256:EVALUATOR_SHADOW_GATE_V1",
          "evaluator.activate-epoch": "sha256:EVALUATOR_ACTIVATE_GATE_V1"
        },
        "componentRules": [
          {
            "surfaces": ["S0", "S1", "S2", "S3", "S4"],
            "componentKinds": [],
            "capabilityCeilingOverride": null,
            "automationCeiling": "A3",
            "actionRequirements": {
              "evaluator.shadow-epoch": "exact",
              "evaluator.activate-epoch": "exact"
            }
          }
        ]
      },
      {
        "subsystem": "plan-scheduler",
        "surfaceCeiling": "S4",
        "automationCeiling": "A3",
        "capabilityCeiling": {
          "filesystem": [{"root": "run-artifact-view", "access": "read"}],
          "networkDomains": [],
          "processCommands": [],
          "credentialHandles": [],
          "externalSideEffects": [],
          "limits": {
            "maximumWallTimeMs": 600000,
            "maximumOutputBytes": 10485760
          }
        },
        "planBudget": {
          "planPoolId": "primary",
          "maxConcurrentRuns": 1,
          "maxReplayRunsPerCandidate": 20
        },
        "scopedActivationBudgets": {
          "scheduler.canary-policy": {
            "unit": "cycles",
            "maximum": 10
          }
        },
        "actionGateProfiles": {
          "scheduler.canary-policy": "sha256:SCHEDULER_CANARY_GATE_V1",
          "scheduler.activate-policy": "sha256:SCHEDULER_ACTIVATE_GATE_V1"
        },
        "componentRules": [
          {
            "surfaces": ["S0", "S1", "S2"],
            "componentKinds": [],
            "capabilityCeilingOverride": null,
            "automationCeiling": "A3",
            "actionRequirements": {
              "scheduler.canary-policy": "standing",
              "scheduler.activate-policy": "standing"
            }
          },
          {
            "surfaces": ["S3", "S4"],
            "componentKinds": [],
            "capabilityCeilingOverride": null,
            "automationCeiling": "A3",
            "actionRequirements": {
              "scheduler.canary-policy": "exact",
              "scheduler.activate-policy": "exact"
            }
          }
        ]
      }
    ],
    "coreMigration": "human-only",
    "lineages": ["general"],
    "repositories": ["/absolute/path/to/approved-low-risk-repo"],
    "taskStrata": ["*"],
    "riskLevels": ["low"],
    "globalBudgets": {
      "maxConcurrentRuns": 1,
      "maxReplayRunsPerCandidate": 20,
      "maxConcurrentScopedActivationRuns": 1,
      "expiresAt": "2026-08-12T00:00:00Z"
    },
    "universalGates": {
      "maximumRiskRegression": 0,
      "minimumEvidenceWeight": 1
    }
  },

  "planEnforcement": {
    "activeEpochPointer": "registry/plan-enforcement/active",
    "activeEpochManifestDigest": "sha256:PLAN_ENFORCEMENT_EPOCH_V1",
    "requiredMode": "enforced"
  },

  "planPools": [
    {
      "id": "primary",
      "kind": "subscription",
      "provider": "configured-coding-plan-provider",
      "accountRef": "credential-handle:primary",
      "sharing": "shared",
      "roles": [
        "worker",
        "meta",
        "research",
        "evaluator",
        "plan-scheduler"
      ],
      "foregroundReserveRatio": 0.75,
      "unknownQuotaMarginRatio": 0.15,
      "pauseBackgroundOnForeground": true
    }
  ],

  "evaluation": {
    "activeEpochPointer": "registry/evaluators/active",
    "gateProfileDirectory": "${PI_CODING_AGENT_DIR}/evo/registry/gate-profiles",
    "delayedOutcomeDays": [1, 7, 30],
    "requirePairedReplayWhenReplayable": true
  },

  "research": {
    "enabled": true,
    "synthesisExecutor": "coding-agent-rpc",
    "planPool": "primary",
    "maxSynthesisConcurrency": 1,
    "allocation": {
      "painDirected": 0.70,
      "adjacent": 0.20,
      "frontier": 0.10
    },
    "sources": [
      "arxiv",
      "openreview",
      "crossref",
      "github"
    ],
    "fetchBroker": {
      "allowedDomains": [
        "export.arxiv.org",
        "api2.openreview.net",
        "api.crossref.org",
        "api.github.com"
      ]
    },
    "metadataFetchUsesCodingPlan": false,
    "researchSynthesisTopNPerDay": 10
  },

  "retention": {
    "rawArtifactsDays": 60,
    "workspaceSnapshotsDays": 30,
    "audit": "long-term",
    "aggregates": "long-term"
  }
}
```

启用前必须把示例 repo 绝对路径、provider/account credential handle、所有 `sha256:*` 占位 digest 和 `expiresAt` 换成真实值；Supervisor 拒绝占位值、过期 policy、缺失 gate profile 和空 allowlist 的 canary。Evaluator 与 plan enforcement 的 `activeEpochPointer` 分别只是各自唯一 registry pointer 的位置，不是第二份 epoch 配置；Broad production 要求 plan manifest 的实际 mode 为 `enforced`。Research 的三个 profile grant 必须分别编译，fetch domain 只属于 Constitution fetch broker，不能回填到 research executor 的 direct-network capability。若 Worker 和 Meta 使用不同订阅，创建 `worker-plan`、`meta-plan` 两个 pool，并同时更新各 subsystem 的 `planBudget.planPoolId` 和 executor 引用；其余协议不变。MVP 只允许 `general` lineage；Phase 6 才能把更多 lineage 写入 active LineageSetManifest。示例中的概率、比例和天数是启动 prior，必须由真实 workload 校准。

### 29.2 Gate profile artifact 样例

`actionGateProfiles` 中的每个 digest 都必须解析到匹配 subsystem/action 的 immutable artifact。以 Worker stable promotion 为例：

```json
{
  "schemaVersion": 1,
  "profileId": "worker-promote-v1",
  "subsystem": "worker",
  "action": "worker.promote",
  "evaluatorEpochConstraint": {"kind": "active"},
  "evidence": {
    "unit": "interactions",
    "minimum": 5,
    "minimumDistinct": 3,
    "minimumLiveEvidenceWeight": 1,
    "minimumPerTargetStratum": 2
  },
  "conditions": [
    {
      "metric": "quality_delta",
      "comparison": "gte",
      "threshold": -0.01,
      "requiredProbability": 0.99,
      "missingValue": "insufficient-evidence"
    },
    {
      "metric": "target_utility_delta",
      "comparison": "gte",
      "threshold": 0.02,
      "requiredProbability": 0.95,
      "missingValue": "insufficient-evidence"
    }
  ]
}
```

Canary profile 通常要求 replay/shadow 证据并限制可进入的 task strata；stable profile 要求完成 A4 live evidence。Meta、Research、Evaluator 和 Scheduler profile 使用第 7.6 节对应指标，不复制这个 Worker 模板。Profile canonical digest 进入 ApprovalPolicy、CandidateClassification、EvaluationReport 和 EvaluatorEpochManifest，任一内容变化都会使旧报告和 exact grant 失效。

## 30. 非目标

第一阶段不做：

- 训练或在线更新基础模型权重；
- 把公开 benchmark 当成唯一目标；
- 保证每个 episode 都能得到精确组件 credit；
- 让 Meta-Pi 直接发布自己的代码；
- 默认启用多 Agent；
- 用无限抓取代替有主题的 Research Agenda；
- 为了 cache 命中牺牲必要 context；
- 从零重写 Pi 已有的 provider、session、TUI 和 tool 基础设施。

## 31. 参考资料

### 31.1 当前 Pi

- [AgentHarness 设计](../packages/agent/docs/agent-harness.md)
- [Durable harness 设计](../packages/agent/docs/durable-harness.md)
- [Harness hooks](../packages/agent/docs/hooks.md)
- [Harness observability](../packages/agent/docs/observability.md)
- [Coding-agent SDK](../packages/coding-agent/docs/sdk.md)
- [Extension API](../packages/coding-agent/docs/extensions.md)
- [RPC mode](../packages/coding-agent/docs/rpc.md)
- [Session format](../packages/coding-agent/docs/session-format.md)
- [Compaction](../packages/coding-agent/docs/compaction.md)
- [Security/containerization](../packages/coding-agent/docs/security.md)
- [Current AgentHarness source](../packages/agent/src/harness/agent-harness.ts)
- [Current coding-agent AgentSession](../packages/coding-agent/src/core/agent-session.ts)
- [Current extension runner](../packages/coding-agent/src/core/extensions/runner.ts)
- [Current cache statistics](../packages/coding-agent/src/core/cache-stats.ts)
- [OpenAI Responses cache adapter](../packages/ai/src/api/openai-responses.ts)
- [Anthropic cache adapter](../packages/ai/src/api/anthropic-messages.ts)
- [OpenAI Codex cache adapter](../packages/ai/src/api/openai-codex-responses.ts)
- [Azure OpenAI Responses cache adapter](../packages/ai/src/api/azure-openai-responses.ts)
- [OpenAI Completions adapter](../packages/ai/src/api/openai-completions.ts)

### 31.2 自进化与评估研究

- [Darwin Gödel Machine](https://arxiv.org/abs/2505.22954)
- [Huxley-Gödel Machine: Human-Level Coding Agent Development by an Approximation of the Optimal Self-Improving Machine](https://arxiv.org/abs/2510.21614)
- [CODESKILL](https://arxiv.org/abs/2605.25430)
- [Exact Is Easier: Credit Assignment for Cooperative LLM Agents](https://arxiv.org/abs/2603.06859v2)
- [Reducing Cost of LLM Agents with Trajectory Reduction](https://arxiv.org/abs/2509.23586)
- [Beyond Resolution Rates: Behavioral Drivers of Coding Agent Success and Failure](https://arxiv.org/abs/2604.02547)
- [The Red Queen Gödel Machine: Co-Evolving Agents and Their Evaluators](https://arxiv.org/abs/2606.26294)（preliminary preprint/work in progress）
- [Inefficiencies of Meta Agents for Agent Design](https://arxiv.org/abs/2510.06711)

这些工作用于提出搜索、skill、context、credit 和 archive 的设计假设；本地 promotion 仍以个人 workload 证据为准。

### 31.3 Provider cache 官方资料

- [OpenAI Prompt Caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Anthropic Prompt Caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)

Provider cache 语义会变化，实际 adapter 以实现时的官方文档和实测 usage 为准。

### 31.4 Research Scout 数据源

- [arXiv API manual](https://info.arxiv.org/help/api/user-manual.html)
- [OpenReview API](https://docs.openreview.net/getting-started/using-the-api)
- [OpenAlex API](https://developers.openalex.org/)
- [Semantic Scholar API](https://api.semanticscholar.org/api-docs)
- [Semantic Scholar API overview](https://www.semanticscholar.org/product/api)
- [Semantic Scholar API license](https://www.semanticscholar.org/product/api/license)
- [Crossref REST API](https://www.crossref.org/documentation/retrieve-metadata/rest-api/)
- [Crossref REST access and authentication](https://www.crossref.org/documentation/retrieve-metadata/rest-api/access-and-authentication/)
- [Crossref 2025 rate-limit update](https://www.crossref.org/blog/announcing-changes-to-rest-api-rate-limits/)
- [GitHub REST API best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)

## 32. 架构决策记录

| ID | 决策 | 选择理由 | 何时重新考虑 |
|---|---|---|---|
| ADR-001 | Pi 作为 Worker Kernel，新建 Evo 控制面 | 复用 provider/session/TUI/tools，同时保持实验自由 | Pi seam 无法承载关键行为，且长期 patch 成本高于重写 |
| ADR-002 | `packages/evo` 独立于 coding-agent | 上游同步、职责和发布边界清晰 | Evo 协议成为 Pi 的通用稳定能力并获上游接受 |
| ADR-003 | interaction 内强制固定 activation，默认 episode pin | 保证连续体验、cache、credit、回放和解释一致 | runtime 条件决策应在固定 BehaviorBundle 内表达；只有显式用户选择才在 active episode 中切换 activation |
| ADR-004 | Typed Policy Graph + 固定 EvoPolicyRuntime | 以确定解释器执行声明式 bundle，消除当前 extension collision 语义差异 | Pi core 原生提供同等 phase/effect graph 后可下沉 |
| ADR-005 | OutcomeVector + task strata + posterior | 日常任务没有单一 benchmark/reward | 只可扩展，不退回单一分数存储 |
| ADR-006 | 当前先 coding-agent SDK/RPC，AgentHarness 作中长期 adapter | 日常功能成熟与未来 harness 方向兼得 | AgentHarness 获得 coding-agent parity 后统一 |
| ADR-007 | Plan Broker 使用部分可观察 capacity | subscription quota 不透明且非美元线性 | provider 提供可靠实时 quota API 时增加精确 adapter |
| ADR-008 | Research Card 后再生成 Candidate | 外部结论只提供机制 prior | 不重新考虑；可优化筛选但不绕过本地实验 |
| ADR-009 | SQLite metadata + CAS artifact | 查询、事务、内容去重和大对象分工清晰 | 单机规模或 Node driver 约束证明不合适 |
| ADR-010 | S0–S4 可进化，S5 人工 migration | 最大搜索空间与最小控制面同时成立 | 只有人明确重新定义 Constitution 时 |
| ADR-011 | Evaluator 只由 active epoch manifest pointer 激活 | 把 evaluator binary、policy、metric、gate 和 holdout identity 绑定成一个裁判版本 | 不增加第二个权威 pointer；只可替换 manifest 内容模型 |
| ADR-012 | 可信标准路径用 stream wrapper；S3/S4 用外置 credential proxy | 普通 extension handler 会吞错，同进程任意代码还可绕过公开 stream path | Pi core 加 OS/credential boundary 等价的不可绕过 provider authorization seam |
| ADR-013 | MVP 跨 subsystem 发布使用 compatibility + assignment fence + saga | 多个独立文件 rename 不能提供真实原子性，且不可暴露不兼容半升级组合 | 引入单 registry-generation root pointer 后可提供原子切换 |
| ADR-014 | Research/Meta 使用角色化 ArtifactView | 外部内容与 optimizer 不应直接接触 secret、holdout 和发布权限 | 可扩展 view 内容，不取消角色边界 |
| ADR-015 | Durable state 通过 snapshot/read-view/write-set/CAS | 让 replay、credit、并发和 rollback 都绑定真实状态 | 有可证明等价的事务状态后端时替换实现 |
| ADR-016 | Gate profile 按 subsystem/action 绑定 | Worker 质量指标不能评价 Meta、Research、Evaluator 和 Scheduler | 只可新增 profile/metric，不退回一个全局 reward |
| ADR-017 | Research 出站只通过固定 QueryFirewall、fetch broker 与 parser sandbox | 全网吸收经验需要开放来源面，但查询脱敏、SSRF/redirect 防护和执行边界不能由被研究内容控制 | 可替换实现，不把这些边界放入普通 candidate space |
| ADR-018 | Plan/cache accounting 分离 logical request 与 transport attempt | provider adapter 的 retry/fallback 会让一次 agent stream 产生多次真实请求；final Assistant usage 属于 logical request，不能复制到 attempt；每个真实 attempt 仍需独立 permit 和 HTTP/SDK identity | Provider 提供更强原生 reservation/usage identity 时映射到该协议 |
| ADR-019 | 每个 run 绑定 AssignmentDecision/Spec | ChannelPointer 只证明候选如何发布，不能证明某个真实任务为何进入 canary | Assignment Engine 被等价的可验证调度协议替代时 |
| ADR-020 | ArtifactView/CapabilityGrant 绑定 run、role、profile、activation 与 expiry | 仅凭 artifact digest 无法防止跨角色、跨 attempt 复用 | 有能力型对象存储原生提供同等不可转让 grant 时 |
| ADR-021 | 模型调用受唯一 PlanEnforcementEpoch 控制 | `observed` 只能是短期迁移态，不能成为 enforced Broker 的无 permit 旁路 | Provider/OS 提供更强且可证明的账户级硬配额隔离时 |
| ADR-022 | Research 使用 fetch/parser/synthesizer 三个互斥 profile | 全网抓取能力、解析不可信内容和 coding-plan 综合不应叠在同一个 run grant | 可增加 profile，不把三者重新合并 |
| ADR-023 | Research 内部 work ID 永不重键，Card 经 provenance gate | 后发现 DOI、模型自报 source grade 或 review boolean 都不能成为引用与信任根 | 可替换 identity/gate 实现，不破坏稳定 ID 和独立 annotation |
| ADR-024 | Multi-lineage 由唯一 LineageSetManifest 在启动前路由 | 选择不同 kernel/closure 必须发生在 process/run pin 之前，且不能存在多个 assignment root | 只部署单 lineage 时保持 `general` 简化路径 |
| ADR-025 | Bundle capability envelope 只由组件请求派生 | 手写 envelope 与 ComponentManifest 会形成两个权限权威源 | 不重新考虑；可替换规范化算法但保持单一来源 |
| ADR-026 | Cache identity 分离 session、prompt key 与 transport affinity | 当前部分 adapter 把三者耦合，A/B 若不显式记录会把重连/affinity 误算成 cache 效果 | Adapter 原生独立控制后仍保留三个观测维度 |
| ADR-027 | Phase 2 在首个 live canary 前交付最小 enforced Plan Broker | observe-only 明确不能授权 candidate；若把 Broker 延后到 Meta 阶段，首个 canary 在协议上无法调用模型 | 可把完整后台 scheduler 延后，但不能把 canary 所需的 lease/permit enforcement 延后 |

## 33. 最终设计决策

Evo-Pi 不应被实现为一个不断覆写当前目录的自修改脚本。它应当是：

> 以 Pi 为可替换 Worker Kernel，以版本化 Policy Graph 为行为，以真实日常 Episode 为训练信号，以 Meta-Pi 和 Research Scout 为候选生成器，以订阅 Plan Broker 为资源调度，以 Supervisor、Evaluator、审批和 Registry 为进化控制面的个人 Agent 系统。

允许最大优化范围的正确方式，不是让所有代码都处于同一写权限下，而是让 S0–S4 都能进入候选空间、自动实验并产生证据，同时只把 S5 留作很小的人类迁移边界。这样 prompt、cache、skill、tool、hook、runtime、模型路由、验证器乃至 Pi kernel 都能持续优化，并仍然可以解释、组合、审批、回滚和同步上游。
