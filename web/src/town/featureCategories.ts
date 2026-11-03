// SS 自身的用途目录，只组织展示，不改写功能登记、执行状态或验收记录。
import type { HouseFeature } from './houseInfo'
import type { BuildingView } from './townModel'

interface PurposeDefinition {
  id: string
  title: string
  question: string
  note?: string
  features: Record<string, string>
}

export const SS_FEATURE_PURPOSES: readonly PurposeDefinition[] = [
  { id: 'find', title: '找到工作', question: '谁在做，工作归到哪里？', features: {
    'session-discovery': '发现 Claude / Codex 会话',
    'work-attribution': '把会话归到对应项目和任务',
    'more-agents': '接入其他 Agent',
    'claude-hooks-coverage': '补齐 Claude 的活动记录',
    'signal-provenance': '看清信息来源与更新时间',
  } },
  { id: 'understand', title: '看清进度', question: '做到哪，卡在哪，下一步是什么？', features: {
    'live-summary': '查看谁在做和下一步安排',
    'project-briefs': '查看进展、卡点和交接',
    'core-feature-progress': '按功能看开发进度',
    'town-house-feature-card': '从房子查看项目概况',
    'readable-project-canvas': '查看项目关系与位置',
    'town-world-navigation': '在地图中找到项目并返回',
    'ai-summary': '阅读标明推断的 AI 摘要',
    'agent-review': '回看 Agent 的执行记录',
    'external-merge-sync': '核对代码是否已经合并',
  } },
  { id: 'decide', title: '处理决定', question: '哪些事需要我判断或确认？', features: {
    'permission-decisions': '处理权限申请和提问',
    'work-item-state-management': '验收、暂停、转交或继续',
    'needs-you-notify': '收到需要你处理的通知',
    'native-attention-surface': '在桌面上看到提醒',
    'town-first-screen-reminders': '在小镇看到待处理提醒',
    'checked-auto-merge': '检查通过后执行已批准的合并',
  } },
  { id: 'continue', title: '开始或继续做', question: '从哪里开始，怎样接着做？', features: {
    'managed-sessions': '从 SS 发起工作会话',
    'conversation-return': '回到原会话继续处理',
    'native-codex-desktop-continuation': '打开并接续 Codex 桌面会话',
    'live-terminal': '查看运行终端，按需接管',
    'agent-handoff': '把工作交给另一个 Agent',
    'handled-elsewhere-receipt': '提示已在原会话处理',
  } },
  { id: 'manage', title: '日常管理', question: '怎样整理项目、查看用量和维护？', features: {
    'project-archive-management': '归档与恢复项目',
    'project-trash-management': '删除项目并保留恢复入口',
    'usage-stats': '查看各次工作的 Token 用量',
    'remote-access': '从手机或其他设备查看',
    'macos-in-app-update': '检查和安装 SS 更新',
  } },
  { id: 'background', title: '后台自动推进', question: '哪些事能在授权下自动接续？',
    note: '这里说明能力用途；是否启用、当前是否暂停，请以实际设置和工作项管理状态为准。', features: {
    'orchestration-contract': '规定自动推进的权限范围',
    'orchestration-router': '在有限授权下接着推进任务',
    'event-pass-through': '把后续事件交回负责人',
    'independent-watchdog': '只读巡检停滞与异常',
    'quiet-automatic-routines': '整理例行任务记录并提醒异常',
  } },
]

export interface PurposeFeature extends HouseFeature { label: string }
export interface FeatureSection { id: string; title: string; question: string; note?: string; items: PurposeFeature[] }

const SS_ANCHORS = ['session-discovery', 'work-attribution', 'core-feature-progress', 'town-world-navigation']

/** 用项目名和多项稳定功能识别 SS；其他项目保留原清单，不按标题猜测用途。 */
export function featureSections(b: BuildingView, features: readonly HouseFeature[]): { mapped: boolean; sections: FeatureSection[] } {
  const ids = new Map(features.map(f => [f.id, f]))
  const mapped = /^session-steward(?:$| · )/i.test(b.repo?.name ?? '') && SS_ANCHORS.filter(id => ids.has(id)).length >= 2
  if (!mapped) return { mapped: false, sections: features.length ? [{ id: 'all', title: '功能清单', question: '尚未整理用途，展开查看已登记功能。', items: features.map(f => ({ ...f, label: f.title })) }] : [] }
  const used = new Set<string>()
  const sections: FeatureSection[] = SS_FEATURE_PURPOSES.map(({ features: labels, ...purpose }) => ({
    ...purpose,
    items: Object.entries(labels).flatMap(([id, label]) => {
      const feature = ids.get(id)
      if (!feature) return []
      used.add(id)
      return [{ ...feature, label }]
    }),
  })).filter(section => section.items.length > 0)
  const unclassified = features.filter(f => !used.has(f.id)).map(f => ({ ...f, label: f.title }))
  if (unclassified.length) sections.push({ id: 'unclassified', title: '待分类功能', question: '这些新登记功能还未归入用途目录。', items: unclassified })
  return { mapped: true, sections }
}
