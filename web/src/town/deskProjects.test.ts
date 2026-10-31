import { expect, it } from 'vitest'
import { deskProjects } from './WorldScene'

const district = (id: string, name: string, device: string | undefined, statuses: string[]) => ({
  id, key: id, b: { name, repo: { id: 1, device }, items: statuses.map((status, i) => ({ id: `${id}-${i}`, status })) },
}) as any

it('按电脑分组：这台在前，其他电脑的标为只能看；只算待验收的工作项', () => {
  const world = { districts: [
    district('a', '合成甲', undefined, ['review', 'in_progress']),
    district('b', '合成乙', '笔记本', ['review', 'review']),
    district('c', '合成丙', undefined, ['review', 'review', 'review']),
    district('d', '合成丁', undefined, ['done']),
  ] } as any
  const groups = deskProjects(world, (d) => d.b.repo?.device === '笔记本')
  expect(groups.map((g) => [g.device, g.remote, g.projects.map((p) => [p.d.b.name, p.count])])).toEqual([
    ['这台电脑', false, [['合成丙', 3], ['合成甲', 1]]],
    ['笔记本', true, [['合成乙', 2]]],
  ])
})
