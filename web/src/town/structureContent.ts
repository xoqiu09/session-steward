// 手工整理的 SS 样本；只描述源码规则，不绑定房屋、快照或真实工作记录。
export interface StructureNode {
  id: string
  title: string
  caption: string
  text: string
}
export interface StructureEdge { from: string; to: string; label: string; conditional?: boolean }
export interface StructureEvidence { path: string; line: number; explains: string }
export interface StructurePage {
  id: 'overview' | 'pause'
  label: string
  title: string
  lead: string
  nodes: StructureNode[]
  edges: StructureEdge[]
  readers?: StructureNode[]
  notes: { title: string; text: string }[]
  evidence: StructureEvidence[]
}

export const STRUCTURE_BASIS = { date: '2026-11-03', commit: '2e452a1', category: '源码核对 · 人工整理' } as const

export const STRUCTURE_OBJECTS = [
  { name: 'WorkItem', label: '要完成什么', text: '一件工作的目标、进度与交付。可以跨多个会话持续存在。' },
  { name: 'Session', label: '在哪个会话里做', text: 'Claude、Codex 等工具中的会话。运行或停止，是会话状态。' },
  { name: 'Run', label: '哪次尝试在做', text: '把一个会话与一件工作关联，记录这次尝试的开始、结束和结果。' },
  { name: 'Approval', label: '哪件事等人决定', text: '权限、问题或合并等正式请求，单独记录决定与送达结果。' },
] as const

