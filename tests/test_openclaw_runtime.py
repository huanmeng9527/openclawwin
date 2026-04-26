from __future__ import annotations

import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from openclaw_memory import WorkspaceMemory
from openclaw_runtime.agent import ModelOutput, ToolCall
from openclaw_runtime.gateway import Gateway, GatewayConfig
from openclaw_runtime.messaging import InternalMessage
from openclaw_runtime.policies import ApprovalRequired, PolicyDenied
from openclaw_runtime.protocol import request_frame, validate_request_frame
from openclaw_runtime.scheduler import CronScheduler, HeartbeatSystem
from openclaw_runtime.security import DeviceTrustStore
from openclaw_runtime.skills import SkillLoader
from openclaw_runtime.tools import Tool, ToolPolicy, ToolRegistry


class CaptureModel:
    def __init__(self, output: ModelOutput | None = None) -> None:
        self.output = output or ModelOutput("captured")
        self.system_prompts: list[str] = []

    def generate(self, *, system: str, user_text: str, session) -> ModelOutput:
        self.system_prompts.append(system)
        return self.output


class OpenClawRuntimeTests(unittest.TestCase):
    def test_gateway_routes_messages_and_keeps_private_memory_out_of_groups(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            (workspace / "MEMORY.md").write_text("- O(c=0.90) Private preference.\n", encoding="utf-8")
            gateway = Gateway(GatewayConfig(workspace=workspace))
            model = CaptureModel(ModelOutput("hello"))
            gateway.runtime.model = model

            private_response = gateway.receive(
                InternalMessage(channel="telegram", peer_id="alice", text="hello")
            )
            group_response = gateway.receive(
                InternalMessage(channel="telegram", peer_id="alice", group_id="team", text="hello")
            )

            self.assertTrue(private_response.delivered)
            self.assertIn("agent:default:telegram:dm:alice", private_response.session.session_key)
            self.assertIn("agent:default:telegram:group:team", group_response.session.session_key)
            self.assertIn("Private preference", model.system_prompts[0])
            self.assertNotIn("Private preference", model.system_prompts[1])
            transcript = gateway.sessions.read_transcript(private_response.session)
            self.assertEqual([item["role"] for item in transcript], ["user", "assistant"])

    def test_tool_policy_denies_before_allows_and_runtime_executes_tool_calls(self) -> None:
        registry = ToolRegistry(
            ToolPolicy(
                global_deny={"danger"},
                global_allow={"memory_search", "danger"},
                default_allow=False,
            )
        )
        registry.register(Tool("danger", "dangerous", lambda args: "nope"))
        registry.register(Tool("memory_search", "search", lambda args: [{"ok": True}]))

        self.assertFalse(registry.policy.allowed("danger"))
        self.assertTrue(registry.policy.allowed("memory_search"))
        with self.assertRaises(PermissionError):
            registry.call("danger", {})

    def test_skills_are_lazy_metadata_not_full_prompt_body(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            skill_dir = Path(directory) / "skills" / "demo"
            skill_dir.mkdir(parents=True)
            (skill_dir / "SKILL.md").write_text(
                "---\nname: demo\ndescription: Demo skill\n---\n# Demo\nLong private instructions.\n",
                encoding="utf-8",
            )

            skills = SkillLoader(directory).discover()

            self.assertEqual(skills[0].name, "demo")
            self.assertEqual(skills[0].description, "Demo skill")
            self.assertNotIn("Long private instructions", skills[0].to_prompt_dict()["description"])

    def test_websocket_protocol_requires_idempotency_for_side_effects(self) -> None:
        validate_request_frame(request_frame("1", "status"))
        with self.assertRaises(ValueError):
            validate_request_frame(request_frame("2", "agent", {"text": "hi"}))
        validate_request_frame(request_frame("3", "agent", {"text": "hi"}, idempotency_key="once"))

    def test_policy_engine_blocks_non_allowlisted_inbound_channels(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            gateway = Gateway(GatewayConfig(workspace=directory, allowed_channels=("telegram",)))

            response = gateway.receive(InternalMessage(channel="telegram", peer_id="alice", text="hello"))
            with self.assertRaises(PolicyDenied) as denied:
                gateway.receive(InternalMessage(channel="discord", peer_id="alice", text="hello"))

            self.assertTrue(response.delivered)
            self.assertEqual(denied.exception.decision.layer, "channel")

    def test_policy_engine_requires_approval_before_tool_execution(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            gateway = Gateway(
                GatewayConfig(
                    workspace=directory,
                    require_approval_for=("tool.call",),
                    auto_approve=False,
                )
            )
            gateway.runtime.model = CaptureModel(
                ModelOutput(
                    "done",
                    tool_calls=(ToolCall("memory_search", {"query": "anything", "limit": 1}),),
                )
            )
            message = InternalMessage(channel="telegram", peer_id="alice", text="search memory")

            with self.assertRaises(ApprovalRequired) as required:
                gateway.receive(message)

            approval_id = required.exception.decision.approval_id
            self.assertIsNotNone(approval_id)
            gateway.policy.approval_policy.approve(str(approval_id))
            response = gateway.receive(message)

            self.assertTrue(response.delivered)
            self.assertIn("[tool:memory_search]", response.run.output)

    def test_policy_engine_blocks_outbound_message_channels(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            gateway = Gateway(
                GatewayConfig(
                    workspace=directory,
                    outbound_denied_channels=("telegram",),
                )
            )
            gateway.runtime.model = CaptureModel(ModelOutput("do not send"))

            with self.assertRaises(PolicyDenied) as denied:
                gateway.receive(InternalMessage(channel="telegram", peer_id="alice", text="hello"))

            self.assertEqual(denied.exception.decision.layer, "message")

    def test_policy_engine_connects_gateway_and_device_trust(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            gateway = Gateway(GatewayConfig(workspace=directory, gateway_token="secret"))
            device_token = gateway.trust.pair_device("phone", "node", auto_trust=True)

            with self.assertRaises(PolicyDenied):
                gateway.authorize_connection(gateway_token="wrong")
            with self.assertRaises(PolicyDenied):
                gateway.authorize_connection(gateway_token="secret", device_id="phone", device_token="bad")

            decision = gateway.authorize_connection(
                gateway_token="secret",
                device_id="phone",
                device_token=device_token,
            )
            self.assertTrue(decision.allowed)

    def test_cron_heartbeat_device_trust_and_memory_tool_smoke(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            memory = WorkspaceMemory(directory)
            memory.retain("Runtime smoke remembers @OpenClaw.", kind="S", entities=["OpenClaw"], day="2026-04-25")
            memory.rebuild_index()
            registry = ToolRegistry(ToolPolicy(global_allow={"memory_search"}, default_allow=False))
            from openclaw_runtime.tools import register_memory_tools

            register_memory_tools(registry, memory)
            self.assertEqual(registry.call("memory_search", {"query": "Runtime smoke", "limit": 1})[0]["entities"], ["OpenClaw"])

            heartbeat = HeartbeatSystem("heartbeat")
            output = heartbeat.tick(lambda prompt: "HEARTBEAT_OK", now=datetime.now(timezone.utc) + timedelta(hours=1))
            self.assertIsNone(output)

            cron = CronScheduler()
            cron.add_at("run once", datetime.now(timezone.utc) - timedelta(seconds=1), job_id="job")
            self.assertEqual(cron.run_due(lambda job: job.prompt), ["run once"])

            trust = DeviceTrustStore(gateway_token="secret")
            token = trust.pair_device("phone", "node", auto_trust=True)
            self.assertTrue(trust.authenticate_gateway("secret"))
            self.assertTrue(trust.verify_device("phone", token))


if __name__ == "__main__":
    unittest.main()
