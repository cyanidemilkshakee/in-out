"""Generate disposable PKI inside the test volume, never in the real deployment."""
from datetime import datetime, timedelta, timezone
from pathlib import Path
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID

directory = Path('/certificates')
# Re-running Compose must not rotate a CA still loaded by a running Kong.
if (directory / 'ready').exists():
    raise SystemExit(0)
now = datetime.now(timezone.utc)

def issue(name, common_name, issuer=None, server=False, expired=False):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, common_name)])
    builder = (x509.CertificateBuilder().subject_name(subject)
        .issuer_name(issuer[1].subject if issuer else subject)
        .public_key(key.public_key()).serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=2))
        .not_valid_after(now + timedelta(days=-1 if expired else 2))
        .add_extension(x509.BasicConstraints(ca=issuer is None, path_length=None), critical=True))
    if issuer:
        builder = builder.add_extension(x509.ExtendedKeyUsage([
            ExtendedKeyUsageOID.SERVER_AUTH if server else ExtendedKeyUsageOID.CLIENT_AUTH]), critical=False)
    if server:
        builder = builder.add_extension(x509.SubjectAlternativeName([x509.DNSName('kong')]), critical=False)
    cert = builder.sign(issuer[0] if issuer else key, hashes.SHA256())
    (directory / f'{name}.crt').write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    (directory / f'{name}.key').write_bytes(key.private_bytes(serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    return key, cert

ca = issue('ca', 'Gateway Test CA')
issue('server', 'kong', ca, server=True)
issue('client', 'terminal-test', ca)
issue('expired', 'terminal-expired', ca, expired=True)
untrusted = issue('untrusted-ca', 'Untrusted Test CA')
issue('untrusted', 'terminal-untrusted', untrusted)
(directory / 'ready').touch()
