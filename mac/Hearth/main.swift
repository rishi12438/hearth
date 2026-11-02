// Hearth for Mac: open the app and the setup appears. It's a window around Hearth's own pages:
//
//   first run      runs the bundled `hearth wizard` (Bun + Hearth's files inside the app) and shows it:
//                  pick your brains, then this Mac or your server, then pair your phone.
//   after setup    opens your hub (this Mac's at http://127.0.0.1:<port>, or your server's https://<domain>).
//
// Everything real happens in Hearth's TypeScript (src/setup/*); this file only starts it and shows it.

import Cocoa
import WebKit

let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Hearth")
let resources = Bundle.main.resourceURL!
let bun = resources.appendingPathComponent("bun").path
let src = resources.appendingPathComponent("hearth-src").path
let hubFile = appSupport.appendingPathComponent("app-hub.txt") // the hub this app opens after setup

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

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var wizard: Process?
    let path = loginPath()

    func applicationDidFinishLaunching(_ note: Notification) {
        try? FileManager.default.createDirectory(at: appSupport, withIntermediateDirectories: true)
        buildMenu()
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default() // keeps this Mac paired with the hub between launches
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 860), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Hearth"
        window.center()
        window.setFrameAutosaveName("HearthMain")
        window.contentView = web
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        if let hub = try? String(contentsOf: hubFile, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines), let url = URL(string: hub), !hub.isEmpty {
            web.load(URLRequest(url: url))
        } else {
            startWizard()
        }
    }

    /// Run `hearth wizard` and open the address it prints.
    @objc func startWizard() {
        wizard?.terminate()
        showMessage("Starting setup…")
        let p = Process()
        p.executableURL = URL(fileURLWithPath: bun)
        p.arguments = ["\(src)/src/cli.ts", "wizard", "--no-open"]
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
        var buffer = ""
        out.fileHandleForReading.readabilityHandler = { [weak self] h in
            guard let chunk = String(data: h.availableData, encoding: .utf8), !chunk.isEmpty else { return }
            buffer += chunk
            if let line = buffer.split(separator: "\n").first(where: { $0.hasPrefix("WIZARD ") }), let url = URL(string: String(line.dropFirst(7))) {
                h.readabilityHandler = nil
                DispatchQueue.main.async { self?.web.load(URLRequest(url: url)) }
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
        guard let url = action.request.url else { return decisionHandler(.allow) }
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
                wizard?.terminate(); wizard = nil
            }
        }
        decisionHandler(.allow)
    }

    /// target=_blank links open in the browser.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let app = NSMenu()
        app.addItem(withTitle: "Run setup again…", action: #selector(rerun), keyEquivalent: "")
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
    @objc func rerun() { try? FileManager.default.removeItem(at: hubFile); startWizard() }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ note: Notification) { wizard?.terminate() }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
