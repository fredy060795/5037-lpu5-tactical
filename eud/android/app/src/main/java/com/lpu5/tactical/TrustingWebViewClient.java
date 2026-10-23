package com.lpu5.tactical;

import android.net.Uri;
import android.net.http.SslCertificate;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.webkit.SslErrorHandler;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

import java.io.ByteArrayInputStream;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;

/**
 * Accepts TLS certificates of LPU5 servers whose CA was pinned via
 * LpuTrustPlugin (trust on first use). Everything else keeps the default
 * behaviour (request is cancelled).
 */
public class TrustingWebViewClient extends BridgeWebViewClient {

    public TrustingWebViewClient(Bridge bridge) {
        super(bridge);
    }

    @Override
    public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
        try {
            Uri uri = Uri.parse(error.getUrl());
            int port = uri.getPort() > 0 ? uri.getPort() : 443;
            X509Certificate ca = LpuTrustPlugin.pinnedFor(view.getContext(), uri.getHost() + ":" + port);
            X509Certificate leaf = toX509(error.getCertificate());
            if (ca != null && leaf != null && LpuTrustPlugin.signedBy(leaf, ca)) {
                handler.proceed();
                return;
            }
        } catch (Exception ignored) {
            // fall through to default handling
        }
        super.onReceivedSslError(view, handler, error);
    }

    private static X509Certificate toX509(SslCertificate cert) throws Exception {
        if (cert == null) return null;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            return cert.getX509Certificate();
        }
        // Older Android: the encoded certificate is only exposed via saveState().
        Bundle b = SslCertificate.saveState(cert);
        byte[] der = b.getByteArray("x509-certificate");
        if (der == null) return null;
        return (X509Certificate) CertificateFactory.getInstance("X.509").generateCertificate(new ByteArrayInputStream(der));
    }
}
