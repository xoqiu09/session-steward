/** 其他设备的编号：工作项带“设备名:”前缀，会话、运行编号加了 10 亿的倍数。 */
export const HUB_STRIDE = 1_000_000_000

/** 界面上写的会话、运行编号：其他设备的去掉偏移，和在那台电脑上看到的一样。 */
export const shownNo = (id: number) => id % HUB_STRIDE