export const STRUCTURE_PAGES: StructurePage[] = [
  {
    id: 'overview', label: '整体结构', title: '从工具里的工作，到你手上的决定',
    lead: 'SS 把分散的会话整理成项目视图。沿着编号看：信息从哪里来，如何关联，再怎样成为你能判断的进度。',
    nodes: [
      { id: 'tools', title: '执行工具', caption: 'Claude / Codex / CLI', text: '实际工作发生在原工具里；活动与主动回报是信息入口。' },
      { id: 'ingest', title: '采集与归属', caption: 'Hook → Core', text: '接收事件，识别项目和会话，把尝试关联到工作项。' },
      { id: 'store', title: 'SQLite 事实', caption: '对象 + 原始事件', text: '保存工作项、会话、运行、审批和简报来源，供后续读取。' },
      { id: 'state', title: '状态与简报', caption: 'Snapshot + Brief', text: '汇总当前状态、依赖、下一步与来源；缺少回报时保留未知。' },
      { id: 'town', title: '小镇展示', caption: '项目 → 房子 · 会话 → 小人', text: '把快照变成房屋、工作台、提示和详情入口；通知也读取这些记录。' },
      { id: 'owner', title: '用户决定', caption: '判断 · 审批 · 验收', text: '你在原有入口作决定。决定另行记录，Agent 交付仍需你验收。' },
    ],
    edges: [
      { from: 'tools', to: 'ingest', label: '事件与回报' },
      { from: 'ingest', to: 'store', label: '校验、关联、写入' },
      { from: 'store', to: 'state', label: '读取并汇总' },
      { from: 'state', to: 'town', label: '快照供界面读取' },
      { from: 'town', to: 'owner', label: '展示需要你判断的事' },
    ],
    notes: [
      { title: '一份记录，连接多个功能', text: '每日十分钟、小镇、项目简报和通知各有展示规则，但会读取共同的工作与管理记录。改一个共享字段，要沿读取关系检查影响。' },
      { title: '进度要分开判断', text: '会话停止、Agent 交付、测试通过、代码合并、安装运行和用户验收是不同证据。Run 结束不能直接推成 WorkItem 已完成。' },
    ],
    evidence: [
      { path: 'internal/core/ingest.go', line: 56, explains: '事件接收、原始事件保存与状态处理' },
      { path: 'internal/core/attribution.go', line: 27, explains: '会话、工作项与运行的归属关联' },
      { path: 'internal/store/schema.go', line: 25, explains: '工作项以及会话、运行、审批、事件的存储结构' },
      { path: 'internal/core/query.go', line: 22, explains: '四个核心对象；第 155 行起组装快照' },
      { path: 'internal/core/brief.go', line: 134, explains: '带来源的 Agent 简报；第 336 行起读取简报' },
      { path: 'web/src/api.ts', line: 100, explains: '拉取快照、订阅变化并刷新界面' },
      { path: 'web/src/town/townModel.ts', line: 158, explains: '快照转成小镇的项目、会话和工作对象' },
    ],
  },
  {
    id: 'pause', label: '暂停提醒', title: '一个“暂停”，为什么会影响多个模块？',
    lead: '表单只写一次管理状态；界面、通知和 Router 分别读取它。下面展示功能规则，不代表某件真实任务的当前状态。',
    nodes: [
      { id: 'entry', title: '原有详情入口', caption: '工作项 → 管理状态', text: '从每日十分钟或工作项详情，进入原有管理表单。' },
      { id: 'form', title: '选择暂停提醒', caption: 'management.state = paused', text: '填写可选说明，确认后才提交。本说明页没有该操作。' },
      { id: 'patch', title: '工作项接口', caption: 'PATCH /api/work-items/{id}', text: 'Core 校验管理操作；只提交 paused 时保留工作项执行状态。' },
      { id: 'management', title: '共享管理记录', caption: 'meta + brief_entries', text: '保存管理状态与历史说明；Snapshot 将其放进 WorkItem.Management。' },
    ],
    readers: [
      { id: 'views', title: '每日十分钟 / 小镇', caption: '读取 Snapshot', text: '放入“已转交或暂停提醒”；日常停滞提示和受阻计数按管理状态过滤。' },
      { id: 'notify', title: '日常通知', caption: '读取管理记录', text: '跳过该工作项的日常接手与待处理催办；正式审批仍走独立路径。' },
      { id: 'router', title: 'Router', caption: '有条件的资格复查', text: '检查到 paused 或 delegated 时返回 user_managed，阻止新的自动动作。' },
    ],
    edges: [
      { from: 'entry', to: 'form', label: '打开表单' },
      { from: 'form', to: 'patch', label: '确认后提交' },
      { from: 'patch', to: 'management', label: '校验并保存' },
      { from: 'management', to: 'views', label: '经 Snapshot 读取' },
      { from: 'management', to: 'notify', label: '通知过滤读取' },
      { from: 'management', to: 'router', label: '资格复查读取', conditional: true },
    ],
    notes: [
      { title: 'Router 支线：有前置条件', text: '全局编排启用且发起相应动作，才会进入相关路径。有效且未撤销、未过期的授权、匹配的目标版本与项目范围等检查在前；待验收状态也会更早被拦截。不能认定每个暂停项都会实际返回 user_managed。' },
      { title: '证据边界', text: '此图按依据版本核对源码。Router 支线未通过正式任务触发实测；打开说明不会启用编排。暂停不会中断已开始的会话，也不等于完成工作、功能验收或全局停用。' },
    ],
    evidence: [
      { path: 'web/src/ui/WorkStatusActions.tsx', line: 9, explains: '暂停帮助、管理表单与第 35 行的提交' },
      { path: 'internal/server/server.go', line: 214, explains: '复用有面板鉴权的工作项 PATCH 接口' },
      { path: 'internal/core/workitems.go', line: 112, explains: '管理与执行状态分开校验；paused 不改写执行状态' },
      { path: 'internal/core/work_management.go', line: 39, explains: '写入 meta 管理记录与 brief_entries 历史' },
      { path: 'internal/core/query.go', line: 233, explains: '管理记录进入 WorkItem.Management' },
      { path: 'web/src/today/todayModel.ts', line: 103, explains: '日常停滞分类；第 120 行为管理区分类' },
      { path: 'web/src/town/stalled.ts', line: 13, explains: '小镇停滞提示过滤；town/status.ts:27 为受阻计数' },
      { path: 'internal/core/notify.go', line: 154, explains: '日常催办通知读取管理状态' },
      { path: 'internal/core/orchestration_router.go', line: 18, explains: '前置检查；第 62 行为 user_managed 条件分支' },
      { path: 'internal/core/orchestration.go', line: 117, explains: '全局编排模式单独保存，缺省为 disabled' },
    ],
  },
]
