"""
Real container sandbox using Docker (or Podman).

Architecture:
  SandboxManager  — policy planning (which session gets sandbox, scope key)
  SandboxRunner   — protocol / abstraction
  DockerSandboxRunner — actual Docker container execution

Usage:
  # Gateway creates the runner automatically if sandbox mode != "off"
  gateway = Gateway(config)  # sandbox=SandboxConfig(mode="tools") → uses Docker

  # Or wire it manually:
  runner = DockerSandboxRunner(
      image="alpine:latest",
      default_workspace_mount="/path/to/workspace",
  )
  result = runner.run(["echo", "hello"], workspace_path="/path/to/workspace")
"""

from __future__ import annotations

import json
import logging
import subprocess
import tempfile
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .sessions import SessionRecord


logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class SandboxConfig:
    """Policy-level sandbox configuration (workspace-wide)."""

    # "off" | "tools" | "all"
    #   off: no sandbox, tools run directly on host
    #   tools: high-risk tools (exec, run_code, shell) run in container
    #   all: every tool runs in container
    mode: str = "off"

    # "session" | "agent" | "shared"
    # Determines container scope / reuse
    scope: str = "session"

    # "ro" | "rw" — workspace filesystem mount mode inside container
    workspace_access: str = "ro"

    # Tools that always run inside sandbox (regardless of mode)
    sandboxed_tools: tuple[str, ...] = (
        "exec",
        "shell",
        "run_code",
        "bash",
        "python_eval",
        "subprocess",
    )

    # Docker image to use
    image: str = "alpine:3.20"

    # Memory limit (Docker --memory)
    memory_limit: str = "256m"

    # CPU limit (Docker --cpus)
    cpu_limit: float = 0.5

    # PID limit (Docker --pids-limit)
    pids_limit: int = 64


@dataclass(frozen=True)
class SandboxPlan:
    """Result of sandbox planning — describes the container to create."""

    enabled: bool
    scope_key: str  # e.g. "session:abc123" or "agent:agent-001"
    workspace_access: str  # "ro" or "rw"
    image: str
    memory_limit: str
    cpu_limit: float
    pids_limit: int
    network: str = "none"  # "none" | "bridge"


# ─────────────────────────────────────────────────────────────────────────────
# Sandbox Runner Protocol
# ─────────────────────────────────────────────────────────────────────────────

class SandboxRunner(ABC):
    """Abstract sandbox runner — implement to add gVisor, Podman, etc."""

    @abstractmethod
    def run(
        self,
        argv: list[str],
        *,
        workspace_path: Path | None = None,
        env: dict[str, str] | None = None,
        timeout_seconds: float = 30.0,
    ) -> "SandboxResult":
        """Execute argv inside a sandboxed environment."""


@dataclass(frozen=True)
class SandboxResult:
    """Outcome of a sandboxed execution."""

    ok: bool
    stdout: str
    stderr: str
    exit_code: int
    duration_ms: int
    error: str = ""  # human-readable error if not ok


# ─────────────────────────────────────────────────────────────────────────────
# Docker Sandbox Runner
# ─────────────────────────────────────────────────────────────────────────────

