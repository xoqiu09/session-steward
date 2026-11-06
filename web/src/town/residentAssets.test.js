// 文件分发检查在 Node/Vitest 中执行，不给浏览器项目增加 Node 类型依赖。
import { readFileSync, existsSync } from 'node:fs'
import { expect, it } from 'vitest'

it('七只使用的六张立绘都提供，并保留独立的素材许可', () => {
  const root = new URL('../../public/residents/', import.meta.url)
  for (const id of ['deepseek', 'claude', 'gpt', 'gemini', 'glm', 'grok', 'qwen']) {
    for (const pose of ['idle', 'pat', 'sleep', 'activity', 'greet', 'avatar']) expect(existsSync(new URL(`${id}/${pose}.webp`, root))).toBe(true)
  }
  expect(readFileSync(new URL('ATTRIBUTION.md', root), 'utf8')).toContain('CC BY-NC-SA 4.0')
})
