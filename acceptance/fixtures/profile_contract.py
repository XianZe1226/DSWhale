"""Pure contracts for synthetic SDK storage acceptance; imports no SDK."""

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

MARKER = "SYNTHETIC-DEVICE-DATA-NOT-AN-ACCOUNT"
SCENARIOS = ("small-only", "official-only", "dual-enabled", "fresh-unconfigured")
PERSONAS = [
    {
        "persona_id": "synthetic-persona-a",
        "system_prompt": "Synthetic persona A for acceptance only.",
        "begin_dialogs": [],
        "tools": None,
        "skills": None,
        "custom_error_message": None,
    },
    {
        "persona_id": "synthetic-persona-b",
        "system_prompt": "合成验收人格B，不是真实用户。",
        "begin_dialogs": ["synthetic hello"],
        "tools": [],
        "skills": [],
        "custom_error_message": "",
    },
]
MEMORIES = [
    ("synthetic acceptance memory one", "synthetic-persona-a"),
    ("synthetic acceptance memory two", "synthetic-persona-b"),
]


def canonical(value):
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
    )


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def assert_same(before, after):
    if canonical(before) != canonical(after):
        error = ValueError("synthetic semantic snapshot changed; values withheld")
        error.code = "SNAPSHOT_CHANGED"
        error.fields = sorted(
            key
            for key in set(before) | set(after)
            if canonical(before.get(key)) != canonical(after.get(key))
        )
        raise error


def protect(value):
    if isinstance(value, list):
        return [protect(item) for item in value]
    if isinstance(value, dict):
        return {
            key: {"sha256": digest(item)}
            if key.lower() in {"key", "secret", "token", "ws_reverse_token", "onebottoken"}
            else protect(item)
            for key, item in value.items()
        }
    return value


def authorize_paths(root, host, baseline, output, scenario):
    root, host, baseline, output = map(Path, (root, host, baseline, output))
    if (
        scenario not in SCENARIOS
        or not root.is_absolute()
        or root.absolute() != root.resolve(strict=True)
    ):
        raise ValueError("invalid synthetic acceptance root")
    if not root.name.startswith("a12-sdk-") or (
        hasattr(os, "getuid") and root.stat().st_uid != os.getuid()
    ):
        raise ValueError("root must be owned synthetic acceptance directory")
    sentinel = root / "synthetic-root.json"
    if not sentinel.is_file() or sentinel.is_symlink():
        raise ValueError("explicit synthetic-root manifest is required")
    manifest = json.loads(sentinel.read_text())
    if manifest != {"kind": "DSWhaleSyntheticAcceptance", "scenario": scenario}:
        raise ValueError("synthetic-root manifest mismatch")
    if (
        host != root / "profile/runtime/astrbot"
        or not host.is_dir()
        or host.absolute() != host.resolve()
    ):
        raise ValueError("host is outside the explicit synthetic runtime")
    protected = [
        host / name
        for name in (
            "data",
            "data/config",
            "data/plugins",
            "data/plugin_data",
            "data/cmd_config.json",
            "data/data_v4.db",
            "data/data_v4.db-wal",
            "data/data_v4.db-shm",
            "data/synthetic-device-marker.txt",
        )
    ]

    def contained(candidate):
        current = candidate
        while current != root:
            if current.is_symlink():
                raise ValueError("synthetic SDK data paths must not contain links")
            current = current.parent
        if not candidate.resolve().is_relative_to(root):
            raise ValueError("synthetic SDK data escaped the run root")

    for candidate in protected:
        contained(candidate)
    for directory in (host / "data/config", host / "data/plugin_data"):
        if directory.exists():
            for candidate in directory.rglob("*"):
                contained(candidate)
    for file in (baseline, output):
        if file.parent != root or file.is_symlink() or file.absolute() != file.resolve():
            raise ValueError("fixture output must be a direct safe child of the run root")


def ensure_marker(data, *, seed):
    file = Path(data) / "synthetic-device-marker.txt"
    if seed:
        with file.open("x", encoding="utf-8") as stream:
            stream.write(MARKER)
    value = file.read_text(encoding="utf-8")
    if value != MARKER:
        raise ValueError("synthetic device marker changed")
    return value


def require_existing_storage(host):
    paths = [
        "data/data_v4.db",
        "data/cmd_config.json",
        "data/synthetic-device-marker.txt",
        "data/plugin_data/astrbot_plugin_livingmemory/livingmemory.db",
        "data/plugin_data/astrbot_plugin_livingmemory/livingmemory.index",
    ]
    for name in paths:
        file = Path(host) / name
        if not file.is_file() or file.is_symlink() or file.stat().st_size == 0:
            raise FileNotFoundError("required synthetic storage missing: " + name)


def validate_index(index, documents, retrieved_ids):
    ids = [d["id"] for d in documents]
    if index.get("dimension") != 8 or index.get("count") != 2 or len(documents) != 2:
        raise ValueError("nonempty FAISS index dimension/count mismatch")
    if sorted(index.get("ids", [])) != sorted(ids) or set(retrieved_ids) != {
        d["doc_id"] for d in documents
    }:
        raise ValueError("FAISS IDs/direct retrieval do not cover the document store")


