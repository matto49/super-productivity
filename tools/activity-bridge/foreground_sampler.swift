// macOS-only, opt-in Codex foreground estimate. No screen capture or text storage.
// Compile as a stable .app bundle so macOS can grant this executable Accessibility.
import AppKit
import ApplicationServices
import Foundation
import IOKit
import Darwin

private struct Settings {
    let ledgerPath: String
    let humanSince: TimeInterval
    let idleLimit: Double
    let titleOwners: [String: String]
}

private struct Observation {
    let taskId: String
    let at: TimeInterval
}

private func object(at path: String) throws -> [String: Any] {
    let data = try Data(contentsOf: URL(fileURLWithPath: path))
    guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw NSError(domain: "ForegroundSampler", code: 1)
    }
    return value
}

private func time(_ value: Any?) -> TimeInterval? {
    guard let value = value as? String else { return nil }
    let parser = ISO8601DateFormatter()
    parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = parser.date(from: value) { return date.timeIntervalSince1970 }
    parser.formatOptions = [.withInternetDateTime]
    return parser.date(from: value)?.timeIntervalSince1970
}

private func settings(at path: String) throws -> Settings {
    let config = try object(at: path)
    guard let ledgerPath = config["ledgerFile"] as? String,
          let since = time(config["humanSince"] ?? config["since"]) else {
        throw NSError(domain: "ForegroundSampler", code: 2)
    }
    var owners: [String: Set<String>] = [:]
    var managed = Set<String>()
    if let mappingPath = config["mappingFile"] as? String {
        let mapping = try object(at: mappingPath)
        guard mapping["schemaVersion"] as? Int == 1,
              let tasks = mapping["tasks"] as? [[String: Any]] else {
            throw NSError(domain: "ForegroundSampler", code: 3)
        }
        for task in tasks {
            guard let taskId = task["taskId"] as? String,
                  let links = task["links"] as? [[String: Any]] else { continue }
            managed.insert(taskId)
            if links.contains(where: { ($0["scope"] as? String) == "pending" }) { continue }
            for link in links where (link["scope"] as? String) == "wholeThread"
                    && (link["role"] as? String) != "background" {
                if let title = link["humanTitleMatch"] as? String, !title.isEmpty {
                    owners[title, default: []].insert(taskId)
                }
            }
        }
    }
    for binding in config["bindings"] as? [[String: Any]] ?? [] {
        guard let taskId = binding["taskId"] as? String,
              let title = binding["title"] as? String,
              !managed.contains(taskId), !title.isEmpty else { continue }
        owners[title, default: []].insert(taskId)
    }
    let unique = owners.compactMapValues { $0.count == 1 ? $0.first : nil }
    return Settings(ledgerPath: ledgerPath, humanSince: since,
                    idleLimit: (config["idleSeconds"] as? Double) ?? 60,
                    titleOwners: unique)
}

private func attribute(_ element: AXUIElement, _ key: String) -> AnyObject? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, key as CFString, &value) == .success
        ? value as AnyObject? : nil
}

private func string(_ element: AXUIElement, _ key: String) -> String {
    attribute(element, key) as? String ?? ""
}

private func descendants(_ root: AXUIElement, limit: Int = 3000) -> [AXUIElement] {
    var queue = [root]
    var result: [AXUIElement] = []
    while !queue.isEmpty && result.count < limit {
        let item = queue.removeFirst()
        result.append(item)
        if let children = attribute(item, kAXChildrenAttribute as String) as? [AXUIElement] {
            queue.append(contentsOf: children)
        }
    }
    return result
}

