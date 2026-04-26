from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Protocol
from uuid import uuid4


@dataclass(frozen=True)
class Attachment:
    kind: str
    uri: str
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class InternalMessage:
    channel: str
    peer_id: str
    text: str
    message_id: str = field(default_factory=lambda: uuid4().hex)
    sender_id: str | None = None
    group_id: str | None = None
    thread_id: str | None = None
    attachments: tuple[Attachment, ...] = ()
    metadata: dict[str, Any] = field(default_factory=dict)
    received_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    @property
    def is_group(self) -> bool:
        return self.group_id is not None

    @property
    def is_private(self) -> bool:
        return not self.is_group


class ChannelBridge(Protocol):
    name: str

    def normalize(self, native_event: dict[str, Any]) -> InternalMessage:
        """Convert platform-native events into an internal message envelope."""


class DictChannelBridge:
    def __init__(self, name: str) -> None:
        self.name = name

    def normalize(self, native_event: dict[str, Any]) -> InternalMessage:
        return InternalMessage(
            channel=self.name,
            peer_id=str(native_event["peer_id"]),
            sender_id=native_event.get("sender_id"),
            group_id=native_event.get("group_id"),
            thread_id=native_event.get("thread_id"),
            text=str(native_event.get("text", "")),
            metadata=dict(native_event.get("metadata", {})),
        )
