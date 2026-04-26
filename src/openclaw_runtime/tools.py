from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Callable

from openclaw_memory import WorkspaceMemory


logger = logging.getLogger(__name__)


ToolHandler = Callable[[dict[str, Any]], Any]


class ToolValidationError(Exception):
    """Raised when tool arguments fail schema validation."""

    def __init__(self, tool_name: str, message: str, errors: list[str] | None = None) -> None:
        self.tool_name = tool_name
        self.errors = errors or []
        super().__init__(f"tool '{tool_name}': {message}")


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    handler: ToolHandler
    schema: dict[str, Any] = field(default_factory=dict)


@dataclass
class ToolPolicy:
    global_deny: set[str] = field(default_factory=set)
    per_agent_deny: dict[str, set[str]] = field(default_factory=dict)
    global_allow: set[str] = field(default_factory=set)
    per_agent_allow: dict[str, set[str]] = field(default_factory=dict)
    default_allow: bool = False

    def allowed(self, tool_name: str, *, agent_id: str = "default") -> bool:
        if tool_name in self.global_deny:
            return False
        if tool_name in self.per_agent_deny.get(agent_id, set()):
            return False
        if tool_name in self.global_allow:
            return True
        if tool_name in self.per_agent_allow.get(agent_id, set()):
            return True
        return self.default_allow


def _validate_args(tool_name: str, args: dict[str, Any], schema: dict[str, Any]) -> None:
    """Validate tool arguments against JSON Schema.

    Raises:
        ToolValidationError: if arguments are invalid.
    """
    if not schema:
        return  # No schema = no validation

    try:
        import jsonschema

        validator_cls = jsonschema.Draft7Validator
        validator_kwargs: dict[str, Any] = {}

    except ImportError:
        import json
        import re

        # Minimal fallback: basic type checking without jsonschema
        # This path is used when jsonschema is not installed.
        # Preferred installation: pip install jsonschema
        def _check_type(value: Any, expected: str) -> bool:
            if expected == "string":
                return isinstance(value, str)
            if expected == "integer":
                return isinstance(value, int) and not isinstance(value, bool)
            if expected == "number":
                return isinstance(value, (int, float)) and not isinstance(value, bool)
            if expected == "boolean":
                return isinstance(value, bool)
            if expected == "array":
                return isinstance(value, list)
            if expected == "object":
                return isinstance(value, dict)
            return True

        errors: list[str] = []
        properties = schema.get("properties", {})
        required = set(schema.get("required", []))

        for param_name, param_spec in properties.items():
            if param_name in args:
                expected_type = param_spec.get("type")
                if expected_type and not _check_type(args[param_name], expected_type):
                    errors.append(
                        f"'{param_name}': expected {expected_type}, got {type(args[param_name]).__name__}"
                    )
            elif param_name in required:
                errors.append(f"'{param_name}': required field missing")

        if errors:
            logger.warning(
                "tool '%s' validation failed (no jsonschema): %s",
                tool_name,
                "; ".join(errors),
            )
            raise ToolValidationError(tool_name, "argument validation failed", errors)
        return

    # ── jsonschema is available ──────────────────────────────────────────────
    # Wrap the schema so that additional properties not in "properties" are
    # allowed by default (OpenClaw tools use open-schema where extra fields
    # from the model are permitted).  Only "additionalProperties: false"
    # enforces strictness.
    validator = validator_cls(schema, **validator_kwargs)
    errors = sorted(validator.iter_errors(args or {}), key=lambda e: e.path)

    if not errors:
        return

    error_messages: list[str] = []
    for error in errors:
        path = " -> ".join(str(p) for p in error.path) if error.path else "(root)"
        error_messages.append(f"{path}: {error.message}")

    logger.warning(
        "tool '%s' validation failed: %s | errors=%s",
        tool_name,
        "; ".join(error_messages),
        error_messages,
    )
    raise ToolValidationError(
        tool_name,
        "argument schema validation failed",
        error_messages,
    )


class ToolRegistry:
    def __init__(self, policy: ToolPolicy | None = None) -> None:
        self.policy = policy or ToolPolicy(default_allow=True)
        self._tools: dict[str, Tool] = {}

    def register(self, tool: Tool) -> None:
        self._tools[tool.name] = tool

    def get(self, name: str) -> Tool:
        if name not in self._tools:
            raise KeyError(name)
        return self._tools[name]

    def list_metadata(self, *, agent_id: str = "default") -> list[dict[str, Any]]:
        metadata = []
        for tool in sorted(self._tools.values(), key=lambda item: item.name):
            if self.policy.allowed(tool.name, agent_id=agent_id):
                metadata.append(
                    {
                        "name": tool.name,
                        "description": tool.description,
                        "schema": tool.schema,
                    }
                )
        return metadata

    def call(
        self,
        name: str,
        args: dict[str, Any] | None = None,
        *,
        agent_id: str = "default",
    ) -> Any:
        if not self.policy.allowed(name, agent_id=agent_id):
            raise PermissionError(f"tool denied: {name}")

        tool = self.get(name)
        validated_args = args or {}

        # ── Schema validation (blocks injection / bad args) ─────────────────
        _validate_args(tool.name, validated_args, tool.schema)

        logger.debug(
            "tool '%s' call accepted for agent '%s' with args=%s",
            name,
            agent_id,
            validated_args,
        )
        return tool.handler(validated_args)


def register_memory_tools(registry: ToolRegistry, memory: WorkspaceMemory) -> None:
    registry.register(
        Tool(
            name="memory_search",
            description="Search workspace memory with hybrid text recall.",
            schema={
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "limit": {"type": "integer", "default": 10, "minimum": 1},
                },
                "required": ["query"],
            },
            handler=lambda args: [
                result.to_dict()
                for result in memory.recall(
                    str(args.get("query", "")),
                    limit=int(args.get("limit", 10)),
                )
            ],
        )
    )
    registry.register(
        Tool(
            name="memory_get",
            description="Return memory search result candidates by id or query.",
            schema={
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "limit": {"type": "integer", "default": 1, "minimum": 1},
                },
                "required": ["query"],
            },
            handler=lambda args: [
                result.to_dict()
                for result in memory.recall(
                    str(args.get("query", "")),
                    limit=int(args.get("limit", 1)),
                )
            ],
        )
    )
