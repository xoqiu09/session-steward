import Foundation
import Darwin

// Synthetic blocked file open verifies startup remains bounded even when macOS
// or a removable filesystem cannot immediately return the configuration bytes.
let root = URL(fileURLWithPath: CommandLine.arguments[1])
try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
let missing = Paths.readConfiguration(root.appendingPathComponent("missing.json"))
precondition(missing.0 == nil && missing.1 == nil)
let valid = root.appendingPathComponent("valid.json")
let bytes = Data("{\"listen\":\"127.0.0.1:17788\"}".utf8)
try bytes.write(to: valid)
precondition(Paths.readConfiguration(valid).0 == bytes)
let release = DispatchSemaphore(value: 0)
let start = Date()
let blocked = Paths.readConfiguration(root.appendingPathComponent("blocked-config.json")) { _ in
    release.wait(); return bytes
}
precondition(blocked.0 == nil && blocked.1?.contains("2 秒") == true)
precondition(Date().timeIntervalSince(start) < 3)
release.signal()
try FileManager.default.removeItem(at: valid)
print("PASS: missing/valid configuration and 2-second blocked-open timeout")
