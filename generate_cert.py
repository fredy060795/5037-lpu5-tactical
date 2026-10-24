#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
generate_cert.py - TLS certificates for LPU5 Tactical Tracker

Creates a small local certificate authority (lpu5-ca.pem / lpu5-ca-key.pem)
once, and a server certificate (cert.pem / key.pem) signed by it that covers
localhost and all IP addresses of this machine.

Why a CA instead of a plain self-signed certificate: phones only grant
camera, Bluetooth (Web Bluetooth), geolocation and service workers (offline
PWA) to *trusted* HTTPS origins. Android and iOS accept a user-installed
certificate as trusted only if it is a CA certificate. Install the CA once on
each EUD (download from https://<server>:5037/lpu5-ca.crt) and every
server certificate generated later is trusted automatically – even after the
server IP changes.

Called automatically from api.py when cert.pem / key.pem are missing.
Manual use:  python generate_cert.py [ip-or-hostname ...]   (renews cert.pem)
"""

import datetime
import ipaddress
import logging
import os
import socket

logger = logging.getLogger("lpu5-api")

CA_CERT_NAME = "lpu5-ca.pem"
CA_KEY_NAME = "lpu5-ca-key.pem"


def _local_addresses():
    """Best-effort list of this host's IPv4 addresses."""
    addrs = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            addrs.add(info[4][0])
    except OSError:
        pass
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        addrs.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    addrs.discard("0.0.0.0")
    return sorted(addrs)


def _write_key(path, key, serialization):
    with open(path, "wb") as f:
        f.write(key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        ))
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def ensure_ca(directory: str):
    """Load the LPU5 CA from `directory`, creating it on first use."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    ca_cert_path = os.path.join(directory, CA_CERT_NAME)
    ca_key_path = os.path.join(directory, CA_KEY_NAME)
    if os.path.exists(ca_cert_path) and os.path.exists(ca_key_path):
        with open(ca_cert_path, "rb") as f:
            ca_cert = x509.load_pem_x509_certificate(f.read())
        with open(ca_key_path, "rb") as f:
            ca_key = serialization.load_pem_private_key(f.read(), password=None)
        return ca_cert, ca_key

    ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "LPU5 Tactical"),
        x509.NameAttribute(NameOID.COMMON_NAME, f"LPU5 Tactical Root CA ({socket.gethostname()})"),
    ])
    now = datetime.datetime.now(datetime.timezone.utc)
    ca_cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=3650))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(x509.KeyUsage(
            digital_signature=True, key_cert_sign=True, crl_sign=True, content_commitment=False,
            key_encipherment=False, data_encipherment=False, key_agreement=False,
            encipher_only=False, decipher_only=False), critical=True)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()), critical=False)
        .sign(ca_key, hashes.SHA256())
    )
    _write_key(ca_key_path, ca_key, serialization)
    with open(ca_cert_path, "wb") as f:
        f.write(ca_cert.public_bytes(serialization.Encoding.PEM))
    logger.info("Generated LPU5 root CA: %s", ca_cert_path)
    return ca_cert, ca_key


def generate_self_signed_cert(cert_path: str, key_path: str, hostname: str = "localhost", extra_hosts=None) -> bool:
    """Generate cert.pem/key.pem signed by the local LPU5 CA.

    The name is kept for compatibility with existing callers. SANs cover
    localhost, 127.0.0.1, `hostname`, `extra_hosts` and all local IPs.
    """
    try:
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
    except ImportError:
        logger.warning("cryptography package not available – cannot generate certificates")
        return False

    try:
        directory = os.path.dirname(os.path.abspath(cert_path))
        ca_cert, ca_key = ensure_ca(directory)
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

        hosts = ["localhost", "127.0.0.1", hostname, *(extra_hosts or []), *_local_addresses()]
        san, seen = [], set()
        for h in hosts:
            if not h or h in seen:
                continue
            seen.add(h)
            try:
                san.append(x509.IPAddress(ipaddress.ip_address(h)))
            except ValueError:
                san.append(x509.DNSName(h))

        now = datetime.datetime.now(datetime.timezone.utc)
        cert = (
            x509.CertificateBuilder()
            .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, hostname or "localhost")]))
            .issuer_name(ca_cert.subject)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(days=1))
            # Apple rejects TLS server certificates valid for more than 825 days.
            .not_valid_after(now + datetime.timedelta(days=800))
            .add_extension(x509.SubjectAlternativeName(san), critical=False)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
            .sign(ca_key, hashes.SHA256())
        )

        _write_key(key_path, key, serialization)
        with open(cert_path, "wb") as f:
            # Full chain so clients can build the path to the installed CA.
            f.write(cert.public_bytes(serialization.Encoding.PEM))
            f.write(ca_cert.public_bytes(serialization.Encoding.PEM))
        logger.info("Generated server certificate %s for %s", cert_path, ", ".join(sorted(seen)))
        return True

    except Exception as exc:
        logger.error("Certificate generation failed: %s", exc)
        for path in (cert_path, key_path):
            if os.path.exists(path):
                try:
                    os.remove(path)
                except OSError:
                    pass
        return False


def is_legacy_self_signed(cert_path: str) -> bool:
    """True for certificates made by the old generator (self-signed leaf
    without CA flag) – these cannot be trusted on phones and are replaced."""
    try:
        from cryptography import x509
        with open(cert_path, "rb") as f:
            cert = x509.load_pem_x509_certificate(f.read())
        if cert.issuer != cert.subject:
            return False
        try:
            return not cert.extensions.get_extension_for_class(x509.BasicConstraints).value.ca
        except x509.ExtensionNotFound:
            return True
    except Exception:
        return False


if __name__ == "__main__":
    import sys

    logging.basicConfig(level=logging.INFO)
    hosts = sys.argv[1:]
    primary = hosts[0] if hosts else "localhost"
    if generate_self_signed_cert("cert.pem", "key.pem", primary, hosts[1:]):
        print("Server certificate written to cert.pem / key.pem")
        print(f"Install {CA_CERT_NAME} (or https://<server>:5037/lpu5-ca.crt) on every EUD as trusted CA.")
    else:
        print("Failed to generate certificate", file=sys.stderr)
        sys.exit(1)
