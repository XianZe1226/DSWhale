"""Independently verify bridge source inventory and exercise an installed bridge.

The expected inventory comes directly from Git, never staging eligibility or the
staging manifest. Bridge smoke data is synthetic, all outbound connections and
child commands are blocked, and captured host output is never printed.
"""

import argparse
import hashlib
import json
import os
import queue
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import zipfile
from pathlib import Path, PurePosixPath

BRIDGE = "dswhale/bili_bridge/"
AUDITED_PATH = BRIDGE + "upstream/lib/credentials.js"
AUDITED_SHA256 = "00905567a2661eddc429d2598eb4cb208ce7097541a662ffffd4945546e69ce8"
MAX_MEMBER_BYTES = 16 * 1024 * 1024
MAX_ARTIFACT_BYTES = 100 * 1024 * 1024


class ArtifactError(ValueError):
    pass


def _safe_path(name):
    path = PurePosixPath(name)
    if (
        not name
        or path.is_absolute()
        or ".." in path.parts
        or "\\" in name
        or ":" in name
        or "\0" in name
    ):
        raise ArtifactError("Unsafe artifact path")
    return path


def bridge_source_inventory(source: Path) -> dict[str, str]:
    """Every tracked bridge source is required; unsupported tracked state fails."""
    source = Path(source).resolve(strict=True)
    result = subprocess.run(
        ["git", "-C", str(source), "ls-files", "-z", "--", "dswhale/bili_bridge"],
        capture_output=True,
        check=True,
    )
    inventory = {}
    for name in result.stdout.decode("utf-8").split("\0"):
        if not name:
            continue
        path = _safe_path(name)
        # This is deliberately independent of stage_desktop. Tracked account
        # state in this source tree is itself a release-blocking error.
        private_parts = {
            "node_modules",
            "__pycache__",
            "data",
            "user-data",
            "userdata",
            "runtime",
            "secrets",
            "credentials",
            "cache",
            "logs",
            "backups",
        }
        if any(part.startswith(".") or part.lower() in private_parts for part in path.parts):
            raise ArtifactError("Private path in tracked bridge inventory")
        if name != AUDITED_PATH and path.name.lower().startswith(
            ("cookie", "credential", "token", "secret", "desktop-auth")
        ):
            raise ArtifactError("Private file in tracked bridge inventory")
        if (
            path.suffix.lower()
            not in {".js", ".mjs", ".cjs", ".json", ".html", ".css", ".md", ".txt"}
            and path.name != "LICENSE"
        ):
            raise ArtifactError("Unsupported tracked bridge source format")
        local = source / name
        if any(parent.is_symlink() for parent in [local, *local.parents] if parent != source):
            raise ArtifactError("Symlink in bridge source inventory")
        if not local.is_file():
            raise ArtifactError(f"Missing tracked bridge source: {name}")
        digest = hashlib.sha256(local.read_bytes()).hexdigest()
        if name == AUDITED_PATH and digest != AUDITED_SHA256:
            raise ArtifactError("Audited upstream source hash mismatch")
        inventory[name] = digest
    if not inventory or AUDITED_PATH not in inventory:
        raise ArtifactError("Audited upstream source missing from Git inventory")
    return inventory


def _bridge_member(name, *, sdist=False):
    path = _safe_path(name)
    if sdist:
        path = PurePosixPath(*path.parts[1:])
    normalized = path.as_posix()
    return normalized if normalized.startswith(BRIDGE) else None


