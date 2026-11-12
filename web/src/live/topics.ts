export const LIVE_TOPICS = [
  { id: 'emotion', name: '心理与情绪' }, { id: 'thinking', name: '认知与思维' },
  { id: 'self', name: '主体性与自我' }, { id: 'growth', name: '成长与行动' },
  { id: 'relationships', name: '人性与关系' }, { id: 'wealth', name: '财富与金钱' },
  { id: 'investing', name: '投资与交易' }, { id: 'business', name: '商业与创业' },
  { id: 'society', name: '社会与权力' }, { id: 'ai', name: 'AI与未来' },
  { id: 'meaning', name: '人生与意义' }, { id: 'health', name: '身体与健康' },
  { id: 'family', name: '家庭与教育' },
] as const
export type LiveTopicId = typeof LIVE_TOPICS[number]['id']
export const liveTopic = (value: unknown) => LIVE_TOPICS.find(topic => topic.id === value)
export const topicHouseKey = (id: LiveTopicId) => `repo-${-1013 + LIVE_TOPICS.findIndex(topic => topic.id === id)}`
