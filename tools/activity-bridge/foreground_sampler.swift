// macOS foreground sampling. Legacy estimate mode and separate opt-in activity facts mode.
// Compile as a stable .app bundle so macOS can grant this executable Accessibility.
import AppKit
import ApplicationServices
import Foundation
import IOKit
import Darwin
import SQLite3

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
    // Current desktop versions expose the active title as a static label inside
    // the chat toolbar. Read only that label, never conversation text.
    let toolbars = elements.filter {
        string($0, kAXRoleAttribute as String) == "AXToolbar"
            && ["聊天工具栏", "Chat toolbar"].contains(string($0, kAXTitleAttribute as String))
    }
    if toolbars.count == 1, webTitles.count == 1 {
        let headers = descendants(toolbars[0], limit: 100)
        let labels = headers.filter { string($0, kAXRoleAttribute as String) == "AXStaticText" }
            .map { string($0, kAXValueAttribute as String) }.filter { !$0.isEmpty }
        let hasActions = headers.contains {
            string($0, kAXRoleAttribute as String) == "AXPopUpButton"
                && ["聊天操作", "Chat actions"].contains(string($0, kAXTitleAttribute as String))
        }
        if hasActions, labels.count == 1, labels[0] == webTitles[0],
           !["ChatGPT", "新聊天", "New chat"].contains(labels[0]) { return labels[0] }
    }
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

private func threadIdentity(_ title: String, databases: [String]) -> (String?, String) {
    var ids = Set<String>()
    var failed = databases.isEmpty
    for path in databases {
        var db: OpaquePointer?
        guard sqlite3_open_v2(path, &db, SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX, nil) == SQLITE_OK else {
            if let db { sqlite3_close(db) }
            failed = true
            continue
        }
        defer { sqlite3_close(db) }
        sqlite3_busy_timeout(db, 200)
        var statement: OpaquePointer?
        // name is the displayed rename; title can contain the original prompt.
        let sql = "SELECT id FROM threads WHERE COALESCE(NULLIF(name, ''), title) = ?"
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else {
            failed = true
            continue
        }
        defer { sqlite3_finalize(statement) }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        sqlite3_bind_text(statement, 1, title, -1, transient)
        var step = sqlite3_step(statement)
        while step == SQLITE_ROW {
            if let bytes = sqlite3_column_text(statement, 0),
               let id = UUID(uuidString: String(cString: bytes)) {
                ids.insert(id.uuidString.lowercased())
            } else { failed = true }
            step = sqlite3_step(statement)
        }
        if step != SQLITE_DONE { failed = true }
    }
    guard !failed else { return (nil, "index_unavailable") }
    return ids.count == 1 ? (ids.first, "unique_display_title")
        : (nil, ids.isEmpty ? "not_found" : "ambiguous_title")
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
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 5))
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
    guard safeDocument("https://user:secret@example.com/docs/a?q=secret#token") == "https://example.com/docs/a",
          safeDocument("javascript:alert(1)") == nil else {
        throw NSError(domain: "ActivityFacts", code: 26)
    }
    let database = directory + "/threads.sqlite"
    var db: OpaquePointer?
    guard sqlite3_open(database, &db) == SQLITE_OK else {
        throw NSError(domain: "SessionFacts", code: 30)
    }
    let sql = """
    CREATE TABLE threads(id TEXT, title TEXT, name TEXT);
    INSERT INTO threads VALUES('01a0d1d2-6c22-7111-8a96-8cc1db996e62', 'original', 'display');
    INSERT INTO threads VALUES('01a11f52-9fc1-7313-a82a-953bea14a268', 'same', NULL);
    INSERT INTO threads VALUES('01a11f52-9fc1-7313-a82a-953bea14a269', 'same', NULL);
    """
    let code = sqlite3_exec(db, sql, nil, nil, nil)
    sqlite3_close(db)
    guard code == SQLITE_OK,
          threadIdentity("display", databases: [database]).0 == "01a0d1d2-6c22-7111-8a96-8cc1db996e62",
          threadIdentity("original", databases: [database]).0 == nil,
          threadIdentity("same", databases: [database]).1 == "ambiguous_title",
          threadIdentity("display", databases: [database, directory + "/missing"]).0 == nil else {
        throw NSError(domain: "SessionFacts", code: 31)
    }
    print("selfTest=ok")
}


// Facts deliberately contain no task assignment. The reducer owns attribution.
// Only the focused window is read. The sole AX value read is the toolbar title;
// never record conversation text, input values or key events.
private func rawWindow(_ app: NSRunningApplication) -> AXUIElement? {
    let root = AXUIElementCreateApplication(app.processIdentifier)
    return attribute(root, kAXFocusedWindowAttribute as String) as! AXUIElement?
}

private func safeDocument(_ raw: String) -> String? {
    guard var url = URLComponents(string: raw),
          ["http", "https", "file"].contains(url.scheme ?? "") else { return nil }
    url.query = nil
    url.fragment = nil
    url.user = nil
    url.password = nil
    return url.string
}