class DockerSandboxRunner(SandboxRunner):
    """Docker-based sandbox with secure defaults.

    Default container security posture:
      --read-only        root filesystem is read-only
      --user nobody      non-root user (uid 65534)
      --network none     no network access
      --pids-limit 64    limited PID count
      --memory 256m      memory limit
      --cpus 0.5         CPU limit
      --tmpfs /tmp       writable /tmp in memory
      --cap-drop ALL     all capabilities dropped
      --security-opt no-new-privileges

    Workspace is bind-mounted (ro by default).
    """

    def __init__(
        self,
        image: str = "alpine:3.20",
        *,
        memory_limit: str = "256m",
        cpu_limit: float = 0.5,
        pids_limit: int = 64,
        network: str = "none",
    ) -> None:
        self.image = image
        self.memory_limit = memory_limit
        self.cpu_limit = cpu_limit
        self.pids_limit = pids_limit
        self.network = network
        self._pull_image()

    def _pull_image(self) -> None:
        """Ensure the image is present (idempotent)."""
        try:
            subprocess.run(
                ["docker", "image", "inspect", self.image],
                capture_output=True,
                timeout=10,
            )
        except FileNotFoundError:
            raise RuntimeError(
                "docker not found in PATH. Install Docker or set "
                "sandbox mode to 'off'. "
                "See: https://docs.docker.com/get-docker/"
            )
        except subprocess.CalledProcessError:
            logger.info("pulling sandbox image %s", self.image)
            subprocess.run(
                ["docker", "pull", "--quiet", self.image],
                capture_output=True,
                timeout=120,
                check=True,
            )

    def run(
        self,
        argv: list[str],
        *,
        workspace_path: Path | None = None,
        env: dict[str, str] | None = None,
        timeout_seconds: float = 30.0,
    ) -> SandboxResult:
        import time

        t0 = time.monotonic()

        docker_args = [
            "docker", "run",
            "--rm",                          # auto-remove container on exit
            "--read-only",                   # read-only rootfs
            "--user", "65534:65534",         # nobody user
            "--network", self.network,        # no network by default
            "--pids-limit", str(self.pids_limit),
            "--memory", self.memory_limit,
            "--cpus", str(self.cpu_limit),
            "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges",
            "--memory-swap", self.memory_limit,  # disable swap
            "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
        ]

        # Workspace bind mount
        if workspace_path is not None:
            access = "ro"  # default read-only; caller overrides if needed
            docker_args += [
                "--mount",
                f"type=bind,source={workspace_path},target={workspace_path},readonly={access != 'rw'}",
            ]

        # Environment variables (sandboxed copy)
        safe_env = {
            "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "HOME": "/tmp",
            "TMPDIR": "/tmp",
        }
        if env:
            # Filter out dangerous host-level vars
            for k, v in env.items():
                if k not in ("PATH", "HOME", "TMPDIR", "USER"):
                    safe_env[k] = v
        for k, v in safe_env.items():
            docker_args += ["--env", f"{k}={v}"]

        docker_args += [self.image, "/bin/sh", "-c", " ".join(argv)]

        try:
            result = subprocess.run(
                docker_args,
                capture_output=True,
                text=True,
                timeout=timeout_seconds,
            )
            duration_ms = int((time.monotonic() - t0) * 1000)
            return SandboxResult(
                ok=result.returncode == 0,
                stdout=result.stdout[:4096],
                stderr=result.stderr[:4096],
                exit_code=result.returncode,
                duration_ms=duration_ms,
            )
        except subprocess.TimeoutExpired as exc:
            duration_ms = int((time.monotonic() - t0) * 1000)
            logger.warning("sandbox run timed out after %.0fs: %s", timeout_seconds, argv)
            return SandboxResult(
                ok=False,
                stdout="",
                stderr=f"timeout after {timeout_seconds}s",
                exit_code=-1,
                duration_ms=duration_ms,
                error="timeout",
            )
        except Exception as exc:
            duration_ms = int((time.monotonic() - t0) * 1000)
            logger.error("sandbox run error: %s", exc, exc_info=True)
            return SandboxResult(
                ok=False,
                stdout="",
                stderr=str(exc),
                exit_code=-1,
                duration_ms=duration_ms,
                error=type(exc).__name__,
            )


