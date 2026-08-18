import Capacitor
import Foundation
import UIKit
import WebKit

/// Presents YouTube on iOS with the API-client identity its embedded player
/// requires.
///
/// Armada's main WKWebView is served from `capacitor://localhost`. WebKit does
/// not provide a supported way to replace the HTTP headers of a nested iframe,
/// and YouTube rejects that custom-scheme referrer with player error 153. A
/// second, native-owned WKWebView lets us use YouTube's documented iOS path:
/// load the embed request directly and attach a `Referer` derived from the
/// signed app's bundle identifier.
///
/// This deliberately lives only in the iOS target. Hosted and self-hosted web
/// clients keep sending their real page origin, while Android supplies its
/// attested package identity through WebView Media Integrity.
@objc(ArmadaYouTubePlugin)
public class ArmadaYouTubePlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "ArmadaYouTubePlugin"
    public let jsName = "ArmadaYouTube"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
    ]

    private weak var presentedPlayer: UIViewController?

    @objc func open(_ call: CAPPluginCall) {
        let videoID = call.getString("videoId")
        let playlistID = call.getString("playlistId")
        if let videoID, !Self.isVideoID(videoID) {
            call.reject("videoId is invalid")
            return
        }
        if let playlistID, !Self.isPlaylistID(playlistID) {
            call.reject("playlistId is invalid")
            return
        }
        guard videoID != nil || playlistID != nil else {
            return call.reject("A YouTube videoId or playlistId is required")
        }
        guard let bundleID = Bundle.main.bundleIdentifier?.lowercased(),
              let referrer = URL(string: "https://\(bundleID)/")
        else {
            return call.reject("The app bundle identifier is unavailable")
        }
        let requestedStart = call.getDouble("startSeconds", 0)
        let startSeconds = requestedStart.isFinite
            ? min(max(0, requestedStart), Double(Int32.max))
            : 0
        let autoplay = call.getBool("autoplay", true)

        DispatchQueue.main.async { [weak self] in
            guard let self, let root = self.bridge?.viewController else {
                return call.reject("The app view controller is unavailable")
            }

            // Treat a second tap while the player is already open as success;
            // presenting two UIKit controllers at once would otherwise fail.
            if self.presentedPlayer != nil {
                call.resolve()
                return
            }

            guard let player = ArmadaYouTubeViewController(
                videoID: videoID,
                playlistID: playlistID,
                startSeconds: startSeconds,
                autoplay: autoplay,
                referrer: referrer
            ) else {
                return call.reject("The YouTube embed URL could not be created")
            }
            let navigation = UINavigationController(rootViewController: player)
            navigation.modalPresentationStyle = .fullScreen
            self.presentedPlayer = navigation
            Self.topViewController(from: root).present(navigation, animated: true) {
                call.resolve()
            }
        }
    }

    private static func isVideoID(_ value: String) -> Bool {
        value.range(of: #"^[A-Za-z0-9_-]{11}$"#, options: .regularExpression) != nil
    }

    private static func isPlaylistID(_ value: String) -> Bool {
        value.range(of: #"^[A-Za-z0-9_-]{10,100}$"#, options: .regularExpression) != nil
    }

    private static func topViewController(from controller: UIViewController) -> UIViewController {
        if let presented = controller.presentedViewController {
            return topViewController(from: presented)
        }
        if let navigation = controller as? UINavigationController,
           let visible = navigation.visibleViewController {
            return topViewController(from: visible)
        }
        if let tabs = controller as? UITabBarController,
           let selected = tabs.selectedViewController {
            return topViewController(from: selected)
        }
        return controller
    }
}

private final class ArmadaYouTubeViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private let initialRequest: URLRequest
    private var playerWebView: WKWebView!

    init?(
        videoID: String?,
        playlistID: String?,
        startSeconds: Double,
        autoplay: Bool,
        referrer: URL
    ) {
        var components = URLComponents()
        components.scheme = "https"
        components.host = "www.youtube-nocookie.com"
        components.path = videoID.map { "/embed/\($0)" } ?? "/embed/videoseries"
        components.queryItems = [
            URLQueryItem(name: "autoplay", value: autoplay ? "1" : "0"),
            URLQueryItem(name: "playsinline", value: "1"),
            // Required for IFrame API users and useful as a second identity
            // signal, but not a replacement for the HTTP Referer above.
            URLQueryItem(name: "origin", value: String(referrer.absoluteString.dropLast())),
        ]
        if let playlistID {
            components.queryItems?.append(URLQueryItem(name: "list", value: playlistID))
        }
        let safeStart = startSeconds.isFinite
            ? min(max(0, startSeconds), Double(Int32.max))
            : 0
        if safeStart >= 1 {
            components.queryItems?.append(
                URLQueryItem(name: "start", value: String(Int(safeStart.rounded(.down))))
            )
        }
        guard let destination = components.url else { return nil }

        var request = URLRequest(url: destination)
        request.setValue(referrer.absoluteString, forHTTPHeaderField: "Referer")
        self.initialRequest = request
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "YouTube"
        view.backgroundColor = UIColor(
            red: 16.0 / 255.0,
            green: 11.0 / 255.0,
            blue: 21.0 / 255.0,
            alpha: 1
        )
        navigationItem.rightBarButtonItem = UIBarButtonItem(
            barButtonSystemItem: .done,
            target: self,
            action: #selector(close)
        )

        let appearance = UINavigationBarAppearance()
        appearance.configureWithOpaqueBackground()
        appearance.backgroundColor = view.backgroundColor
        appearance.titleTextAttributes = [.foregroundColor: UIColor.white]
        navigationController?.navigationBar.standardAppearance = appearance
        navigationController?.navigationBar.scrollEdgeAppearance = appearance
        navigationController?.navigationBar.tintColor = .white

        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        // Do not turn the native fallback into a second persistent browser
        // profile. The no-cookie embed remains isolated from Safari and Armada.
        configuration.websiteDataStore = .nonPersistent()

        playerWebView = WKWebView(frame: .zero, configuration: configuration)
        playerWebView.navigationDelegate = self
        playerWebView.uiDelegate = self
        playerWebView.isOpaque = false
        playerWebView.backgroundColor = view.backgroundColor
        playerWebView.scrollView.backgroundColor = view.backgroundColor
        playerWebView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(playerWebView)
        NSLayoutConstraint.activate([
            playerWebView.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            playerWebView.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            playerWebView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            playerWebView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
        ])

        playerWebView.load(initialRequest)
    }

    deinit {
        playerWebView?.stopLoading()
        playerWebView?.navigationDelegate = nil
        playerWebView?.uiDelegate = nil
    }

    @objc private func close() {
        playerWebView.stopLoading()
        dismiss(animated: true)
    }

    /// Keep the modal on the one embed it was created for. Explicit links such
    /// as "Watch on YouTube" leave the embed and open through the OS, while
    /// automatic attempts to navigate it elsewhere are simply refused.
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard navigationAction.targetFrame?.isMainFrame != false,
              let url = navigationAction.request.url
        else {
            decisionHandler(.allow)
            return
        }

        if Self.isEmbedURL(url) || url.scheme == "about" {
            decisionHandler(.allow)
            return
        }

        if navigationAction.navigationType == .linkActivated, Self.isSafeExternalURL(url) {
            UIApplication.shared.open(url)
        }
        decisionHandler(.cancel)
    }

    /// YouTube opens some player links in a new browsing context. This player
    /// intentionally has no second in-modal window; send user-initiated HTTPS
    /// links to the OS instead.
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if navigationAction.navigationType == .linkActivated,
           let url = navigationAction.request.url,
           Self.isSafeExternalURL(url) {
            UIApplication.shared.open(url)
        }
        return nil
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.load(initialRequest)
    }

    private static func isEmbedURL(_ url: URL) -> Bool {
        guard url.scheme == "https",
              let host = url.host?.lowercased(),
              host == "www.youtube-nocookie.com" || host == "www.youtube.com"
        else { return false }
        return url.path.hasPrefix("/embed/")
    }

    private static func isSafeExternalURL(_ url: URL) -> Bool {
        url.scheme == "https" || url.scheme == "http"
    }
}
