import Foundation

/// Keep notification requests in the same explicit data directory as the host.
func notificationDirectory(arguments: [String], environment: [String: String], userHome: URL) -> URL {
    let flag = arguments.firstIndex(of: "--steward-home")
    let argument = flag.flatMap { $0 + 1 < arguments.count ? arguments[$0 + 1] : nil }
    let home = (argument ?? environment["STEWARD_HOME"]).map { URL(fileURLWithPath: $0) }
        ?? userHome.appendingPathComponent(".steward")
    return home.appendingPathComponent("notifications").standardizedFileURL
}
