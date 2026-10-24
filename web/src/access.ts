// 界面提示与防误触；远程权限最终由服务端判定。
export function isRemote(loc?: { protocol: string; hostname: string }) {
  const l = loc ?? (typeof window === 'undefined' ? undefined : window.location)
  if (!l) return false
  return l.protocol === 'https:' && !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(l.hostname)
}

export const remoteReadOnlyMessage = '远程只读：审批及修改请回本机面板。'
