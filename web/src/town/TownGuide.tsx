// 小镇使用说明：地图上的东西是什么、怎么操作、每天怎么用、它不做什么。图例尽量用地图上真的那几样画出来。
import type { ReactNode } from 'react'
import { CropShape } from './field'
import { STATUS_CHIPS } from './status'
import { AGENTS } from './agents'
import type { CropStage } from './harvest'

const STAGES: { stage: CropStage; overripe?: boolean; name: string; means: string }[] = [
  { stage: 'seed', name: '种子', means: '待开始' },
  { stage: 'sprout', name: '发芽', means: 'Agent 正在做' },
  { stage: 'thirsty', name: '缺水', means: '等你决定' },
  { stage: 'ripe', name: '熟了', means: '等你验收' },
  { stage: 'ripe', overripe: true, name: '发蔫', means: '熟了两天还没收' },
  { stage: 'bug', name: '生虫', means: '受阻' },
]

function Icon({ children, w = 44, h = 44 }: { children: ReactNode; w?: number; h?: number }) {
  return <svg className="town-guide-icon" width={w} height={h} viewBox={`${-w / 2} ${-h + 8} ${w} ${h}`} aria-hidden>{children}</svg>
}

function Row({ icon, title, children }: { icon?: ReactNode; title: string; children: ReactNode }) {
  return (
    <li className="town-guide-row">
      {icon && <span className="town-guide-swatch">{icon}</span>}
      <div><strong>{title}</strong> {children}</div>
    </li>
  )
}

export function TownGuide({ onClose }: { onClose: () => void }) {
  return (
    <aside className="town-guide" role="dialog" aria-label="小镇怎么看" onPointerDown={(e) => e.stopPropagation()}>
      <header className="town-guide-head">
        <h2>小镇怎么看</h2>
        <button type="button" onClick={onClose} aria-label="关闭说明">关闭</button>
      </header>
      <p className="town-guide-lead">
        小镇把 Session Steward 里的工作画成一张地图：<b>项目是房子，会话是小人，工作项是门口的菜</b>。它只负责让你一眼看出哪里需要你；真正的操作都在点开后的卡片里。
      </p>

      <nav className="town-guide-toc" aria-label="说明目录">
        {[['tg-map', '地图上的东西'], ['tg-ops', '怎么操作'], ['tg-day', '每天怎么用'], ['tg-not', '它不做什么']].map(([id, label]) => (
          <button key={id} type="button" onClick={() => document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'smooth' })}>{label}</button>
        ))}
      </nav>

      <section id="tg-map">
        <h3>1 · 地图上的东西</h3>
        <ul className="town-guide-list">
          <Row title="房子 = 一个项目。">越大说明未完成的工作和最近的活动越多：小木屋 → 房子 → 工坊 → 大楼。</Row>
          <Row title="村庄、野外和广场。">最近一起开发、互相有关的几个项目聚成村庄，围着一口井；7 天没动静的项目是野外的小屋；中间的广场是全镇合计、你的验收台和告示栏（等你决定的事）。</Row>
          <Row title="小人 = 一个会话。" icon={<span className="town-guide-dots">{AGENTS.map((a) => <i key={a.key} style={{ background: a.color }} title={a.label} />)}</span>}>
            衣服颜色看是哪个 Agent：{AGENTS.map((a, i) => <span key={a.key}>{i ? '、' : ''}<i className="town-guide-dot" style={{ background: a.color }} />{a.label}</span>)}。
            头上举着“等你决定”牌子 = 在等你；手边冒火花 = 正在干；z z = 闲着；红色“!” = 出错；问号云 = 很久没收到它的消息。
          </Row>
        </ul>
        <p className="town-guide-sub"><b>菜 = 一个工作项</b>，长势就是它的状态：</p>
        <ul className="town-guide-crops">
          {STAGES.map((s) => (
            <li key={s.name}>
              <Icon><g transform="scale(1.35)"><CropShape stage={s.stage} overripe={s.overripe} kind="tomato" /></g></Icon>
              <strong>{s.name}</strong><span>{s.means}</span>
            </li>
          ))}
        </ul>
        <ul className="town-guide-list">
          <Row title="名牌上的色点。">
            {STATUS_CHIPS.map((c) => <span key={c.key} className="town-guide-chip"><i style={{ background: c.dot }} />{c.short}</span>)}
            <span className="town-guide-chip"><i style={{ background: '#7a3a32' }} />失败</span>
            分别是等你决定、正在干活、等你验收、受阻、最近失败的数量。名牌边框黄色 = 有事等你决定，红色 = 有受阻。
          </Row>
          <Row title="门口的红白路障">= 这个项目有受阻的工作项。<b>退件筐</b> = 最近失败的运行；<b>小纸箱</b> = 一次正在进行的运行。</Row>
        </ul>
      </section>

      <section id="tg-ops">
        <h3>2 · 怎么操作</h3>
        <ul className="town-guide-list">
          <Row title="移动和缩放：">拖动地图，滚轮缩放。拉远只显示名牌，拉近才看得到小人和菜。右上角“全景”看全部，“广场”回到中间。</Row>
          <Row title="点房子或名牌：">走进这个项目内部。工作台 = 工作项，墙上白板 = 这个项目等你决定的事。左上“← 回到世界”或按 Esc 回来。</Row>
          <Row title="点小人：">打开会话详情，里面的“复制恢复命令”粘到终端，就能接着那个会话干。</Row>
          <Row title="点菜：">打开这个工作项；熟了的菜会显示验收卡片（交付了什么、在哪个分支、验收标准）。</Row>
          <Row title="收菜 N：">一棵一棵飞到熟了的菜前、打开验收卡片。满意点“验收通过”收下，不满意点“退回修改”重新种，处理完自动去下一棵。</Row>
          <Row title="按 Agent 看：">名牌改成 Claude / Codex / 其他各有几个会话；在右边图例里点一个，只突出它。</Row>
          <Row title="小地图：">右下角，点哪里镜头就飞到哪里。桌面模式会自己在需要你的项目之间巡游，你一拖动就先停 30 秒。</Row>
        </ul>
      </section>

      <section id="tg-day">
        <h3>3 · 每天怎么用</h3>
        <ol className="town-guide-steps">
          <li><b>先找黄色“决定”。</b>有 Agent 在等你回复或批准：点举牌的小人或广场的告示栏去处理，不然它会一直停着。</li>
          <li><b>再点“收菜”。</b>把熟了的一棵一棵看完：读交付说明，对照验收标准，满意就收下。</li>
          <li><b>看红色“受阻”和路障。</b>点进去看卡在哪，决定是你来解决，还是让 Agent 换个做法。</li>
          <li><b>想接着某个会话干活：</b>点小人 → 复制恢复命令 → 粘到终端。</li>
        </ol>
      </section>

      <section id="tg-not">
        <h3>4 · 它不做什么</h3>
        <ul className="town-guide-plain">
          <li>小镇只读：不会替你批准、验收、合并或派单，这些都只在卡片里由你点。</li>
          <li>“验收通过”只改工作项的状态，不会合并代码，也不会发布。</li>
          <li>会话结束 ≠ 工作完成：工作项会一直留在地里，直到你收下或放弃。</li>
          <li>数据只存在这台电脑的 ~/.steward，别的电脑看不到这里的工作。</li>
        </ul>
      </section>
    </aside>
  )
}
