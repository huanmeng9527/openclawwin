from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Sequence

from .gateway import Gateway, GatewayConfig
from .messaging import InternalMessage


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not hasattr(args, "handler"):
        parser.print_help()
        return 2
    return args.handler(args)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="openclaw", description="Reference OpenClaw runtime.")
    subparsers = parser.add_subparsers(dest="command")

    init_parser = subparsers.add_parser("init", help="Create workspace memory/session layout.")
    add_workspace(init_parser)
    init_parser.set_defaults(handler=handle_init)

    send_parser = subparsers.add_parser("send", help="Send one normalized message through Gateway.")
    add_workspace(send_parser)
    send_parser.add_argument("text")
    send_parser.add_argument("--channel", default="cli")
    send_parser.add_argument("--peer", default="local")
    send_parser.add_argument("--group")
    send_parser.set_defaults(handler=handle_send)

    status_parser = subparsers.add_parser("status", help="Show minimal runtime status.")
    add_workspace(status_parser)
    status_parser.set_defaults(handler=handle_status)

    return parser


def add_workspace(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--workspace", default=".", help="Workspace path.")


def handle_init(args: argparse.Namespace) -> int:
    gateway = Gateway(GatewayConfig(workspace=args.workspace))
    print(json.dumps({"workspace": str(Path(args.workspace).resolve()), "status": "initialized"}, indent=2))
    gateway.memory.rebuild_index()
    return 0


def handle_send(args: argparse.Namespace) -> int:
    gateway = Gateway(GatewayConfig(workspace=args.workspace))
    response = gateway.receive(
        InternalMessage(
            channel=args.channel,
            peer_id=args.peer,
            group_id=args.group,
            text=args.text,
        )
    )
    print(
        json.dumps(
            {
                "sessionKey": response.session.session_key,
                "runId": response.run.run_id,
                "delivered": response.delivered,
                "output": response.run.output,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def handle_status(args: argparse.Namespace) -> int:
    gateway = Gateway(GatewayConfig(workspace=args.workspace))
    print(json.dumps(gateway.memory.stats(), ensure_ascii=False, indent=2))
    return 0
