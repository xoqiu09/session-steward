import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { TownGuide } from './TownGuide'

it('说明讲清地图上的东西、操作、每天怎么用和它不做什么，本身没有任何操作按钮', () => {
  const html = renderToStaticMarkup(<TownGuide onClose={() => {}} />)
  for (const t of ['地图上的东西', '怎么操作', '每天怎么用', '它不做什么', '房子 = 一个项目', '小人 = 一个会话', '菜 = 一个工作项', '收菜 N', '复制恢复命令', '数据只存在这台电脑']) {
    expect(html).toContain(t)
  }
  expect(html.match(/town-guide-crops/g)).toHaveLength(1)
  expect(html).not.toMatch(/>验收通过<|>退回修改<|>允许本次</)
})
