from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class GatewayFrame:
    type: str
    payload: dict[str, Any] = field(default_factory=dict)
    id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        data = {"type": self.type, **self.payload}
        if self.id is not None:
            data["id"] = self.id
        return data


def connect_frame(device_id: str, role: str, token: str | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "type": "connect",
        "deviceId": device_id,
        "role": role,
    }
    if token is not None:
        payload["token"] = token
    return payload


def request_frame(
    request_id: str,
    method: str,
    params: dict[str, Any] | None = None,
    idempotency_key: str | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "type": "req",
        "id": request_id,
        "method": method,
        "params": params or {},
    }
    if idempotency_key is not None:
        payload["idempotencyKey"] = idempotency_key
    return payload


def response_frame(
    request_id: str,
    *,
    ok: bool,
    payload: dict[str, Any] | None = None,
    error: str | None = None,
) -> dict[str, Any]:
    data: dict[str, Any] = {"type": "res", "id": request_id, "ok": ok}
    if ok:
        data["payload"] = payload or {}
    else:
        data["error"] = error or "unknown error"
    return data


def event_frame(
    event: str,
    payload: dict[str, Any] | None = None,
    *,
    seq: int | None = None,
    state_version: int | None = None,
) -> dict[str, Any]:
    data: dict[str, Any] = {
        "type": "event",
        "event": event,
        "payload": payload or {},
    }
    if seq is not None:
        data["seq"] = seq
    if state_version is not None:
        data["stateVersion"] = state_version
    return data


SIDE_EFFECT_METHODS = frozenset({"send", "agent", "tool.call", "node.call"})


def validate_request_frame(frame: dict[str, Any]) -> None:
    if frame.get("type") != "req":
        raise ValueError("expected req frame")
    if not frame.get("id"):
        raise ValueError("request frame requires id")
    if not frame.get("method"):
        raise ValueError("request frame requires method")
    if frame["method"] in SIDE_EFFECT_METHODS and not frame.get("idempotencyKey"):
        raise ValueError(f"{frame['method']} requires idempotencyKey")
