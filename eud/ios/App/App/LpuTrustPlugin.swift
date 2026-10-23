import Foundation
import Capacitor
import CryptoKit
import Security
import WebKit

/// Trust-on-first-use for LPU5 servers with their own CA.
///
/// probe() fetches a server's certificate chain without trusting it, pin()
/// stores the server's CA for that host, and the WKWebView challenge hook
/// accepts certificates that chain to a pinned CA. Nothing is installed
/// system-wide – iOS does not allow apps to do that.
@objc(LpuTrustPlugin)
public class LpuTrustPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LpuTrustPlugin"
    public let jsName = "LpuTrust"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "probe", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pin", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unpin", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise)
    ]

    private static let defaultsKey = "lpu5_trust"

    // MARK: storage

    static func pinnedStore() -> [String: String] {
        UserDefaults.standard.dictionary(forKey: defaultsKey) as? [String: String] ?? [:]
    }

    static func pinnedCert(for hostPort: String) -> SecCertificate? {
        guard let pem = pinnedStore()[hostPort], let der = derFromPem(pem) else { return nil }
        return SecCertificateCreateWithData(nil, der as CFData)
    }

    static func derFromPem(_ pem: String) -> Data? {
        let b64 = pem
            .replacingOccurrences(of: "-----BEGIN CERTIFICATE-----", with: "")
            .replacingOccurrences(of: "-----END CERTIFICATE-----", with: "")
            .components(separatedBy: .whitespacesAndNewlines).joined()
        return Data(base64Encoded: b64)
    }

    static func pem(_ cert: SecCertificate) -> String {
        let der = SecCertificateCopyData(cert) as Data
        return "-----BEGIN CERTIFICATE-----\n\(der.base64EncodedString())\n-----END CERTIFICATE-----\n"
    }

    static func fingerprint(_ cert: SecCertificate) -> String {
        let der = SecCertificateCopyData(cert) as Data
        return SHA256.hash(data: der).map { String(format: "%02X", $0) }.joined(separator: ":")
    }

    static func hostPort(_ host: String, _ port: Int) -> String {
        "\(host):\(port > 0 ? port : 443)"
    }

    // MARK: WebView hook (called by Capacitor's WebViewDelegationHandler)

    @objc override public func handleWKWebViewURLAuthenticationChallenge(
        _ challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) -> Bool {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust,
              let ca = LpuTrustPlugin.pinnedCert(for: LpuTrustPlugin.hostPort(challenge.protectionSpace.host, challenge.protectionSpace.port))
        else { return false }
        SecTrustSetAnchorCertificates(trust, [ca] as CFArray)
        SecTrustSetAnchorCertificatesOnly(trust, false)
        if SecTrustEvaluateWithError(trust, nil) {
            completionHandler(.useCredential, URLCredential(trust: trust))
            return true
        }
        return false
    }

    // MARK: plugin methods

    @objc func probe(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"), let url = URL(string: urlString), url.scheme?.lowercased() == "https",
              let host = url.host else {
            call.resolve(["https": false])
            return
        }
        let recorder = ChainRecorder()
        let session = URLSession(configuration: .ephemeral, delegate: recorder, delegateQueue: nil)
        var req = URLRequest(url: url.appendingPathComponent("api/me"))
        req.timeoutInterval = 8
        session.dataTask(with: req) { _, _, error in
            session.invalidateAndCancel()
            guard let chain = recorder.chain, let ca = chain.last else {
                call.reject("Server nicht erreichbar: \(error?.localizedDescription ?? "kein Zertifikat")")
                return
            }
            let hp = LpuTrustPlugin.hostPort(host, url.port ?? 443)
            let pinned = LpuTrustPlugin.pinnedCert(for: hp)
            var result: [String: Any] = [
                "https": true,
                "hostPort": hp,
                "systemTrusted": recorder.systemTrusted,
                "subject": (SecCertificateCopySubjectSummary(ca) as String?) ?? "",
                "fingerprint": LpuTrustPlugin.fingerprint(ca),
                "pem": LpuTrustPlugin.pem(ca)
            ]
            result["pinnedFingerprint"] = pinned.map { LpuTrustPlugin.fingerprint($0) } ?? NSNull()
            call.resolve(result)
        }.resume()
    }

    @objc func pin(_ call: CAPPluginCall) {
        guard let hp = call.getString("hostPort"), let pem = call.getString("pem"),
              let der = LpuTrustPlugin.derFromPem(pem), let cert = SecCertificateCreateWithData(nil, der as CFData) else {
            call.reject("Zertifikat ungültig")
            return
        }
        var store = LpuTrustPlugin.pinnedStore()
        store[hp] = LpuTrustPlugin.pem(cert)
        UserDefaults.standard.set(store, forKey: LpuTrustPlugin.defaultsKey)
        call.resolve(["fingerprint": LpuTrustPlugin.fingerprint(cert)])
    }

    @objc func unpin(_ call: CAPPluginCall) {
        var store = LpuTrustPlugin.pinnedStore()
        store.removeValue(forKey: call.getString("hostPort") ?? "")
        UserDefaults.standard.set(store, forKey: LpuTrustPlugin.defaultsKey)
        call.resolve()
    }

    @objc func list(_ call: CAPPluginCall) {
        var out: [String: String] = [:]
        for key in LpuTrustPlugin.pinnedStore().keys {
            if let c = LpuTrustPlugin.pinnedCert(for: key) { out[key] = LpuTrustPlugin.fingerprint(c) }
        }
        call.resolve(["pinned": out])
    }
}

/// Records the server certificate chain and whether iOS trusts it, then
/// lets the probe request continue without trusting anything new.
private final class ChainRecorder: NSObject, URLSessionDelegate {
    var chain: [SecCertificate]?
    var systemTrusted = false

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard let trust = challenge.protectionSpace.serverTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        systemTrusted = SecTrustEvaluateWithError(trust, nil)
        if #available(iOS 15.0, *) {
            chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate]
        } else {
            chain = (0..<SecTrustGetCertificateCount(trust)).compactMap { SecTrustGetCertificateAtIndex(trust, $0) }
        }
        // Only inspecting – the probe never sends data to an untrusted server.
        completionHandler(.cancelAuthenticationChallenge, nil)
    }
}
