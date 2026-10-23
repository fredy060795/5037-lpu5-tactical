package com.lpu5.tactical;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.Iterator;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;

/**
 * Trust-on-first-use for LPU5 servers with their own CA.
 *
 * probe() fetches the certificate chain of a server (without trusting it),
 * pin() stores the server's CA for that host, and TrustingWebViewClient lets
 * the WebView accept certificates signed by a pinned CA. Nothing is installed
 * system-wide – Android does not allow apps to do that.
 */
@CapacitorPlugin(name = "LpuTrust")
public class LpuTrustPlugin extends Plugin {

    private static final String PREFS = "lpu5_trust";

    // ---- storage (also used by TrustingWebViewClient) ----

    static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Pinned CA for host:port, or null. */
    static X509Certificate pinnedFor(Context ctx, String hostPort) {
        String pem = prefs(ctx).getString(hostPort, null);
        if (pem == null) return null;
        try {
            return parsePem(pem);
        } catch (Exception e) {
            return null;
        }
    }

    static X509Certificate parsePem(String pem) throws Exception {
        String b64 = pem.replaceAll("-----(BEGIN|END) CERTIFICATE-----", "").replaceAll("\\s", "");
        byte[] der = Base64.decode(b64, Base64.DEFAULT);
        CertificateFactory cf = CertificateFactory.getInstance("X.509");
        return (X509Certificate) cf.generateCertificate(new ByteArrayInputStream(der));
    }

    static String toPem(X509Certificate cert) throws Exception {
        return "-----BEGIN CERTIFICATE-----\n"
            + Base64.encodeToString(cert.getEncoded(), Base64.NO_WRAP)
            + "\n-----END CERTIFICATE-----\n";
    }

    static String fingerprint(X509Certificate cert) throws Exception {
        byte[] d = MessageDigest.getInstance("SHA-256").digest(cert.getEncoded());
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < d.length; i++) {
            if (i > 0) sb.append(':');
            sb.append(String.format("%02X", d[i]));
        }
        return sb.toString();
    }

    static String hostPort(String url) throws Exception {
        URI u = new URI(url);
        int port = u.getPort() > 0 ? u.getPort() : ("http".equalsIgnoreCase(u.getScheme()) ? 80 : 443);
        return u.getHost() + ":" + port;
    }

    /** True if `leaf` is the pinned certificate itself or was signed by it. */
    static boolean signedBy(X509Certificate leaf, X509Certificate ca) {
        try {
            leaf.checkValidity();
            if (leaf.equals(ca)) return true;
            leaf.verify(ca.getPublicKey());
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    // ---- plugin methods ----

    @PluginMethod
    public void probe(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !url.toLowerCase().startsWith("https://")) {
            JSObject r = new JSObject();
            r.put("https", false);
            call.resolve(r);
            return;
        }
        new Thread(() -> {
            try {
                URI u = new URI(url);
                int port = u.getPort() > 0 ? u.getPort() : 443;
                final X509Certificate[][] captured = new X509Certificate[1][];
                X509TrustManager recorder = new X509TrustManager() {
                    public void checkClientTrusted(X509Certificate[] chain, String authType) {}
                    public void checkServerTrusted(X509Certificate[] chain, String authType) { captured[0] = chain; }
                    public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
                };
                SSLContext ctx = SSLContext.getInstance("TLS");
                ctx.init(null, new TrustManager[] { recorder }, null);
                try (SSLSocket s = (SSLSocket) ctx.getSocketFactory().createSocket()) {
                    s.connect(new InetSocketAddress(u.getHost(), port), 8000);
                    s.setSoTimeout(8000);
                    s.startHandshake();
                }
                X509Certificate[] chain = captured[0];
                if (chain == null || chain.length == 0) throw new Exception("Kein Zertifikat erhalten");

                boolean systemTrusted;
                try {
                    TrustManagerFactory tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
                    tmf.init((KeyStore) null);
                    ((X509TrustManager) tmf.getTrustManagers()[0]).checkServerTrusted(chain, "RSA");
                    systemTrusted = true;
                } catch (Exception e) {
                    systemTrusted = false;
                }

                // The LPU5 server sends leaf + CA; pin the top of the chain.
                X509Certificate ca = chain[chain.length - 1];
                JSObject r = new JSObject();
                r.put("https", true);
                r.put("hostPort", u.getHost() + ":" + port);
                r.put("systemTrusted", systemTrusted);
                r.put("subject", ca.getSubjectX500Principal().getName());
                r.put("fingerprint", fingerprint(ca));
                r.put("pem", toPem(ca));
                r.put("validTo", ca.getNotAfter().getTime());
                X509Certificate pinned = pinnedFor(getContext(), u.getHost() + ":" + port);
                r.put("pinnedFingerprint", pinned != null ? fingerprint(pinned) : null);
                call.resolve(r);
            } catch (Exception e) {
                call.reject("Server nicht erreichbar: " + e.getMessage());
            }
        }).start();
    }

    @PluginMethod
    public void pin(PluginCall call) {
        try {
            String hp = call.getString("hostPort");
            X509Certificate ca = parsePem(call.getString("pem"));
            prefs(getContext()).edit().putString(hp, toPem(ca)).apply();
            JSObject r = new JSObject();
            r.put("fingerprint", fingerprint(ca));
            call.resolve(r);
        } catch (Exception e) {
            call.reject("Zertifikat ungültig: " + e.getMessage());
        }
    }

    @PluginMethod
    public void unpin(PluginCall call) {
        prefs(getContext()).edit().remove(call.getString("hostPort", "")).apply();
        call.resolve();
    }

    @PluginMethod
    public void list(PluginCall call) {
        JSObject r = new JSObject();
        try {
            JSONObject all = new JSONObject();
            for (String key : prefs(getContext()).getAll().keySet()) {
                X509Certificate c = pinnedFor(getContext(), key);
                if (c != null) all.put(key, fingerprint(c));
            }
            r.put("pinned", all);
        } catch (Exception e) {
            r.put("pinned", new JSObject());
        }
        call.resolve(r);
    }
}
