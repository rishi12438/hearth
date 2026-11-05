// Hearth for Mac: open the app and the setup appears. It's a window around Hearth's own pages:
//
//   first run      runs the bundled `hearth wizard` (Bun + Hearth's files inside the app) and shows it:
//                  pick your brains, then this Mac or your server, then pair your phone.
//   after setup    opens your hub (this Mac's at http://127.0.0.1:<port>, or your server's https://<domain>).
//
// Everything real happens in Hearth's TypeScript (src/setup/*); this file only starts it and shows it.

import Cocoa
import WebKit
import UserNotifications
import ServiceManagement

let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Hearth")
let resources = Bundle.main.resourceURL!
let bun = resources.appendingPathComponent("bun").path
let src = resources.appendingPathComponent("hearth-src").path
let hubFile = appSupport.appendingPathComponent("app-hub.txt") // the hub this app opens after setup
let wizardLog = appSupport.appendingPathComponent("wizard.log") // the setup process's output, for when it goes wrong
// This Mac's link to the hub as a computer (so teammates can use its browser logins and run work here): made by itself.
let computerDir = appSupport.appendingPathComponent("computer")
let computerLink = computerDir.appendingPathComponent("computer.json") // what `hearth computer` reads (src/computer.ts)
let computerLog = appSupport.appendingPathComponent("computer.log")

