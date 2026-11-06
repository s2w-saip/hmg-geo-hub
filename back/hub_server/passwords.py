"""Password hashing for HUB login: stdlib scrypt, so hub_storage/manage.py can import it without the BFF's
dependencies. Encoded as scrypt$N$r$p$salt$hash (base64)."""
import base64
import hashlib
import hmac
import secrets

N, R, P, SALT_BYTES, HASH_BYTES = 2**14, 8, 1, 16, 32
MAX_N = 2**17   # a stored hash cannot make one check cost more than this


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(SALT_BYTES)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=N, r=R, p=P, dklen=HASH_BYTES)
    return f'scrypt${N}${R}${P}${base64.b64encode(salt).decode()}${base64.b64encode(digest).decode()}'


def verify_password(password: str, encoded: str) -> bool:
    try:
        scheme, n, r, p, salt, digest = encoded.split('$')
        n, r, p = int(n), int(r), int(p)
        if scheme != 'scrypt' or not (2 <= n <= MAX_N and 1 <= r <= 8 and 1 <= p <= 4):
            return False
        expected = base64.b64decode(digest, validate=True)
        actual = hashlib.scrypt(password.encode(), salt=base64.b64decode(salt, validate=True), n=n, r=r, p=p,
                                dklen=len(expected), maxmem=256 * n * r + 2**20)
    except ValueError:
        return False
    return hmac.compare_digest(actual, expected)


# Checked against when the login is unknown, so an unknown login costs the same time as a wrong password.
DUMMY_HASH = hash_password(secrets.token_hex(16))
