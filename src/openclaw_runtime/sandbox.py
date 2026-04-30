from __future__ import annotations

from dataclasses import dataclass

from .sessions import SessionRecord


@dataclass(frozen=True)
class SandboxConfig:
    mode: str = "off"
    scope: str = "session"
    workspace_access: str = "rw"


@dataclass(frozen=True)
class SandboxPlan:
    enabled: bool
    scope_key: str
    workspace_access: str


class SandboxManager:
    def __init__(self, config: SandboxConfig | None = None) -> None:
        self.config = config or SandboxConfig()

    def plan_for(self, session: SessionRecord) -> SandboxPlan:
        enabled = self._enabled_for(session)
        if self.config.scope == "agent":
            scope_key = f"agent:{session.agent_id}"
        elif self.config.scope == "shared":
            scope_key = "shared"
        else:
            scope_key = f"session:{session.session_id}"
        return SandboxPlan(
            enabled=enabled,
            scope_key=scope_key,
            workspace_access=self.config.workspace_access,
        )

    def _enabled_for(self, session: SessionRecord) -> bool:
        if self.config.mode == "off":
            return False
        if self.config.mode == "all":
            return True
        if self.config.mode == "non-main":
            return not session.private
        raise ValueError(f"unknown sandbox mode: {self.config.mode}")
