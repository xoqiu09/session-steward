import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProjectHousekeeping } from './ProjectHousekeeping'

const repo = (is_git: boolean) => ({ id: 7, name: 'synthetic', common_dir: is_git ? '/synthetic/.git' : 'dir:/synthetic', is_git, target_ref: 'main' })

describe('房间里的归档、删除与工作目录', () => {
  it('提供归档和移入回收站，并说明只改显示', () => {
    const html = renderToStaticMarkup(<ProjectHousekeeping repo={repo(true)} name="synthetic" />)
    expect(html).toContain('归档、删除与工作目录')
    expect(html).toContain('>归档这个项目<')
    expect(html).toContain('>移入回收站<')
    expect(html).toContain('代码目录、会话和验收记录都保留')
    // 工作目录要打开后向本机服务读取，不会预先给出删除按钮。
    expect(html).not.toContain('>删除工作目录<')
  })
  it('非 Git 项目说明没有可删除的工作目录', () => {
    expect(renderToStaticMarkup(<ProjectHousekeeping repo={repo(false)} name="synthetic" />)).toContain('不是 Git 仓库')
  })
})
