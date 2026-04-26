from __future__ import annotations

import ssl
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from openclaw_memory import WorkspaceMemory

from .agent import AgentRuntime, AgentRunResult, EchoModelProvider
from .approval import ApprovalBroker, ApprovalServer
from .audit import AuditLogger
from .hooks import HookEngine, PluginContext, PluginManager
from .messaging import ChannelBridge, DictChannelBridge, InternalMessage
from .nodes import NodeRegistry
from .policies import (
    ApprovalPolicy,
    ChannelAllowlistPolicy,
    MessageSendPolicy,
    PolicyEngine,
)
from .prompt import PromptAssembler
from .queue import Command, LaneAwareCommandQueue
from .sandbox import SandboxConfig, SandboxManager
from .scheduler import CronScheduler, HeartbeatSystem, ScheduledJob
from .security import DeviceTrustStore
from .sessions import SessionManager, SessionRecord
from .skills import SkillLoader
from .tools import ToolPolicy, ToolRegistry, register_memory_tools


# Minimum TLS version: TLS 1.2 (no SSL, no TLS 1.0/1.1)
_MIN_TLS_VERSION: dict[str, int] = {
    "1.2": ssl.TLSVersion.TLSv1_2,
    "1.3": ssl.TLSVersion.TLSv1_3,
}


@dataclass(frozen=True)
class TLSConfig:
    """TLS termination configuration for the Gateway.

    Supports two modes:
      - termination: Gateway terminates TLS directly (serve HTTPS).
      - passthrough: TLS is terminated upstream (e.g. nginx/caddy); Gateway
        receives plaintext.  Set enabled=False to explicitly disable TLS.

    Usage with upstream proxy (recommended for production):
        gateway = Gateway(config, tls=TLSConfig(enabled=False))
        # nginx terminates TLS and forwards X-Forwarded-Proto: https

    Direct HTTPS serve (development / small deployments):
        gateway = Gateway(config, tls=TLSConfig(
            enabled=True,
            cert_path="/etc/letsencrypt/live/example.com/fullchain.pem",
            key_path="/etc/letsencrypt/live/example.com/privkey.pem",
            min_version="1.2",
            hSTS_seconds=31536000,
        ))
    """

    enabled: bool = True  # False = trust upstream TLS terminator
    cert_path: str | None = None  # required when enabled=True (PEM cert chain)
    key_path: str | None = None  # required when enabled=True (PEM private key)
    ca_path: str | None = None  # optional: client certificate CA for mTLS
    min_version: str = "1.2"  # "1.2" or "1.3" — no legacy TLS
    cipher_suites: tuple[str, ...] = ()  # empty = Python defaults (recommended)
    hSTS_seconds: int | None = None  # HSTS max-age; set for HTTPS-only domains
    trust_upstream_proxy: bool = True  # accept X-Forwarded-* headers from upstream
    verify_client_cert: bool = False  # require client cert when ca_path is set

    def build_ssl_context(self) -> ssl.SSLContext | None:
        """Build an ssl.SSLContext for HTTPS serve, or return None.

        Raises:
            FileNotFoundError: cert/key file missing.
            ValueError: misconfiguration (enabled=True but no cert_path, etc.).
        """
        if not self.enabled:
            return None

        if not self.cert_path or not self.key_path:
            raise ValueError(
                "TLSConfig: enabled=True requires cert_path and key_path. "
                "For upstream TLS termination set enabled=False."
            )

        # Load key + cert
        key_path = Path(self.key_path)
        cert_path = Path(self.cert_path)
        if not key_path.exists():
            raise FileNotFoundError(f"TLSConfig: key not found: {key_path}")
        if not cert_path.exists():
            raise FileNotFoundError(f"TLSConfig: cert not found: {cert_path}")

        # Build context
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(str(cert_path), str(key_path))

        # Enforce minimum TLS version
        min_tls = _MIN_TLS_VERSION.get(self.min_version, ssl.TLSVersion.TLSv1_2)
        ctx.minimum_version = min_tls

        # Cipher suites: use Python defaults if none specified
        if self.cipher_suites:
            ctx.set_ciphers(",".join(self.cipher_suites))

        # Client certificate verification (mTLS)
        if self.verify_client_cert and self.ca_path:
            ca_path = Path(self.ca_path)
            if not ca_path.exists():
                raise FileNotFoundError(f"TLSConfig: CA not found: {ca_path}")
            ctx.verify_mode = ssl.CERT_REQUIRED
            ctx.load_verify_locations(str(ca_path))
        elif self.verify_client_cert:
            ctx.verify_mode = ssl.CERT_REQUIRED

        # Security hardening
        ctx.session_cache = ssl.SSLContext.SESSION_CACHE_NO_AUTOFLUSH
        ctx.session_timeout = 3600  # 1 hour session tickets

        return ctx

    def upstream_headers(self, trusted: bool) -> dict[str, str]:
        """Return security headers to inject when trust_upstream_proxy=True."""
        headers: dict[str, str] = {}
        if self.hSTS_seconds is not None and self.enabled:
            headers["Strict-Transport-Security"] = f"max-age={self.hSTS_seconds}"
        if trusted and self.enabled:
            headers["X-Content-Type-Options"] = "nosniff"
            headers["X-Frame-Options"] = "DENY"
        return headers


