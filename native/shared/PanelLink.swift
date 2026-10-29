import Foundation

/// A notification can select a record. It cannot contain credentials or perform an action.
struct PanelTarget: Hashable {
    enum Kind: String, Hashable { case item, approval, session }
    let kind: Kind
    let id: String

    init?(kind: String, id: String) {
        guard let kind = Kind(rawValue: kind), !id.isEmpty, id.utf8.count <= 256,
              id.unicodeScalars.allSatisfy({ CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.:").contains($0) }) else { return nil }
        self.kind = kind
        self.id = id
        if kind == .session { guard let number = Int(id), number > 0 else { return nil } }
    }

    var path: String {
        var parts = URLComponents()
        parts.path = "/"
        parts.queryItems = [URLQueryItem(name: "view", value: "town"), URLQueryItem(name: "world", value: "1")]
        var fragment = URLComponents()
        fragment.queryItems = [URLQueryItem(name: kind.rawValue, value: id)]
        parts.percentEncodedFragment = fragment.percentEncodedQuery
        return parts.string!
    }

    func appURL(port: Int) -> URL {
        var parts = URLComponents()
        parts.scheme = "session-steward"
        parts.host = "open"
        parts.queryItems = [URLQueryItem(name: "port", value: String(port)), URLQueryItem(name: kind.rawValue, value: id)]
        return parts.url!
    }

    static func fromPanelURL(_ url: URL) -> PanelTarget? {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false), parts.scheme == "http",
              ["127.0.0.1", "localhost", "::1"].contains((parts.host ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "[]"))),
              parts.user == nil, parts.password == nil, parts.query == nil,
              parts.path == "/" || parts.path.isEmpty,
              (1...65535).contains(parts.port ?? 80), let fragment = parts.percentEncodedFragment,
              let fields = URLComponents(string: "?" + fragment)?.queryItems, fields.count == 1,
              let id = fields[0].value else { return nil }
        return PanelTarget(kind: fields[0].name, id: id)
    }

    /// Only the configured local service may be selected, including during a cold launch.
    static func fromIncomingURL(_ url: URL, base: URL) -> PanelTarget? {
        let port = base.port ?? 80
        if url.scheme == "http" {
            guard (url.port ?? 80) == port else { return nil }
            return fromPanelURL(url)
        }
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme == "session-steward", parts.host == "open", parts.path.isEmpty,
              parts.user == nil, parts.password == nil, parts.port == nil, parts.fragment == nil,
              let fields = parts.queryItems, fields.count == 2,
              fields.filter({ $0.name == "port" }).count == 1,
              fields.first(where: { $0.name == "port" })?.value == String(port),
              let field = fields.first(where: { $0.name != "port" }), let id = field.value else { return nil }
        return PanelTarget(kind: field.name, id: id)
    }
}

/// Preserve the latest click while the backend starts; the default world must not overwrite it.
struct PanelNavigation {
    static let world = "/?view=town&world=1"
    private(set) var ready = false
    private var pending: PanelTarget?

    mutating func receive(_ target: PanelTarget) -> String? {
        if ready { return target.path }
        pending = target
        return nil
    }

    mutating func backendReady() -> String {
        ready = true
        defer { pending = nil }
        return pending?.path ?? Self.world
    }

    mutating func restarting() { ready = false }
}