def artifact_inventory(artifact: Path) -> dict[str, str]:
    artifact = Path(artifact)
    inventory = {}
    total = 0

    def add(name, data):
        nonlocal total
        if name in inventory:
            raise ArtifactError("Duplicate bridge artifact member")
        total += len(data)
        if len(data) > MAX_MEMBER_BYTES or total > MAX_ARTIFACT_BYTES:
            raise ArtifactError("Bridge artifact exceeds size limit")
        inventory[name] = hashlib.sha256(data).hexdigest()

    if artifact.is_dir():
        bridge = artifact / BRIDGE
        for local in sorted(bridge.rglob("*")):
            if local.is_symlink() or any(
                parent.is_symlink() for parent in local.parents if parent != artifact
            ):
                raise ArtifactError("Symlink in bridge artifact")
            if local.is_file():
                if local.stat().st_size > MAX_MEMBER_BYTES:
                    raise ArtifactError("Bridge artifact exceeds size limit")
                add(local.relative_to(artifact).as_posix(), local.read_bytes())
    elif artifact.name.endswith(".whl"):
        with zipfile.ZipFile(artifact) as archive:
            for member in archive.infolist():
                name = _bridge_member(member.filename)
                if name and not member.is_dir():
                    if (
                        stat.S_ISLNK(member.external_attr >> 16)
                        or member.file_size > MAX_MEMBER_BYTES
                    ):
                        raise ArtifactError("Unsafe bridge wheel member")
                    add(name, archive.read(member))
    elif artifact.name.endswith(".tar.gz"):
        with tarfile.open(artifact, "r:gz") as archive:
            for member in archive:
                name = _bridge_member(member.name, sdist=True)
                if name and not member.isdir():
                    if not member.isfile() or member.size > MAX_MEMBER_BYTES:
                        raise ArtifactError("Unsafe bridge source archive member")
                    with archive.extractfile(member) as stream:
                        add(name, stream.read(MAX_MEMBER_BYTES + 1))
    else:
        raise ArtifactError("Expected staged backend, wheel, or source tar.gz")
    return inventory


def verify_artifact(source: Path, artifact: Path) -> int:
    expected = bridge_source_inventory(source)
    actual = artifact_inventory(artifact)
    missing = sorted(expected.keys() - actual.keys())
    unexpected = sorted(actual.keys() - expected.keys())
    changed = sorted(
        name for name in expected.keys() & actual.keys() if expected[name] != actual[name]
    )
    if missing or unexpected or changed:
        issues = [
            f"{label}: {', '.join(names)}"
            for label, names in [
                ("missing", missing),
                ("unexpected", unexpected),
                ("changed", changed),
            ]
            if names
        ]
        raise ArtifactError("Bridge inventory mismatch; " + "; ".join(issues))
    return len(expected)


_OFFLINE_PRELOAD = """
const net = require('node:net'), http = require('node:http'), https = require('node:https');
const child = require('node:child_process');
let violated = false;
const denied = () => { violated = true; throw new Error('Offline bridge smoke denied external operation'); };
const exit = process.exit.bind(process);
process.exit = code => exit(violated ? 97 : code);
net.Socket.prototype.connect = denied;
http.request = http.get = https.request = https.get = denied;
globalThis.fetch = denied;
const probe = child.spawnSync;
for (const key of ['spawn','exec','execSync','execFile','execFileSync','fork']) child[key] = denied;
child.spawnSync = (file, args, options) => {
  const real = require('node:fs').realpathSync;
  if (real(file) === real(process.execPath) && args.length === 3 && args[0] === '-e'
      && args[1] === 'require("fs").writeFileSync(process.argv[1],process.versions.node)'
      && require('node:path').basename(args[2]) === 'proof') return probe(file, args, options);
  return denied();
};
require('node:dgram').createSocket = denied;
require('node:module').syncBuiltinESMExports();
"""