@dataclass(frozen=True)
class GatewayConfig:
    workspace: str | Path
    agent_id: str = "default"
    dm_scope: str = "per-channel-peer"
    max_concurrent: int = 4
    subagent_concurrent: int = 8
    sandbox: SandboxConfig = SandboxConfig()
    gateway_token: str | None = None
    allowed_channels: tuple[str, ...] = ()
    denied_channels: tuple[str, ...] = ()
    outbound_allowed_channels: tuple[str, ...] = ()
    outbound_denied_channels: tuple[str, ...] = ()
    require_approval_for: tuple[str, ...] = ()
    auto_approve: bool = True
    # Approval timeout in seconds (0 = no timeout, defaults to 300s)
    approval_timeout_seconds: float = 300.0
    # TLS configuration (default: enabled=False for upstream proxy in production)
    tls: TLSConfig = field(default_factory=lambda: TLSConfig(enabled=False))


@dataclass(frozen=True)
class GatewayResponse:
    session: SessionRecord
    run: AgentRunResult
    delivered: bool


class Gateway:
    def __init__(
        self,
        config: GatewayConfig,
        *,
        runtime: AgentRuntime | None = None,
        memory: WorkspaceMemory | None = None,
        tool_registry: ToolRegistry | None = None,
        hooks: HookEngine | None = None,
        policy_engine: PolicyEngine | None = None,
    ) -> None:
        self.config = config
        self.tls = config.tls
        self.workspace = Path(config.workspace)
        self.workspace.mkdir(parents=True, exist_ok=True)
        self.memory = memory or WorkspaceMemory(self.workspace)
        self.memory.init()
        self.hooks = hooks or HookEngine()
        self.sessions = SessionManager(
            self.workspace,
            agent_id=config.agent_id,
            dm_scope=config.dm_scope,
        )
        self.queue = LaneAwareCommandQueue(
            max_concurrent=config.max_concurrent,
            subagent_concurrent=config.subagent_concurrent,
        )
        self.tools = tool_registry or ToolRegistry(ToolPolicy(default_allow=True))
        register_memory_tools(self.tools, self.memory)
        self.skills = SkillLoader(self.workspace)
        self.sandbox = SandboxManager(config.sandbox)
        self.nodes = NodeRegistry()
        self.trust = DeviceTrustStore(gateway_token=config.gateway_token)
        # Audit logger — writes structured JSON Lines to .openclaw/audit/audit.log
        self.audit = AuditLogger(self.workspace)
        self.policy = policy_engine or PolicyEngine(
            channel_policy=ChannelAllowlistPolicy(
                allowed_channels=set(config.allowed_channels),
                denied_channels=set(config.denied_channels),
            ),
            approval_policy=ApprovalPolicy(
                required_actions=set(config.require_approval_for),
                auto_approve=config.auto_approve,
            ),
            message_send_policy=MessageSendPolicy(
                allowed_channels=set(config.outbound_allowed_channels),
                denied_channels=set(config.outbound_denied_channels),
            ),
            tool_policy=self.tools.policy,
            trust_store=self.trust,
            sandbox_manager=self.sandbox,
            audit_logger=self.audit,
        )
        self.bridges: dict[str, ChannelBridge] = {"dict": DictChannelBridge("dict")}
        self.cron = CronScheduler()
        self.heartbeat = HeartbeatSystem()
        self.plugins = PluginManager(PluginContext(hooks=self.hooks, services={"gateway": self}))

        # ── Human-in-the-loop approval ──────────────────────────────────────
        self.approval_broker = ApprovalBroker(timeout_seconds=config.approval_timeout_seconds)
        # Optional: attach an approval server for webhook callbacks (start separately)
        self.approval_server: ApprovalServer | None = None

        self.runtime = runtime or AgentRuntime(
            model=EchoModelProvider(),
            prompt_assembler=PromptAssembler(
                self.workspace,
                memory=self.memory,
                tool_registry=self.tools,
                skill_loader=self.skills,
            ),
            tool_registry=self.tools,
            hooks=self.hooks,
            policy_engine=self.policy,
            sandbox_manager=self.sandbox,
            approval_broker=self.approval_broker,
        )
        if runtime is not None:
            self.runtime.policy_engine = self.policy
            self.runtime.sandbox_manager = self.sandbox
            self.runtime.approval_broker = self.approval_broker

        # ── Approval server for webhook callbacks ────────────────────────────
        # Subclass or call this after gateway creation:
        #   gateway.start_approval_server(host="127.0.0.1", port=8081)

    def configure_feishu_approval(
        self,
        bot_token: str,
        chat_id: str,
        approval_server_base: str = "http://127.0.0.1:8081",
    ) -> None:
        """Register a Feishu interactive card channel for human approvals.

        Args:
            bot_token: Feishu bot token (with im:message:send scope)
            chat_id:   Feishu chat_id or open_id to receive approval cards
            approval_server_base: Base URL of the approval webhook server
        """
        from .approval import FeishuApprovalChannel
        channel = FeishuApprovalChannel(
            bot_token=bot_token,
            chat_id=chat_id,
            approval_server_base=approval_server_base,
        )
        self.approval_broker.register_channel(channel)

    def configure_webhook_approval(
        self,
        webhook_url: str,
        headers: dict[str, str] | None = None,
    ) -> None:
        """Register a generic webhook channel for human approvals.

        The webhook receiver POSTs an approval request payload to this URL
        and the human approves via the included approve/deny URLs.
        """
        from .approval import WebhookApprovalChannel
        channel = WebhookApprovalChannel(webhook_url=webhook_url, headers=headers)
        self.approval_broker.register_channel(channel)

    def start_approval_server(self, host: str = "127.0.0.1", port: int = 8081) -> None:
        """Start a background thread serving approval resolution callbacks.

        Endpoints:
            GET /approval/{id}/approve → approve
            GET /approval/{id}/deny    → deny

        Call this once after gateway creation:
            gateway.start_approval_server()  # runs in background thread
        """
        from .approval import ApprovalServer
        self.approval_server = ApprovalServer(broker=self.approval_broker, host=host, port=port)
        import threading
        t = threading.Thread(target=self.approval_server.serve, daemon=True, name="approval-server")
        t.start()

    # Build SSL context if serving TLS directly
        self._ssl_context: ssl.SSLContext | None = None
        if self.tls.enabled:
            self._ssl_context = self.tls.build_ssl_context()
            if self._ssl_context is None:
                raise RuntimeError("TLSConfig.build_ssl_context() returned None unexpectedly")

    def ssl_context(self) -> ssl.SSLContext | None:
        """Return the SSL context for use with http.server or asyncio."""
        return self._ssl_context

    def server_headers(self) -> dict[str, str]:
        """Return security headers appropriate for the TLS configuration."""
        return self.tls.upstream_headers(trusted=self.tls.trust_upstream_proxy)

    def serve_http(
        self,
        host: str = "0.0.0.0",
        port: int = 8080,
        **kwargs: Any,
    ) -> None:
        """Start a synchronous HTTPS server using stdlib http.server.

        Requires:
            Python 3.7+ with http.server

        For production use (gunicorn + nginx/caddy) pass ssl_context directly:
            import ssl
            server = httpserver.HTTPServer((host, port), handler, ssl_context=gateway.ssl_context())

        Args:
            host: bind address
            port: bind port
            **kwargs: passed to HTTPServer (e.g. request_queue_size)
        """
        import http.server
        import json
        import socketserver

        # Dynamically create handler class so each instance gets a gateway ref
        # (can't easily pass self to BaseHTTPRequestHandler instance methods)
        ssl_context = self._ssl_context

        class _Handler(http.server.BaseHTTPRequestHandler):
            _gateway = self  # type: ignore[assignment]

            def do_POST(self) -> None:
                try:
                    body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                    resp = self._gateway.receive_native("dict", body)
                    self.send_response(200 if resp.delivered else 204)
                    self.send_header("Content-Type", "application/json")
                    for k, v in self._gateway.server_headers().items():
                        self.send_header(k, v)
                    self.end_headers()
                    self.wfile.write(json.dumps({"output": resp.run.output}).encode())
                except Exception as exc:
                    self.send_response(500)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps({"error": str(exc)}).encode())

            def log_message(self, format: str, *args: Any) -> None:
                # Structured request logging
                pass  # suppress noise; use gateway hooks for access logs

        # Patch in security headers (class-level works fine)
        _Handler.protocol_version = "HTTP/1.1"

        if ssl_context is None:
            raise RuntimeError(
                "TLS not configured: set gateway.config.tls.enabled=True and provide "
                "cert_path/key_path, or run behind an TLS-terminating proxy."
            )

        class _TLSServer(socketserver.TCPServer):
            allow_reuse_address = True

            def get_request(self) -> tuple[Any, Any]:
                sock, addr = self.socket.accept()
                try:
                    wrapped = ssl_context.wrap_socket(sock, server_side=True)
                    return wrapped, addr
                except ssl.SSLError:
                    sock.close()
                    raise

        server = _TLSServer((host, port), _Handler, **kwargs)
        print(f"HTTPS server listening on {host}:{port} (TLS 1.2/1.3)", file=sys.stderr)
        server.serve_forever()

    def authorize_connection(
        self,
        *,
        gateway_token: str | None,
        device_id: str | None = None,
        device_token: str | None = None,
    ):
        return self.policy.enforce_connection(
            gateway_token=gateway_token,
            device_id=device_id,
            device_token=device_token,
        )

    def register_bridge(self, bridge: ChannelBridge) -> None:
        self.bridges[bridge.name] = bridge

    def receive_native(self, channel: str, event: dict[str, object]) -> GatewayResponse:
        bridge = self.bridges[channel]
        return self.receive(bridge.normalize(event))

    def receive(self, message: InternalMessage) -> GatewayResponse:
        self.policy.enforce_inbound(message)
        self.hooks.emit("message_received", {"message": message})
        session = self.sessions.resolve_message(message)
        self.sessions.append_transcript(
            session,
            "user",
            message.text,
            metadata={"channel": message.channel, "messageId": message.message_id},
        )
        command = Command(session_key=session.session_key, payload=(session, message))
        response = self.queue.dispatch(command, self._run_message_command)
        self.hooks.emit("message_sent", {"message": message, "response": response})
        return response

    def run_heartbeat(self) -> str | None:
        return self.heartbeat.tick(lambda prompt: self._run_system_turn(prompt, heartbeat=True).run.output)

    def run_due_cron(self) -> list[str]:
        return self.cron.run_due(self._run_cron_job)

    def _run_message_command(self, command: Command[tuple[SessionRecord, InternalMessage]]) -> GatewayResponse:
        session, message = command.payload
        sandbox_plan = self.policy.sandbox_plan_for(session)
        self.hooks.emit("sandbox:plan", {"session": session, "plan": sandbox_plan})
        run = self.runtime.run(session, message.text)
        delivered = False
        if not run.no_reply:
            self.policy.enforce_message_send(session, run.output)
            delivered = True
        if delivered:
            self.sessions.append_transcript(session, "assistant", run.output, metadata={"runId": run.run_id})
        return GatewayResponse(session=session, run=run, delivered=delivered)

    def _run_system_turn(self, prompt: str, *, heartbeat: bool = False) -> GatewayResponse:
        message = InternalMessage(channel="system", peer_id="main", text=prompt)
        session = self.sessions.resolve_message(message)
        run = self.runtime.run(session, prompt, heartbeat=heartbeat)
        delivered = False
        if not run.no_reply:
            self.policy.enforce_message_send(session, run.output)
            delivered = True
        if delivered:
            self.sessions.append_transcript(session, "assistant", run.output, metadata={"runId": run.run_id})
        return GatewayResponse(session=session, run=run, delivered=delivered)

    def _run_cron_job(self, job: ScheduledJob) -> str:
        response = self._run_system_turn(job.prompt)
        return response.run.output