def validate_records(snapshot):
    personas, conversations, docs = (
        snapshot.get(k, []) for k in ("personas", "conversations", "documents")
    )
    if len(personas) != 2 or len(conversations) != 2 or len(docs) != 2:
        raise ValueError("fixture requires exactly two personas, conversations and memories")
    if sorted(personas, key=lambda p: p["persona_id"]) != PERSONAS:
        raise ValueError("persona content/nullable fields differ from independent seed literals")
    expected = {
        "synthetic-conversation-a": (
            "synthetic-persona-a",
            "synthetic-small",
            "synthetic conversation one",
        ),
        "synthetic-conversation-b": (
            "synthetic-persona-b",
            "synthetic-official",
            "synthetic conversation two",
        ),
    }
    for c in conversations:
        pid, platform, content = expected.get(c.get("conversation_id"), (None, None, None))
        if (
            c.get("persona_id") != pid
            or c.get("platform_id") != platform
            or c.get("user_id") != "synthetic-user"
            or c.get("content") != [{"role": "user", "content": content}]
        ):
            raise ValueError("conversation identity/content mismatch")
    if len({c["conversation_id"] for c in conversations}) != 2:
        raise ValueError("conversation IDs are not unique")
    if {(d.get("text"), d.get("metadata", {}).get("persona_id")) for d in docs} != set(MEMORIES):
        raise ValueError("memory body/persona associations mismatch")


def validate_scenario(snapshot, scenario):
    platforms = {p["id"]: p for p in snapshot["platforms"]}
    small = scenario in ("small-only", "dual-enabled")
    official = scenario in ("official-only", "dual-enabled")
    if small and platforms.get("synthetic-small", {}).get("enable") is not True:
        raise ValueError("small platform must remain enabled")
    if official and platforms.get("synthetic-official", {}).get("enable") is not True:
        raise ValueError("official platform must remain enabled")
    if (
        scenario == "official-only"
        and platforms.get("synthetic-small", {}).get("enable") is not False
    ):
        raise ValueError("OneBot must remain explicitly disabled")
    if scenario == "fresh-unconfigured" and platforms:
        raise ValueError("fresh fixture must not acquire a platform")
    settings = snapshot["settings"]
    if settings["napcatBound"] is not small or settings["officialBound"] is not official:
        raise ValueError("owner bindings do not match the scenario")
    expected = "official" if official else "napcat" if small else ""
    if settings["defaultDelivery"] != expected:
        raise ValueError("default delivery does not match scenario")
    if snapshot["agent_runner"]["config"]["model"]["provider_id"] != "synthetic-model":
        raise ValueError("selected model reference changed")


def allowed_windows_acl_process(args, data_root, executable, script):
    """Allow only the pinned product ACL command targeting existing synthetic data."""
    try:
        actual_exe, command, cwd, env = args
        expected = [executable, "-NoProfile", "-NonInteractive", "-Command", script]
        if not isinstance(env, dict) or any(not isinstance(key, str) for key in env):
            return False
        names = [key.upper() for key in env]
        if len(names) != len(set(names)) or "PSMODULEPATH" in names:
            return False
        if actual_exe is not None and os.path.normcase(actual_exe) != os.path.normcase(executable):
            return False
        if command != expected and command != subprocess.list2cmdline(expected):
            return False
        root = Path(data_root)
        if root.is_symlink() or root.absolute() != root.resolve(strict=True):
            return False
        target = Path(env["DSWHALE_PRIVATE_PATH"])
        if not target.is_absolute() or not target.is_relative_to(root):
            return False
        for candidate in [target, *target.parents]:
            if candidate.is_symlink() or candidate.absolute() != candidate.resolve(strict=True):
                return False
            if candidate == root:
                break
        if cwd is not None and not Path(cwd).resolve(strict=True).is_relative_to(root):
            return False
        return True
    except (OSError, ValueError, TypeError, KeyError):
        return False


def deny_fixture_network(*, data_root=None):
    """Deny Python networking/children except the exact owned-data Windows ACL command."""
    state = {
        "mode": "python-audit-no-network-with-owned-windows-acl-only",
        "blocked": 0,
        "allowedWindowsAclProcesses": 0,
    }

    def audit(event, args):
        if event == "subprocess.Popen" and os.name == "nt" and data_root is not None:
            # Imported lazily under the active guard from the fixed installed backend.
            from dswhale.private_files import _windows_acl_script

            executable = str(
                Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
            )
            if allowed_windows_acl_process(args, data_root, executable, _windows_acl_script()):
                state["allowedWindowsAclProcesses"] += 1
                return
        if event in {
            "socket.connect",
            "socket.getaddrinfo",
            "socket.bind",
            "subprocess.Popen",
            "os.system",
            "os.posix_spawn",
            "os.exec",
        }:
            state["blocked"] += 1
            raise PermissionError(
                "synthetic SDK storage fixture forbids network/unapproved children"
            )

    sys.addaudithook(audit)
    try:
        sys.audit("socket.connect", None, ("192.0.2.1", 443))
    except PermissionError:
        state["probeBlocked"] = True
    if not state.get("probeBlocked"):
        raise RuntimeError("fixture network guard failed its audit-event probe")
    return state