def smoke_bridge(bridge: Path, *, node=None, timeout=15) -> dict:
    """Start the real bridge entrypoint with no accounts, no network or commands."""
    bridge = Path(bridge).resolve(strict=True)
    executable = node or shutil.which("node")
    if not executable or not (bridge / "server.mjs").is_file():
        raise ArtifactError("Bridge smoke requires Node and the installed entrypoint")
    with tempfile.TemporaryDirectory(prefix="dswhale-bridge-smoke-") as temporary:
        home = Path(temporary)
        (home / ".dsh").mkdir()
        (home / ".dsh/bili-whale.config.json").write_text(
            json.dumps(
                {
                    "owner": {"mid": "", "name": ""},
                    "listen": {"comment": False, "dm": False, "live": False, "allDay": False},
                    "share": {"enabled": False, "via": "qq"},
                    "notify": {"type": "none"},
                    "night": {
                        "windows": [{"start": "00:00", "end": "00:00", "wakes": 0}],
                        "maxWakesPerDay": 0,
                        "skipChance": 0,
                        "minGapMin": 10,
                        "maxVideos": 1,
                    },
                    "quota": {"shareDaily": 0},
                }
            ),
            encoding="utf-8",
        )
        preload = home / "offline.cjs"
        preload.write_text(_OFFLINE_PRELOAD, encoding="utf-8")
        environment = {
            key: value
            for key, value in os.environ.items()
            if key.upper()
            in {"PATH", "SYSTEMROOT", "WINDIR", "PATHEXT", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH"}
        }
        environment.update(
            {
                "HOME": temporary,
                "USERPROFILE": temporary,
                "TMPDIR": temporary,
                "TMP": temporary,
                "TEMP": temporary,
                "DSWHALE_BILI_HOME": temporary,
                "DSWHALE_BILI_TOKEN": "synthetic-offline-smoke-token",
            }
        )
        packets = queue.Queue()
        child = subprocess.Popen(
            [str(executable), "--require", str(preload), str(bridge / "server.mjs")],
            cwd=home,
            env=environment,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )

        def read_packets():
            while line := child.stdout.readline(16385):
                if len(line) > 16384:
                    packets.put(None)
                    return
                try:
                    packets.put(json.loads(line))
                except (ValueError, UnicodeError):
                    packets.put(None)
                    return
            packets.put(None)

        reader = threading.Thread(target=read_packets, daemon=True)
        reader.start()
        result = None
        started = time.monotonic()
        try:
            packet = packets.get(timeout=min(timeout, 15))
            if (
                not isinstance(packet, dict)
                or packet.get("type") != "ready"
                or not isinstance(packet.get("port"), int)
                or not 1024 <= packet["port"] <= 65535
            ):
                raise ArtifactError("Bridge did not reach ready in isolated offline smoke")
            result = {"ready": True, "elapsedSeconds": round(time.monotonic() - started, 3)}
        except queue.Empty as error:
            raise ArtifactError("Bridge did not reach ready within 15 seconds") from error
        finally:
            child.stdin.close()
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                child.terminate()
                try:
                    child.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=2)
            reader.join(timeout=1)
            child.stdout.close()
        if child.returncode != 0:
            raise ArtifactError("Bridge failed isolated offline startup or shutdown")
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifacts", nargs="*", type=Path)
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--smoke", action="store_true")
    parser.add_argument("--installed-bridge", type=Path)
    parser.add_argument("--node")
    args = parser.parse_args()
    if not args.artifacts and not args.installed_bridge:
        parser.error("provide at least one artifact or installed bridge")
    try:
        for artifact in args.artifacts:
            count = verify_artifact(args.source, artifact)
            print(f"Verified {count} bridge source files in {artifact.name}")
            if args.smoke:
                if not artifact.is_dir():
                    raise ArtifactError("Smoke requires a staged or installed directory")
                print(json.dumps(smoke_bridge(artifact / BRIDGE, node=args.node)))
        if args.installed_bridge:
            print(json.dumps(smoke_bridge(args.installed_bridge, node=args.node)))
    except (
        ArtifactError,
        OSError,
        subprocess.SubprocessError,
        tarfile.TarError,
        zipfile.BadZipFile,
    ) as error:
        message = (
            str(error)
            if isinstance(error, ArtifactError)
            else "Artifact verification could not complete"
        )
        print(message, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