/// The PATH your Terminal has, so Hearth finds Claude Code and Codex (apps start with a bare PATH).
func loginPath() -> String {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh")
    p.arguments = ["-lic", "printf %s \"$PATH\""]
    let out = Pipe(); p.standardOutput = out; p.standardError = Pipe()
    try? p.run(); p.waitUntilExit()
    let found = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    let home = NSHomeDirectory()
    let extra = ["\(home)/.local/bin", "\(home)/.bun/bin", "\(home)/.npm-global/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
    return (found.split(separator: ":").map(String.init) + extra).reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }.joined(separator: ":")
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKDownloadDelegate, UNUserNotificationCenterDelegate, NSWindowDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var wizard: Process?
    var computer: Process?
    var statusItem: NSStatusItem?
    var downloading: [ObjectIdentifier: (url: URL, asked: String)] = [:] // downloads in flight: where each is going
    var downloaded: Set<String> = [] // files this app saved, the only ones the page may show in Finder or open
    let path = loginPath()

    func applicationDidFinishLaunching(_ note: Notification) {
        try? FileManager.default.createDirectory(at: appSupport, withIntermediateDirectories: true)
        buildMenu()
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default() // keeps this Mac paired with the hub between launches
        config.applicationNameForUserAgent = "HearthMac" // lets Hearth's pages offer "Set up a new hub"
        config.userContentController.add(self, name: "hearth") // the hub page tells the app: "ready", "notify", "chrome-…"
        // Tells the page this app saves Download clicks into ~/Downloads and reports back (older apps silently dropped them).
        config.userContentController.addUserScript(WKUserScript(source: "window.hearthSavesFiles = true", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 860), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Hearth"
        window.center()
        window.setFrameAutosaveName("HearthMain")
        window.contentView = web
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.makeKeyAndOrderFront(nil)
        UNUserNotificationCenter.current().delegate = self
        buildStatusItem()
        NSApp.activate(ignoringOtherApps: true)
        if let hub = try? String(contentsOf: hubFile, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines), let url = URL(string: hub), !hub.isEmpty {
            web.load(URLRequest(url: url))
            startComputer() // already linked: keep the line up from launch; the page links it if it isn't yet
        } else {
            startWizard()
        }
    }

    // ---------- this Mac as a computer for the hub ----------

    /// The saved link, if it's for the hub this app opens.
    func savedLink() -> [String: Any]? {
        guard let data = try? Data(contentsOf: computerLink), let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let hub = j["hub"] as? String, let saved = try? String(contentsOf: hubFile, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
              let a = URL(string: hub), let b = URL(string: saved), a.host == b.host, a.scheme == b.scheme, a.port == b.port else { return nil }
        return j
    }

    /// Run `hearth computer` in the background while the app is open. Exit 0 means the hub signed it out: forget the
    /// link so the next launch links again. Any other stop: start it again shortly.
    func startComputer() {
        guard computer == nil, savedLink() != nil else { return }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: bun)
        p.arguments = ["\(src)/src/cli.ts", "computer"]
        p.currentDirectoryURL = URL(fileURLWithPath: src)
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = path; env["HEARTH_APP"] = "1"; env["HEARTH_DATA"] = computerDir.path
        p.environment = env
        if !FileManager.default.fileExists(atPath: computerLog.path) { FileManager.default.createFile(atPath: computerLog.path, contents: nil) }
        if let log = try? FileHandle(forWritingTo: computerLog) { log.seekToEndOfFile(); p.standardOutput = log; p.standardError = log }
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                guard let self, self.computer === proc else { return }
                self.computer = nil
                if proc.terminationStatus == 0 && proc.terminationReason == .exit { try? FileManager.default.removeItem(at: computerLink); return }
                DispatchQueue.main.asyncAfter(deadline: .now() + 5) { self.startComputer() }
            }
        }
        do { try p.run(); computer = p } catch {}
    }

    func stopComputer() { let old = computer; computer = nil; old?.terminate() }

    /// The page hands over a fresh link from the hub (POST /api/devices/link-self): save it (only you can read it), restart.
    func saveLink(_ link: [String: Any]) -> Bool {
        guard let hub = link["hub"] as? String, let url = URL(string: hub), isHubPage(url),
              let token = link["token"] as? String, token.count >= 20, let deviceId = link["deviceId"] as? String,
              let name = link["name"] as? String else { return false }
        try? FileManager.default.createDirectory(at: computerDir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        guard let data = try? JSONSerialization.data(withJSONObject: ["hub": hub, "token": token, "deviceId": deviceId, "name": name], options: [.prettyPrinted]) else { return false }
        FileManager.default.createFile(atPath: computerLink.path, contents: data, attributes: [.posixPermissions: 0o600])
        stopComputer()
        startComputer()
        return true
    }

    /// Run `hearth wizard` and open the address it prints.
    @objc func startWizard() { startWizard(fresh: false) }

    func startWizard(fresh: Bool) {
        let old = wizard; wizard = nil; old?.terminate() // cleared first, so its exit isn't taken for a crash
        showMessage("Starting setup…")
        let p = Process()
        p.executableURL = URL(fileURLWithPath: bun)
        p.arguments = ["\(src)/src/cli.ts", "wizard", "--no-open"] + (fresh ? ["--fresh"] : [])
        p.currentDirectoryURL = appSupport
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = path
        env["HEARTH_APP"] = "1"
        env["HEARTH_SRC"] = src
        env["HEARTH_DATA"] = appSupport.appendingPathComponent("wizard").path
        p.environment = env
        let out = Pipe()
        p.standardOutput = out
        p.standardError = out
        // Keep reading its output for as long as it runs (a full pipe would freeze it), into a log for when things go wrong.
        if !FileManager.default.fileExists(atPath: wizardLog.path) { FileManager.default.createFile(atPath: wizardLog.path, contents: nil) }
        let log = try? FileHandle(forWritingTo: wizardLog); log?.seekToEndOfFile()
        log?.write("\n[Hearth] setup started at \(Date())\n".data(using: .utf8)!)
        var buffer = "", opened = false
        out.fileHandleForReading.readabilityHandler = { [weak self] h in
            let data = h.availableData
            if data.isEmpty { h.readabilityHandler = nil; try? log?.close(); return }
            log?.write(data)
            guard !opened, let chunk = String(data: data, encoding: .utf8) else { return }
            buffer += chunk
            if let line = buffer.split(separator: "\n").first(where: { $0.hasPrefix("WIZARD ") }), let url = URL(string: String(line.dropFirst(7))) {
                opened = true; buffer = ""
                DispatchQueue.main.async { self?.web.load(URLRequest(url: url)) }
            }
        }
        // If it stops on its own, start it again: your answers come back from the saved draft, and a server that was
        // mid-setup carries on by itself and is picked back up when you press Set up.
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                guard let self, self.wizard === proc else { return }
                self.wizard = nil
                let note = "\n[Hearth] setup stopped (status \(proc.terminationStatus), reason \(proc.terminationReason == .uncaughtSignal ? "signal" : "exit")) at \(Date())\n"
                if let h = try? FileHandle(forWritingTo: wizardLog) { h.seekToEndOfFile(); h.write(note.data(using: .utf8)!); try? h.close() }
                self.showMessage("Setup stopped unexpectedly. Restarting it…")
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { if self.wizard == nil { self.startWizard() } }
            }
        }
        do { try p.run(); wizard = p } catch { showMessage("Couldn't start setup: \(error.localizedDescription)") }
    }

    func showMessage(_ text: String) {
        let safe = text.replacingOccurrences(of: "<", with: "&lt;")
        web.loadHTMLString("<body style=\"font:15px -apple-system;color:#8c8781;display:grid;place-items:center;height:90vh;background:#fbfaf8\">\(safe)</body>", baseURL: nil)
    }

    /// Leaving the wizard for a hub (the "Open Hearth" button): remember it, so the next launch opens it directly.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // A Download button (<a download>): save it like a browser would, into Downloads.
        if action.shouldPerformDownload { return decisionHandler(.download) }
        guard let url = action.request.url else { return decisionHandler(.allow) }
        // "Set up a new hub" (Settings → Hubs): run setup again. The hub you're on stays as it is.
        if url.scheme == "hearth-app" { if url.host == "new-hub" { rerun() }; return decisionHandler(.cancel) }
        let isWizard = url.host == "127.0.0.1" && url.query?.contains("k=") == true
        if !isWizard, url.scheme == "http" || url.scheme == "https", let host = url.host, host != "", action.targetFrame?.isMainFrame == true {
            let isHub = (host == "127.0.0.1" || host == "localhost") ? url.port != nil : true
            // Links out of the hub (docs, Google Cloud, serper.dev…) open in your browser.
            if let current = webView.url, current.host != host, !(current.host == "127.0.0.1" && current.query?.contains("k=") == true) {
                NSWorkspace.shared.open(url); return decisionHandler(.cancel)
            }
            if isHub, var c = URLComponents(url: url, resolvingAgainstBaseURL: false) {
                c.fragment = nil; c.path = "/"; c.query = nil
                if let base = c.string { try? base.write(to: hubFile, atomically: true, encoding: .utf8) }
                let old = wizard; wizard = nil; old?.terminate()
            }
        }
        decisionHandler(.allow)
    }

    /// A file the page can't show (sent as an attachment): download it too.
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(response.canShowMIMEType ? .allow : .download)
    }

    // ---------- downloads: straight into ~/Downloads, like Slack, then the page says where it went ----------

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let url = freeDownloadURL(suggestedFilename)
        downloading[ObjectIdentifier(download)] = (url, suggestedFilename)
        completionHandler(url)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let d = downloading.removeValue(forKey: ObjectIdentifier(download)) else { return }
        // Marked as downloaded from the internet, so macOS checks it before anything in it can run.
        var url = d.url, rv = URLResourceValues()
        rv.quarantineProperties = [kLSQuarantineAgentNameKey as String: "Hearth", kLSQuarantineTypeKey as String: kLSQuarantineTypeWebDownload as String]
        try? url.setResourceValues(rv)
        downloaded.insert(d.url.path)
        // The Downloads stack in the Dock bounces, as it does for Safari.
        DistributedNotificationCenter.default().post(name: .init("com.apple.DownloadFileFinished"), object: d.url.path)
        tellPage(["asked": d.asked, "name": d.url.lastPathComponent, "path": d.url.path,
                  "where": d.url.deletingLastPathComponent().path.replacingOccurrences(of: NSHomeDirectory(), with: "~")])
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let d = downloading.removeValue(forKey: ObjectIdentifier(download))
        tellPage(["asked": d?.asked ?? "", "error": "Couldn't save \(d?.asked ?? "the file"): \(error.localizedDescription)"])
    }

    /// ~/Downloads/<name>, or "<name> (2)" and on if that's taken. The name loses anything that could point elsewhere.
    func freeDownloadURL(_ suggested: String) -> URL {
        let dir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
        var name = (suggested as NSString).lastPathComponent.replacingOccurrences(of: ":", with: "-").trimmingCharacters(in: .whitespaces)
        while name.hasPrefix(".") { name.removeFirst() }
        if name.isEmpty { name = "download" }
        let base = (name as NSString).deletingPathExtension, ext = (name as NSString).pathExtension
        var url = dir.appendingPathComponent(name), n = 2
        while FileManager.default.fileExists(atPath: url.path) {
            url = dir.appendingPathComponent(ext.isEmpty ? "\(base) (\(n))" : "\(base) (\(n)).\(ext)"); n += 1
        }
        return url
    }

    /// window.hearthDownloaded({asked, name, path, where} or {asked, error}).
    func tellPage(_ info: [String: String]) {
        guard let data = try? JSONSerialization.data(withJSONObject: info), let json = String(data: data, encoding: .utf8) else { return }
        web.evaluateJavaScript("window.hearthDownloaded && window.hearthDownloaded(\(json))", completionHandler: nil)
    }

    /// <input type="file"> (the SSH key in setup): the usual Open panel. Picking a file this way is what lets the app
    /// read it, so macOS doesn't ask for access to the folder it's in. Starts in ~/.ssh, hidden files shown.
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.showsHiddenFiles = true
        let ssh = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".ssh")
        if FileManager.default.fileExists(atPath: ssh.path) { panel.directoryURL = ssh }
        panel.beginSheetModal(for: window) { r in completionHandler(r == .OK ? panel.urls : nil) }
    }

    /// target=_blank links open in the browser.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    // ---------- notifications, the menu bar, open at login ----------

    /// Messages from the hub page: "ready" once signed in (ask for notifications then), "notify" for each one.
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let m = message.body as? [String: Any], let type = m["type"] as? String else { return }
        switch type {
        case "ready": firstRunAsks()
        case "notify":
            let c = UNMutableNotificationContent()
            c.title = (m["title"] as? String) ?? "Hearth"
            c.body = (m["body"] as? String) ?? ""
            c.sound = .default
            c.userInfo = ["url": (m["url"] as? String) ?? "/"]
            let tag = (m["tag"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? UUID().uuidString
            UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: tag, content: c, trigger: nil))
        case "notif-status":
            // Whether macOS will actually show Hearth's notifications: allowed at all, as banners or alerts, in the list.
            guard let id = m["id"] as? String else { return }
            notifStatus { [weak self] json in self?.reply(id, json) }
        case "notif-settings":
            // Never asked yet: ask now (macOS shows its prompt). Otherwise open Hearth's page in System Settings.
            guard let id = m["id"] as? String else { return }
            UNUserNotificationCenter.current().getNotificationSettings { st in
                DispatchQueue.main.async {
                    if st.authorizationStatus == .notDetermined {
                        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in
                            self.notifStatus { json in self.reply(id, json) }
                        }
                    } else {
                        let pane = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=app.hearth.mac")
                            ?? URL(string: "x-apple.systempreferences:com.apple.preference.notifications")!
                        NSWorkspace.shared.open(pane)
                        self.notifStatus { json in self.reply(id, json) }
                    }
                }
            }
        case "chrome-logins", "chrome-cookies":
            // Only your hub's own page (main frame), never the setup page or anything it links to.
            guard message.frameInfo.isMainFrame, let id = m["id"] as? String, isHubPage(message.frameInfo.request.url ?? web.url) else { return }
            var args = ["chrome", type == "chrome-logins" ? "logins" : "cookies"]
            if type == "chrome-cookies" {
                guard let site = m["site"] as? String, site.range(of: "^[a-z]{1,20}$", options: .regularExpression) != nil,
                      let profile = m["profile"] as? String, profile.range(of: "^(Default|Profile [0-9]{1,4})$", options: .regularExpression) != nil else { return }
                args += [site, profile]
            }
            chrome(args) { [weak self] out in self?.reply(id, out) }
        case "brain-login":
            // Reconnect a brain on the hub with this Mac's login: Claude makes a long-lived token (the browser asks you
            // once); Codex hands over ~/.codex/auth.json. The page sends it to the hub, the same as pasting it.
            guard message.frameInfo.isMainFrame, let id = m["id"] as? String, isHubPage(message.frameInfo.request.url ?? web.url),
                  let brain = m["brain"] as? String, brain == "claude" || brain == "codex" else { return }
            chrome(brain == "claude" ? ["brains", "token", "claude", "--json"] : ["brains", "export", "codex", "--json"]) { [weak self] out in self?.reply(id, out) }
        case "computer-link-status":
            // Every launch the page asks: is this Mac linked to this hub? (It checks the hub still knows it, too.)
            guard message.frameInfo.isMainFrame, let id = m["id"] as? String, isHubPage(message.frameInfo.request.url ?? web.url) else { return }
            let l = savedLink()
            let out: [String: Any] = ["linked": l != nil, "hub": (l?["hub"] as? String) ?? "", "deviceId": (l?["deviceId"] as? String) ?? "",
                                      "running": computer?.isRunning == true, "name": Host.current().localizedName ?? "My Mac"]
            if let d = try? JSONSerialization.data(withJSONObject: out), let s = String(data: d, encoding: .utf8) { reply(id, s) }
        case "computer-link":
            guard message.frameInfo.isMainFrame, let id = m["id"] as? String, isHubPage(message.frameInfo.request.url ?? web.url) else { return }
            let ok = (m["link"] as? [String: Any]).map(saveLink) ?? false
            reply(id, ok ? "{\"ok\":true}" : "{\"error\":\"That link isn't for this hub.\"}")
        case "file-reveal", "file-open":
            // Show in Finder / Open, for a file this app just downloaded (never any other path).
            guard message.frameInfo.isMainFrame, isHubPage(message.frameInfo.request.url ?? web.url),
                  let path = m["path"] as? String, downloaded.contains(path), FileManager.default.fileExists(atPath: path) else { return }
            let url = URL(fileURLWithPath: path)
            // Since macOS 14 an app in front has to hand focus over, or Finder (or the viewer) opens behind this window.
            let target = type == "file-reveal" ? URL(fileURLWithPath: "/System/Library/CoreServices/Finder.app") : NSWorkspace.shared.urlForApplication(toOpen: url)
            let bundleId = target.flatMap { Bundle(url: $0)?.bundleIdentifier }
            if #available(macOS 14.0, *), let bundleId { NSApp.yieldActivation(toApplicationWithBundleIdentifier: bundleId) }
            if type == "file-reveal" { NSWorkspace.shared.activateFileViewerSelecting([url]) }
            else { let c = NSWorkspace.OpenConfiguration(); c.activates = true; NSWorkspace.shared.open(url, configuration: c) }
            // Then bring it forward through Launch Services (the cooperative way; works while Hearth is the app you clicked).
            if type == "file-reveal", let target { let c = NSWorkspace.OpenConfiguration(); c.activates = true; NSWorkspace.shared.openApplication(at: target, configuration: c) }
        default: break
        }
    }

    /// The hub this app opens (saved after setup), or a hub on this Mac.
    func isHubPage(_ url: URL?) -> Bool {
        guard let url, let host = url.host else { return false }
        if let saved = try? String(contentsOf: hubFile, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines), let hub = URL(string: saved) {
            return hub.host == host && hub.scheme == url.scheme && hub.port == url.port
        }
        return false
    }

    /// Read Chrome on this Mac with Hearth's own `hearth chrome …` (src/chrome.ts). It runs here, never on the hub.
    func chrome(_ args: [String], done: @escaping (String) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async { [path] in
            let p = Process()
            p.executableURL = URL(fileURLWithPath: bun)
            p.arguments = ["\(src)/src/cli.ts"] + args
            p.currentDirectoryURL = URL(fileURLWithPath: src)
            var env = ProcessInfo.processInfo.environment
            env["PATH"] = path; env["HEARTH_APP"] = "1"
            p.environment = env
            let out = Pipe(); p.standardOutput = out; p.standardError = FileHandle.nullDevice
            var text = "{\"error\":\"That didn't work on this Mac.\"}"
            do {
                try p.run()
                let data = out.fileHandleForReading.readDataToEndOfFile()
                p.waitUntilExit()
                if let s = String(data: data, encoding: .utf8), s.hasPrefix("{") { text = s }
            } catch {}
            DispatchQueue.main.async { done(text) }
        }
    }

    /// Hand the answer back to the page: window.hearthNative(id, json).
    func reply(_ id: String, _ json: String) {
        guard let data = try? JSONSerialization.data(withJSONObject: [id, json]), let args = String(data: data, encoding: .utf8) else { return }
        web.evaluateJavaScript("window.hearthNative && window.hearthNative(...\(args))", completionHandler: nil)
    }

    /// Once, after this Mac is signed in to a hub: notifications (macOS asks), then "open at login".
    func firstRunAsks() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in
            DispatchQueue.main.async { self.askOpenAtLogin() }
        }
    }

    func askOpenAtLogin() {
        let key = "askedOpenAtLogin"
        guard !UserDefaults.standard.bool(forKey: key) else { return }
        UserDefaults.standard.set(true, forKey: key)
        let a = NSAlert()
        a.messageText = "Open Hearth when you log in?"
        a.informativeText = "Hearth stays in the menu bar so your teammates' notifications reach you even with the window closed."
        if Bundle.main.bundlePath.hasPrefix("/Volumes/") {
            a.informativeText += "\n\nFirst drag Hearth from this disk into your Applications folder, then open it from there; otherwise it can't start at login."
        }
        a.addButton(withTitle: "Open at Login")
        a.addButton(withTitle: "Not Now")
        if a.runModal() == .alertFirstButtonReturn { setOpenAtLogin(true) }
    }

    func setOpenAtLogin(_ on: Bool) {
        if #available(macOS 13.0, *) {
            do { if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() } }
            catch {
                let a = NSAlert(); a.messageText = "Couldn't change Open at Login"
                a.informativeText = Bundle.main.bundlePath.hasPrefix("/Volumes/") ? "Move Hearth to your Applications folder and try again." : error.localizedDescription
                a.runModal()
            }
        }
        buildStatusItem()
    }

    var opensAtLogin: Bool {
        if #available(macOS 13.0, *) { return SMAppService.mainApp.status == .enabled }
        return false
    }

    @objc func toggleOpenAtLogin() { setOpenAtLogin(!opensAtLogin) }

    /// Tapping a notification: bring the window back and open what it's about.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler done: @escaping () -> Void) {
        showWindow()
        if let path = response.notification.request.content.userInfo["url"] as? String, let base = web.url, let url = URL(string: path, relativeTo: base) {
            web.load(URLRequest(url: url))
        }
        done()
    }
    /// What macOS will do with Hearth's notifications, as JSON for the page:
    /// {"auth":"authorized|denied|notDetermined|provisional","alerts":true,"style":"none|banner|alert","center":true,"sound":true}
    func notifStatus(_ done: @escaping (String) -> Void) {
        UNUserNotificationCenter.current().getNotificationSettings { st in
            let auth: String
            switch st.authorizationStatus {
            case .authorized: auth = "authorized"
            case .denied: auth = "denied"
            case .provisional: auth = "provisional"
            case .notDetermined: auth = "notDetermined"
            default: auth = "other"
            }
            let style = st.alertStyle == .banner ? "banner" : st.alertStyle == .alert ? "alert" : "none"
            let out: [String: Any] = ["auth": auth, "alerts": st.alertSetting == .enabled, "style": style,
                                      "center": st.notificationCenterSetting == .enabled, "sound": st.soundSetting == .enabled]
            let json = (try? JSONSerialization.data(withJSONObject: out)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
            DispatchQueue.main.async { done(json) }
        }
    }

    /// Show it even while Hearth is in front.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent n: UNNotification, withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([.banner, .sound])
    }

    /// The menu bar icon: Hearth keeps running there when the window is closed.
    func buildStatusItem() {
        if statusItem == nil {
            statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
            statusItem?.button?.image = NSImage(systemSymbolName: "flame", accessibilityDescription: "Hearth")
        }
        let m = NSMenu()
        m.addItem(withTitle: "Open Hearth", action: #selector(showWindow), keyEquivalent: "")
        let login = NSMenuItem(title: "Open at Login", action: #selector(toggleOpenAtLogin), keyEquivalent: "")
        login.state = opensAtLogin ? .on : .off
        m.addItem(login)
        m.addItem(.separator())
        m.addItem(withTitle: "Quit Hearth", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "")
        statusItem?.menu = m
    }

    @objc func showWindow() { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }

    /// Closing the window hides it; Hearth stays in the menu bar so notifications keep coming. Quit from the menu.
    func windowShouldClose(_ sender: NSWindow) -> Bool { sender.orderOut(nil); return false }
    func applicationShouldHandleReopen(_ app: NSApplication, hasVisibleWindows: Bool) -> Bool { showWindow(); return true }

    /// If the page's process dies (memory pressure, a crash), reload instead of leaving a blank window.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }

    func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let app = NSMenu()
        app.addItem(withTitle: "Run setup again…", action: #selector(rerun), keyEquivalent: "")
        app.addItem(withTitle: "Open at Login", action: #selector(toggleOpenAtLogin), keyEquivalent: "")
        app.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        app.addItem(.separator())
        app.addItem(withTitle: "Quit Hearth", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = app
        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        let viewItem = NSMenuItem(); main.addItem(viewItem)
        let view = NSMenu(title: "View")
        view.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        viewItem.submenu = view
        NSApp.mainMenu = main
    }

    @objc func reload() { web.reload() }
    @objc func rerun() { try? FileManager.default.removeItem(at: hubFile); startWizard(fresh: true) }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { false }
    func applicationWillTerminate(_ note: Notification) { let old = wizard; wizard = nil; old?.terminate(); stopComputer() }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