private func focusedTitle(_ app: NSRunningApplication) -> String? {
    let root = AXUIElementCreateApplication(app.processIdentifier)
    guard let window = attribute(root, kAXFocusedWindowAttribute as String) as! AXUIElement? else {
        return nil
    }
    let elements = descendants(window)
    let webTitles = elements.filter { string($0, kAXRoleAttribute as String) == "AXWebArea" }
        .map { string($0, kAXTitleAttribute as String) }.filter { !$0.isEmpty }
    let actions = elements.filter {
        string($0, kAXRoleAttribute as String) == "AXPopUpButton"
            && ["聊天操作", "Chat actions"].contains(string($0, kAXTitleAttribute as String))
    }
    guard webTitles.count == 1, actions.count == 1,
          let parent = attribute(actions[0], kAXParentAttribute as String) as! AXUIElement?,
          let siblings = attribute(parent, kAXChildrenAttribute as String) as? [AXUIElement],
          let first = siblings.first else { return nil }
    let headerTitles = descendants(first, limit: 100).filter {
        string($0, kAXRoleAttribute as String) == "AXButton"
    }.map { string($0, kAXTitleAttribute as String) }.filter { !$0.isEmpty }
    return headerTitles.count == 1 && webTitles[0] == headerTitles[0] ? webTitles[0] : nil
}

private func idleSeconds() -> Double? {
    let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOHIDSystem"))
    guard service != 0 else { return nil }
    defer { IOObjectRelease(service) }
    let key = CFStringCreateWithCString(nil, "HIDIdleTime", CFStringBuiltInEncodings.UTF8.rawValue)!
    guard let value = IORegistryEntryCreateCFProperty(service, key, kCFAllocatorDefault, 0)?
        .takeRetainedValue() as? NSNumber else { return nil }
    return Double(value.uint64Value) / 1_000_000_000
}

private func observe(_ settings: Settings) -> Observation? {
    guard AXIsProcessTrusted(),
          let app = NSWorkspace.shared.frontmostApplication,
          app.bundleIdentifier == "com.openai.codex",
          let idle = idleSeconds(), idle <= settings.idleLimit,
          let title = focusedTitle(app),
          let taskId = settings.titleOwners[title],
          NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier else {
        return nil
    }
    return Observation(taskId: taskId, at: Date().timeIntervalSince1970)
}

private func writeLedger(_ settings: Settings, status: String,
                         span: (taskId: String, start: TimeInterval, end: TimeInterval)?,
                         sessionKey: inout String?) throws {
    let path = settings.ledgerPath
    let lockPath = (path as NSString).deletingPathExtension + ".human.lock"
    let lock = open(lockPath, O_RDWR | O_CREAT, S_IRUSR | S_IWUSR)
    guard lock >= 0 else { throw NSError(domain: "ForegroundSampler", code: 4) }
    defer { flock(lock, LOCK_UN); close(lock) }
    guard flock(lock, LOCK_EX) == 0 else { throw NSError(domain: "ForegroundSampler", code: 5) }
    let original = try Data(contentsOf: URL(fileURLWithPath: path))
    guard var ledger = try JSONSerialization.jsonObject(with: original) as? [String: Any],
          ledger["human"] is [String: Any] else {
        throw NSError(domain: "ForegroundSampler", code: 6)
    }
    if ledger["foregroundHuman"] != nil && !(ledger["foregroundHuman"] is [String: Any]) {
        throw NSError(domain: "ForegroundSampler", code: 9)
    }
    var intervals = ledger["foregroundHuman"] as? [String: Any] ?? [:]
    if let span, span.end > span.start {
        let key: String
        if let existing = sessionKey,
           let entry = intervals[existing] as? [Any], entry.count == 3,
           entry[0] as? String == span.taskId,
           let start = entry[1] as? Double, start <= span.start {
            key = existing
            intervals[key] = [span.taskId, start, span.end]
        } else {
            key = span.taskId + "/" + String(format: "%.3f", span.start)
            intervals[key] = [span.taskId, span.start, span.end]
        }
        sessionKey = key
    }
    ledger["foregroundHuman"] = intervals
    ledger["foregroundStatus"] = status
    ledger["foregroundLastCheck"] = Date().timeIntervalSince1970
    let backup = (path as NSString).deletingLastPathComponent + "/ledger.before-foreground-enable.json"
    if !FileManager.default.fileExists(atPath: backup) {
        try original.write(to: URL(fileURLWithPath: backup), options: .atomic)
        chmod(backup, S_IRUSR | S_IWUSR)
    }
    let temporary = path + ".foreground-" + UUID().uuidString
    let data = try JSONSerialization.data(withJSONObject: ledger, options: [.sortedKeys])
    try data.write(to: URL(fileURLWithPath: temporary), options: .atomic)
    chmod(temporary, S_IRUSR | S_IWUSR)
    guard rename(temporary, path) == 0 else {
        try? FileManager.default.removeItem(atPath: temporary)
        throw NSError(domain: "ForegroundSampler", code: 7)
    }
}

