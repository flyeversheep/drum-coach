import SwiftUI
import WebKit

/// Where the bundled page lives. A private scheme (instead of file://) gives the page one stable
/// origin, so its saved scores, settings and backing tracks stay put, and lets it use the microphone.
enum AppPage {
    static let scheme = "drumcoach"
    static let start = URL(string: "drumcoach://app/index.html")!
    /// Export links point at the public web page, so they open on any device.
    static let webAddress = "https://flyeversheep.github.io/drum-coach/"
}

struct WebView: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(BundleSchemeHandler(), forURLScheme: AppPage.scheme)
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.userContentController.addUserScript(WKUserScript(
            source: "window.DC_NATIVE = true; window.DC_LINK_BASE = '\(AppPage.webAddress)';",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.uiDelegate = context.coordinator
        webView.navigationDelegate = context.coordinator
        webView.isOpaque = false
        webView.backgroundColor = UIColor(named: "PageBackground")
        webView.scrollView.backgroundColor = UIColor(named: "PageBackground")
        #if DEBUG
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        #endif
        webView.load(URLRequest(url: AppPage.start))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKUIDelegate, WKNavigationDelegate {
        /// iOS has already asked for the microphone on behalf of the app; do not ask a second time for the page.
        func webView(
            _ webView: WKWebView,
            requestMediaCapturePermissionFor origin: WKSecurityOrigin,
            initiatedByFrame frame: WKFrameInfo,
            type: WKMediaCaptureType,
            decisionHandler: @escaping (WKPermissionDecision) -> Void
        ) {
            decisionHandler(origin.protocol == AppPage.scheme && type == .microphone ? .grant : .deny)
        }

        /// The web view only ever shows the bundled page; any outside link opens in Safari.
        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard let url = navigationAction.request.url, let scheme = url.scheme?.lowercased() else {
                decisionHandler(.cancel)
                return
            }
            if scheme == AppPage.scheme || scheme == "about" || scheme == "blob" {
                decisionHandler(.allow)
                return
            }
            if navigationAction.navigationType == .linkActivated, scheme == "https" || scheme == "http" {
                UIApplication.shared.open(url)
            }
            decisionHandler(.cancel)
        }

        #if DEBUG
        /// Launching with -smokeTest prints what the page can do, so an automated build can check that
        /// the bundled page really loaded and is allowed to use the microphone and its storage.
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            guard ProcessInfo.processInfo.arguments.contains("-smokeTest") else { return }
            let probe = """
            JSON.stringify({
              secure: window.isSecureContext,
              mic: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
              scores: document.querySelectorAll('#scoreSel option').length,
              staff: !!document.querySelector('#score svg, #score canvas'),
              storage: (function () { try { localStorage.setItem('dc:probe', '1'); return localStorage.getItem('dc:probe') === '1'; } catch (e) { return false; } })(),
              db: !!window.indexedDB,
              worklet: !!window.AudioWorkletNode,
              version: document.getElementById('appVersion').textContent.trim()
            })
            """
            webView.evaluateJavaScript(probe) { result, error in
                print("SMOKE \(result ?? "error: \(String(describing: error))")")
                fflush(stdout)
            }
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            print("SMOKE load failed: \(error)")
            fflush(stdout)
        }
        #endif

        /// iOS may stop the page's process when memory is short; bring the page back instead of leaving a blank screen.
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            webView.load(URLRequest(url: AppPage.start))
        }
    }
}

/// Serves the page's own files (index.html, style.css, js/*.js) out of the app bundle.
final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    private static let types = ["html": "text/html", "css": "text/css", "js": "text/javascript"]

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url,
              let file = Self.bundledFile(for: url),
              let data = try? Data(contentsOf: file),
              let response = HTTPURLResponse(
                url: url,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: [
                    "Content-Type": (Self.types[file.pathExtension] ?? "application/octet-stream") + "; charset=utf-8",
                    "Content-Length": String(data.count),
                    "Cache-Control": "no-cache",
                ]
              )
        else {
            task.didFailWithError(URLError(.fileDoesNotExist))
            return
        }
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    /// Only the page's known files are served, so an address can never reach anything else in the bundle.
    static func bundledFile(for url: URL) -> URL? {
        var path = url.path
        while path.hasPrefix("/") { path.removeFirst() }
        if path.isEmpty { path = "index.html" }
        let isScript = path.range(of: "^js/[A-Za-z0-9_-]+\\.js$", options: .regularExpression) != nil
        guard path == "index.html" || path == "style.css" || isScript else { return nil }
        return Bundle.main.resourceURL?.appendingPathComponent(path)
    }
}
