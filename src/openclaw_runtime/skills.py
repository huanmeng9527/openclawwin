from __future__ import annotations

import os
import shutil
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class SkillMetadata:
    name: str
    description: str
    path: Path
    source: str

    def to_prompt_dict(self) -> dict[str, str]:
        return {
            "name": self.name,
            "description": self.description,
            "path": str(self.path),
            "source": self.source,
        }


class SkillLoader:
    def __init__(
        self,
        workspace: str | Path,
        *,
        managed_root: str | Path | None = None,
        bundled_root: str | Path | None = None,
    ) -> None:
        self.workspace = Path(workspace)
        self.roots = [
            ("workspace", self.workspace / "skills"),
            ("managed", Path(managed_root).expanduser() if managed_root else Path.home() / ".openclaw" / "skills"),
            ("bundled", Path(bundled_root).expanduser() if bundled_root else Path(__file__).parent / "skills"),
        ]

    def discover(self) -> list[SkillMetadata]:
        seen: set[str] = set()
        skills: list[SkillMetadata] = []
        for source, root in self.roots:
            if not root.exists():
                continue
            for skill_file in sorted(root.glob("*/SKILL.md")):
                metadata = self._read_metadata(skill_file, source)
                if metadata.name in seen or not self._requirements_met(skill_file):
                    continue
                seen.add(metadata.name)
                skills.append(metadata)
        return skills

    def _read_metadata(self, path: Path, source: str) -> SkillMetadata:
        text = path.read_text(encoding="utf-8")
        frontmatter = parse_frontmatter(text)
        name = frontmatter.get("name") or path.parent.name
        description = frontmatter.get("description") or first_non_heading_line(text)
        return SkillMetadata(name=name, description=description, path=path, source=source)

    def _requirements_met(self, path: Path) -> bool:
        frontmatter = parse_frontmatter(path.read_text(encoding="utf-8"))
        bins = split_csv(frontmatter.get("requires.bins", ""))
        envs = split_csv(frontmatter.get("requires.env", ""))
        os_names = split_csv(frontmatter.get("requires.os", ""))
        if any(shutil.which(binary) is None for binary in bins):
            return False
        if any(not os.environ.get(name) for name in envs):
            return False
        if os_names and os.name not in os_names:
            return False
        return True


def parse_frontmatter(text: str) -> dict[str, str]:
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}
    data: dict[str, str] = {}
    for line in lines[1:]:
        if line.strip() == "---":
            break
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        data[key.strip()] = value.strip().strip('"').strip("'")
    return data


def first_non_heading_line(text: str) -> str:
    for line in text.splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith("#") and stripped != "---":
            return stripped
    return ""


def split_csv(value: str) -> list[str]:
    return [part.strip() for part in value.split(",") if part.strip()]