class PodmanSandboxRunner(SandboxRunner):
    """Podman-based sandbox — identical API to DockerSandboxRunner.

    Requires: podman installed and running (rootless preferred).
    """

    def __init__(
        self,
        image: str = "alpine:3.20",
        *,
        memory_limit: str = "256m",
        cpu_limit: float = 0.5,
        pids_limit: int = 64,
        network: str = "none",
    ) -> None:
        self.image = image
        self.memory_limit = memory_limit
        self.cpu_limit = cpu_limit
        self.pids_limit = pids_limit
        self.network = network

    def run(
        self,
        argv: list[str],
        *,
        workspace_path: Path | None = None,
        env: dict[str, str] | None = None,
        timeout_seconds: float = 30.0,
    ) -> SandboxResult:
        import time

        t0 = time.monotonic()

        podman_args = [
            "podman", "run",
            "--rm",
            "--read-only",
            "--user", "65534:65534",
            "--network", self.network,
            "--pids-limit", str(self.pids_limit),
            "--memory", self.memory_limit,
            "--cpus", str(self.cpu_limit),
            "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges",
            "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
        ]

        if workspace_path is not None:
            podman_args += [
                "--volume", f"{workspace_path}:{workspace_path}:ro",
            ]

        safe_env = {
            "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "HOME": "/tmp",
            "TMPDIR": "/tmp",
        }
        if env:
            for k, v in env.items():
                if k not in ("PATH", "HOME", "TMPDIR", "USER"):
                    safe_env[k] = v
        for k, v in safe_env.items():
            podman_args += ["--env", f"{k}={v}"]

        podman_args += [self.image, "/bin/sh", "-c", " ".join(argv)]

        try:
            result = subprocess.run(
                podman_args,
                capture_output=True,
                text=True,
                timeout=timeout_seconds,
            )
            duration_ms = int((time.monotonic() - t0) * 1000)
            return SandboxResult(
                ok=result.returncode == 0,
                stdout=result.stdout[:4096],
                stderr=result.stderr[:4096],
                exit_code=result.returncode,
                duration_ms=duration_ms,
            )
        except subprocess.TimeoutExpired as exc:
            duration_ms = int((time.monotonic() - t0) * 1000)
            return SandboxResult(
                ok=False, stdout="", stderr=f"timeout after {timeout_seconds}s",
                exit_code=-1, duration_ms=duration_ms, error="timeout",
            )
        except Exception as exc:
            duration_ms = int((time.monotonic() - t0) * 1000)
            return SandboxResult(
                ok=False, stdout="", stderr=str(exc),
                exit_code=-1, duration_ms=duration_ms, error=type(exc).__name__,
            )


# ─────────────────────────────────────────────────────────────────────────────
# Sandbox Manager (policy planning)
# ─────────────────────────────────────────────────────────────────────────────

class SandboxManager:
    """Plans sandbox configuration for a given session.

    The plan is consumed by the tool dispatch layer to decide whether
    to run a tool directly on the host or inside a container.
    """

    def __init__(
        self,
        config: SandboxConfig | None = None,
        runner: SandboxRunner | None = None,
    ) -> None:
        self.config = config or SandboxConfig()
        self.runner = runner  # None = use SandboxRunner.run() directly on host

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
            image=self.config.image,
            memory_limit=self.config.memory_limit,
            cpu_limit=self.config.cpu_limit,
            pids_limit=self.config.pids_limit,
            network="none",
        )

    def _enabled_for(self, session: SessionRecord) -> bool:
        if self.config.mode == "off":
            return False
        if self.config.mode == "all":
            return True
        if self.config.mode == "tools":
            return True  # tools in sandboxed_tools list will be containerized
        raise ValueError(f"unknown sandbox mode: {self.config.mode}")

    def should_sandbox_tool(self, tool_name: str) -> bool:
        """Return True if this tool should run inside a container."""
        if self.config.mode == "off":
            return False
        if self.config.mode == "all":
            return True
        return tool_name in self.config.sandboxed_tools

    def get_runner(self) -> SandboxRunner | None:
        """Return the container runner, or None if sandboxing is disabled."""
        if self.config.mode == "off":
            return None
        if self.runner is not None:
            return self.runner
        # Auto-detect: prefer podman (rootless), fall back to docker
        runner: SandboxRunner | None = None
        if Path("/usr/bin/podman").exists() or Path("/usr/local/bin/podman").exists():
            runner = PodmanSandboxRunner(
                image=self.config.image,
                memory_limit=self.config.memory_limit,
                cpu_limit=self.config.cpu_limit,
                pids_limit=self.config.pids_limit,
            )
        elif Path("/usr/bin/docker").exists() or Path("/usr/local/bin/docker").exists():
            runner = DockerSandboxRunner(
                image=self.config.image,
                memory_limit=self.config.memory_limit,
                cpu_limit=self.config.cpu_limit,
                pids_limit=self.config.pids_limit,
            )
        else:
            logger.warning(
                "no container runtime (docker/podman) found in PATH. "
                "sandbox mode '%s' will fall back to host execution.",
                self.config.mode,
            )
        return runner
