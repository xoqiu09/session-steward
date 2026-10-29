import Foundation

func notificationFailureMessage(_ status: String?) -> String {
    switch status {
    case "permission_denied": return "系统通知权限未开启。请在“系统设置 → 通知”中检查 Session Steward 的通知权限。"
    case "helper_unavailable": return "通知助手文件缺失。请重新安装完整的 Session Steward App。"
    case "helper_launch_failed": return "通知助手未能启动。请退出并重新打开 Session Steward 后再试。"
    case "helper_timeout": return "通知助手未及时回应。请稍后再试；若再次失败，请保留这条提示以便排查。"
    case "spool_failed": return "无法保存本次测试提醒。请检查小镇数据目录是否可写。"
    case "delivery_failed": return "系统返回了通知投递错误。请稍后重试。"
    default: return "本次测试没有取得通知助手的投递结果。请稍后再试，并保留这条提示以便排查。"
    }
}