private func run(configPath: String) throws {
    var previous: Observation?
    var sessionKey: String?
    var lastStatus = ""
    var lastStatusWrite: TimeInterval = 0
    while true {
        let settings = try settings(at: configPath)
        let status = !AXIsProcessTrusted() ? "permission_required"
            : settings.titleOwners.isEmpty ? "mapping_empty" : "observing"
        let current = status == "observing" ? observe(settings) : nil
        var span: (taskId: String, start: TimeInterval, end: TimeInterval)?
        if let previous, let current, previous.taskId == current.taskId,
           current.at > previous.at, current.at - previous.at <= 10 {
            let start = max(previous.at, settings.humanSince)
            if current.at > start { span = (current.taskId, start, current.at) }
        } else {
            sessionKey = nil
        }
        let now = Date().timeIntervalSince1970
        if span != nil || status != lastStatus || now - lastStatusWrite >= 60 {
            try writeLedger(settings, status: status, span: span, sessionKey: &sessionKey)
            lastStatus = status
            lastStatusWrite = now
        }
        previous = current
        Thread.sleep(forTimeInterval: 5)
    }
}

private func selfTest() throws {
    let directory = (NSTemporaryDirectory() as NSString).appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(atPath: directory) }
    let ledgerPath = (directory as NSString).appendingPathComponent("ledger.json")
    try Data("{\"human\":{\"old\":[\"task\",1,2]}}".utf8)
        .write(to: URL(fileURLWithPath: ledgerPath))
    let config = Settings(ledgerPath: ledgerPath, humanSince: 0,
                          idleLimit: 60, titleOwners: [:])
    var key: String?
    try writeLedger(config, status: "observing", span: ("task", 100, 105), sessionKey: &key)
    try writeLedger(config, status: "observing", span: ("task", 105, 110), sessionKey: &key)
    let ledger = try object(at: ledgerPath)
    let foreground = ledger["foregroundHuman"] as? [String: [Any]]
    guard ledger["human"] is [String: Any], foreground?.count == 1,
          let entry = foreground?[key ?? ""], entry.count == 3,
          entry[0] as? String == "task", entry[1] as? Double == 100,
          entry[2] as? Double == 110 else {
        throw NSError(domain: "ForegroundSampler", code: 10)
    }
    print("selfTest=ok")
}

private func main() throws {
    let args = CommandLine.arguments
    if args.count == 2, args[1] == "--self-test" {
        try selfTest()
        return
    }
    guard args.count == 3, ["--check", "--run", "--request-access"].contains(args[1]) else {
        throw NSError(domain: "ForegroundSampler", code: 8)
    }
    if args[1] == "--request-access" {
        let option = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        let trusted = AXIsProcessTrustedWithOptions([option: true] as CFDictionary)
        print("accessibilityTrusted=\(trusted)")
        return
    }
    let config = try settings(at: args[2])
    if args[1] == "--check" {
        let sample = observe(config)
        let payload: [String: Any] = ["accessibilityTrusted": AXIsProcessTrusted(),
                                      "frontmostCodex": NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.openai.codex",
                                      "bindingCount": config.titleOwners.count,
                                      "matchedTaskId": sample?.taskId ?? NSNull(),
                                      "idleSeconds": idleSeconds() ?? NSNull()]
        let data = try JSONSerialization.data(withJSONObject: payload)
        print(String(data: data, encoding: .utf8)!)
    } else {
        try run(configPath: args[2])
    }
}

do { try main() } catch {
    fputs("Foreground sampler failed (\(error._code)).\n", stderr)
    exit(1)
}
