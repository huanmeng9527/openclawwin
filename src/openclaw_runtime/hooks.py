from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Callable, Protocol


HookHandler = Callable[[dict[str, Any]], Any]


class HookEngine:
    def __init__(self) -> None:
        self._handlers: dict[str, list[HookHandler]] = defaultdict(list)

    def register(self, event: str, handler: HookHandler) -> None:
        self._handlers[event].append(handler)

    def emit(self, event: str, context: dict[str, Any]) -> list[Any]:
        outputs = []
        for handler in list(self._handlers.get(event, [])):
            outputs.append(handler(context))
        return outputs


class Plugin(Protocol):
    name: str

    def install(self, context: "PluginContext") -> None:
        """Register plugin hooks, tools, commands, or services."""


@dataclass
class PluginContext:
    hooks: HookEngine
    services: dict[str, Any] = field(default_factory=dict)


class PluginManager:
    def __init__(self, context: PluginContext) -> None:
        self.context = context
        self.plugins: dict[str, Plugin] = {}

    def load(self, plugin: Plugin) -> None:
        plugin.install(self.context)
        self.plugins[plugin.name] = plugin
