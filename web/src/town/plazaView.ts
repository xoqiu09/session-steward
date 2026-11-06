// 广场视线：告示栏和验收台是小镇最重要的两样东西，画在它们前面的院子树不能挡字。
import { iso, type Pt } from './iso'

export interface ScreenBox { x0: number; y0: number; x1: number; y1: number }

const hit = (a: ScreenBox, b: ScreenBox) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1

/** 告示栏和验收台（含招牌）占的屏幕范围。 */
export function plazaCoreBoxes(board: Pt, boardHeight: number, desk: { gx: number; gy: number }): ScreenBox[] {
  const corners = [iso(desk.gx, desk.gy), iso(desk.gx + 3.6, desk.gy), iso(desk.gx + 3.6, desk.gy + 1.6), iso(desk.gx, desk.gy + 1.6)]
  return [
    { x0: board[0] - 78, x1: board[0] + 78, y0: board[1] - boardHeight - 24, y1: board[1] + 2 },
    { x0: Math.min(...corners.map((c) => c[0])), x1: Math.max(...corners.map((c) => c[0])), y0: Math.min(...corners.map((c) => c[1])) - 70, y1: Math.max(...corners.map((c) => c[1])) },
  ]
}

/** 这棵树（按画风的实际大小）会不会盖住广场核心。 */
export function treeHidesPlaza(at: Pt, k: number, illustrated: boolean, core: readonly ScreenBox[]): boolean {
  const halfW = (illustrated ? 63 : 20) * k, height = (illustrated ? 150 : 55) * k
  const box = { x0: at[0] - halfW, x1: at[0] + halfW, y0: at[1] - height, y1: at[1] }
  return core.some((c) => hit(box, c))
}
