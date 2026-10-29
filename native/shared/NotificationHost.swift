import Foundation

/// Prefer the enclosing App so a separately identified preview never wakes the real installation.
func notificationHost(helper: URL, identifier: String, installed: [URL]) -> URL? {
    let enclosing = helper.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    for candidate in [enclosing] + installed {
        guard candidate.pathExtension == "app", let bundle = Bundle(url: candidate), bundle.bundleIdentifier == identifier,
              let types = bundle.object(forInfoDictionaryKey: "CFBundleURLTypes") as? [[String: Any]],
              types.contains(where: { ($0["CFBundleURLSchemes"] as? [String])?.contains("session-steward") == true }) else { continue }
        return candidate
    }
    return nil
}
