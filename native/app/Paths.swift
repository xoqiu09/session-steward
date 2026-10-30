import Foundation

func appArgument(_ flag: String) -> String? {
    let args = ProcessInfo.processInfo.arguments
    guard let index = args.firstIndex(of: flag), index + 1 < args.count else { return nil }
    return args[index + 1]
}
func updateTransaction() -> String? { appArgument("--update-transaction") ?? ProcessInfo.processInfo.environment["STEWARD_UPDATE_TRANSACTION"] }

// MARK: - 路径与配置

struct Paths {
    /// 数据目录：和命令行版本一样，STEWARD_HOME 优先，否则 ~/.steward。
    let home: URL
    /// App 里带的 steward 程序。
    let steward: URL
    /// 面板地址（来自 config.json 的 listen，缺省 127.0.0.1:7788）。
    let listen: String
    let configurationError: String?

    static func load() -> Paths {
        let env = ProcessInfo.processInfo.environment
        let home = (appArgument("--steward-home") ?? env["STEWARD_HOME"]).map { URL(fileURLWithPath: $0) }
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".steward")
        var listen = "127.0.0.1:7788"
        let (configData, configError) = readConfiguration(home.appendingPathComponent("config.json"))
        if let data = configData,
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let l = obj["listen"] as? String, !l.isEmpty {
            listen = l
        }
        let steward = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/steward")
        return Paths(home: home, steward: steward, listen: listen, configurationError: configError)
    }

    /// A protected/removable volume may stall open() until macOS permission is
    /// resolved. Keep the native UI responsive and never start at a guessed port.
    static func readConfiguration(_ file: URL, read: @escaping (URL) throws -> Data = { try Data(contentsOf: $0) }) -> (Data?, String?) {
        let done = DispatchSemaphore(value: 0)
        let lock = NSLock()
        var result: Data?
        var issue: String?
        DispatchQueue.global().async {
            var loaded: Data?; var errorText: String?
            do { loaded = try read(file) } catch {
                let e = error as NSError
                if !(e.domain == NSCocoaErrorDomain && e.code == NSFileReadNoSuchFileError) { errorText = "无法读取配置文件，请检查数据目录的读取权限后重新打开 App。" }
            }
            lock.lock(); result = loaded; issue = errorText; lock.unlock(); done.signal()
        }
        guard done.wait(timeout: .now() + 2) == .success else {
            return (nil, "读取配置文件超过 2 秒。macOS 可能正在等待磁盘访问许可；请检查系统提示或数据盘状态后重新打开 App。本次没有启动或更改后台。")
        }
        lock.lock(); defer { lock.unlock() }; return (result, issue)
    }

    var base: URL { URL(string: "http://\(listen)")! }
    var tokenFile: URL { home.appendingPathComponent("panel.token") }
    func token() -> String? {
        (try? String(contentsOf: tokenFile, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
    }
}

extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

