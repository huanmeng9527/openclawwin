from __future__ import annotations

import hashlib
import hmac
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from secrets import token_hex


@dataclass
class DeviceRecord:
    device_id: str
    role: str
    token_hash: str
    trusted: bool
    paired_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class DeviceTrustStore:
    def __init__(self, gateway_token: str | None = None) -> None:
        self.gateway_token = gateway_token or os.environ.get("OPENCLAW_GATEWAY_TOKEN")
        self._devices: dict[str, DeviceRecord] = {}
        self._plain_tokens: dict[str, str] = {}

    def authenticate_gateway(self, token: str | None) -> bool:
        if self.gateway_token is None:
            return True
        return hmac.compare_digest(self.gateway_token, token or "")

    def pair_device(self, device_id: str, role: str, *, auto_trust: bool = False) -> str:
        token = token_hex(24)
        self._plain_tokens[device_id] = token
        self._devices[device_id] = DeviceRecord(
            device_id=device_id,
            role=role,
            token_hash=hash_token(token),
            trusted=auto_trust,
        )
        return token

    def approve(self, device_id: str) -> None:
        if device_id not in self._devices:
            raise KeyError(device_id)
        self._devices[device_id].trusted = True

    def verify_device(self, device_id: str, token: str) -> bool:
        record = self._devices.get(device_id)
        if record is None or not record.trusted:
            return False
        return hmac.compare_digest(record.token_hash, hash_token(token))

    def get_record(self, device_id: str) -> DeviceRecord | None:
        return self._devices.get(device_id)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()