private func facts(_ config: [String: Any], session: String) -> [String: Any] {
    let now = Date().timeIntervalSince1970
    let sessionInfo = CGSessionCopyCurrentDictionary() as? [String: Any] ?? [:]
    let locked = (sessionInfo["CGSSessionScreenIsLocked"] as? Bool ?? false)
        || (sessionInfo[kCGSessionOnConsoleKey as String] as? Bool == false)
    let trusted = AXIsProcessTrusted()
    var result: [String: Any] = [
        "schemaVersion": 1, "at": now, "session": session,
        "accessibilityTrusted": trusted, "locked": locked,
        "idleSeconds": idleSeconds() as Any? ?? NSNull()
    ]
    guard !locked, let app = NSWorkspace.shared.frontmostApplication else {
        result["state"] = locked ? "locked" : "unavailable"
        return result
    }
    let bundle = app.bundleIdentifier ?? ""
    result["app"] = bundle
    result["appName"] = app.localizedName ?? ""
    let excluded = config["excludedApps"] as? [String] ?? []
    if excluded.contains(bundle) {
        result["state"] = "private"
        return result
    }
    if trusted, let window = rawWindow(app) {
        let title = string(window, kAXTitleAttribute as String)
        let privateMarkers = ["incognito", "inprivate", "private browsing", "无痕", "隐私浏览"]
        if privateMarkers.contains(where: { title.lowercased().contains($0) }) {
            result["state"] = "private"
            return result
        }
        result["windowTitle"] = String(title.prefix(500))
        // Codex needs main-pane verification: window titles/sidebar labels alone are ambiguous.
        if bundle == "com.openai.codex", let title = focusedTitle(app) {
            result["contextKind"] = "codexThreadTitle"
            result["context"] = title
            if let databases = config["threadDatabases"] as? [String] {
                let (id, evidence) = threadIdentity(title, databases: databases)
                result["threadIdentityEvidence"] = evidence
                if let id { result["threadId"] = id }
            }
            // Reject navigation during the potentially slower metadata lookup.
            guard focusedTitle(app) == title, let current = rawWindow(app), CFEqual(current, window) else {
                return ["schemaVersion": 1, "at": now, "session": session, "state": "transition"]
            }
        }
        if let document = safeDocument(string(window, kAXDocumentAttribute as String)) {
            result["document"] = document
        }
    }
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier else {
        return ["schemaVersion": 1, "at": now, "session": session, "state": "transition"]
    }
    result["state"] = trusted ? "observed" : "permission_required"
    return result
}

private func savePrivateJSON(_ value: [String: Any], path: String) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    let tmp = path + ".tmp-" + UUID().uuidString
    guard FileManager.default.createFile(atPath: tmp, contents: data,
        attributes: [.posixPermissions: 0o600]) else {
        throw NSError(domain: "ActivityFacts", code: 21)
    }
    guard rename(tmp, path) == 0 else {
        try? FileManager.default.removeItem(atPath: tmp)
        throw NSError(domain: "ActivityFacts", code: 22)
    }
}

private func runFacts(configPath: String) throws {
    let config = try object(at: configPath)
    guard let root = config["factsDir"] as? String else {
        throw NSError(domain: "ActivityFacts", code: 20)
    }
    try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700])
    chmod(root, 0o700)
    let lock = open(root + "/sampler.lock", O_RDWR | O_CREAT, S_IRUSR | S_IWUSR)
    guard lock >= 0, flock(lock, LOCK_EX | LOCK_NB) == 0 else {
        throw NSError(domain: "ActivityFacts", code: 23)
    }
    defer { flock(lock, LOCK_UN); close(lock) }
    let session = UUID().uuidString
    let formatter = DateFormatter()
    formatter.timeZone = TimeZone(identifier: config["timezone"] as? String ?? "Asia/Shanghai")
    formatter.dateFormat = "yyyy-MM-dd"
    while true {
        // A pause file makes capture stoppable without touching permissions or task data.
        let paused = FileManager.default.fileExists(atPath: root + "/PAUSED")
        let sample: [String: Any] = paused
            ? ["schemaVersion": 1, "at": Date().timeIntervalSince1970,
               "session": session, "state": "paused"]
            : facts(config, session: session)
        var line = try JSONSerialization.data(withJSONObject: sample, options: [.sortedKeys])
        line.append(0x0A)
        let path = root + "/" + formatter.string(from: Date()) + ".jsonl"
        let fd = open(path, O_WRONLY | O_CREAT | O_APPEND, S_IRUSR | S_IWUSR)
        guard fd >= 0 else { throw NSError(domain: "ActivityFacts", code: 24) }
        let written = line.withUnsafeBytes { bytes in
            write(fd, bytes.baseAddress!, bytes.count)
        }
        close(fd)
        guard written == line.count else { throw NSError(domain: "ActivityFacts", code: 25) }
        try savePrivateJSON([
            "checkedAt": sample["at"]!, "state": sample["state"]!,
            "accessibilityTrusted": sample["accessibilityTrusted"] ?? false,
            "pid": ProcessInfo.processInfo.processIdentifier, "schemaVersion": 1
        ], path: root + "/status.json")
        // NSWorkspace foreground changes arrive on the run loop. Blocking sleep
        // can otherwise keep reporting the app that was active at startup.
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 5))
    }
}

private func main() throws {
    let args = CommandLine.arguments
    if args.count == 3, args[1] == "--check-session" {
        let config = try object(at: args[2])
        let app = NSRunningApplication.runningApplications(withBundleIdentifier: "com.openai.codex").first
        var result: [String: Any] = ["accessibilityTrusted": AXIsProcessTrusted(),
            "frontmostCodex": NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.openai.codex"]
        if let app, let title = focusedTitle(app) {
            let (id, evidence) = threadIdentity(title, databases: config["threadDatabases"] as? [String] ?? [])
            result["title"] = title
            result["threadId"] = id as Any? ?? NSNull()
            result["evidence"] = evidence
        }
        let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
        print(String(data: data, encoding: .utf8)!)
        return
    }
    if args.count == 3, args[1] == "--sample" {
        let data = try JSONSerialization.data(withJSONObject: facts(try object(at: args[2]), session: "probe"), options: [.sortedKeys])
        print(String(data: data, encoding: .utf8)!)
        return
    }
    if args.count == 3, args[1] == "--facts" {
        try runFacts(configPath: args[2])
        return
    }
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
