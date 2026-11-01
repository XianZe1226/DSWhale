"""Release gates compare independent Git source inventory with real artifacts."""

import os
import shutil
import subprocess
import sys
import tarfile
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
BRIDGE = "dswhale/bili_bridge/"
CREDENTIALS = BRIDGE + "upstream/lib/credentials.js"


def source_fixture(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    for name in ["server.mjs", "upstream/lib/credentials.js", "upstream/LICENSE"]:
        target = source / BRIDGE / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / BRIDGE / name, target)
    subprocess.run(["git", "init", "-q", str(source)], check=True)
    subprocess.run(["git", "-C", str(source), "add", "dswhale"], check=True)
    return source


def verify(source, artifact):
    return subprocess.run(
        [sys.executable, "-m", "scripts.verify_artifact", "--source", str(source), str(artifact)],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )


@pytest.mark.parametrize("kind", ["stage", "wheel", "sdist"])
def test_gate_accepts_complete_inventory_then_rejects_deleted_audited_module(tmp_path, kind):
    source = source_fixture(tmp_path)
    staged = tmp_path / "staged"
    shutil.copytree(source / "dswhale", staged / "dswhale")

    def artifact():
        if kind == "stage":
            return staged
        target = tmp_path / (
            "dswhale-0.0.0-py3-none-any.whl" if kind == "wheel" else "dswhale-0.0.0.tar.gz"
        )
        if kind == "wheel":
            with zipfile.ZipFile(target, "w") as archive:
                for file in staged.rglob("*"):
                    if file.is_file():
                        archive.write(file, file.relative_to(staged).as_posix())
        else:
            with tarfile.open(target, "w:gz") as archive:
                archive.add(staged / "dswhale", arcname="dswhale-0.0.0/dswhale")
        return target

    result = verify(source, artifact())
    assert result.returncode == 0, "Complete source inventory must pass the artifact gate"
    (staged / CREDENTIALS).unlink()
    result = verify(source, artifact())
    assert result.returncode != 0
    assert "missing" in result.stderr.lower()
    assert CREDENTIALS in result.stderr


def test_gate_rejects_modified_and_untracked_private_bridge_material(tmp_path):
    source = source_fixture(tmp_path)
    staged = tmp_path / "staged"
    shutil.copytree(source / "dswhale", staged / "dswhale")
    (staged / BRIDGE / "server.mjs").write_text("different public code")
    result = verify(source, staged)
    assert result.returncode != 0
    assert "changed" in result.stderr.lower()
    shutil.copyfile(source / BRIDGE / "server.mjs", staged / BRIDGE / "server.mjs")
    (staged / BRIDGE / "credentials.json").write_text('{"synthetic":"private"}')
    result = verify(source, staged)
    assert result.returncode != 0
    assert "unexpected" in result.stderr.lower()
    assert "synthetic" not in result.stderr


def test_ready_smoke_starts_actual_bridge_installed_from_staged_backend(tmp_path):
    # This would fail on the release that dropped the imported credentials module.
    from scripts.stage_desktop import stage_backend

    stage = tmp_path / "backend"
    stage_backend(ROOT, stage)
    assert verify(ROOT, stage).returncode == 0
    installed_host = tmp_path / "installed-host"
    installed_host.mkdir()
    installer = subprocess.run(
        [
            sys.executable,
            "-c",
            "from pathlib import Path; from dswhale.install import install_plugin; import sys; install_plugin(Path(sys.argv[1]))",
            str(installed_host),
        ],
        cwd=installed_host,
        env={**os.environ, "PYTHONPATH": str(stage)},
        text=True,
        capture_output=True,
        check=False,
    )
    assert installer.returncode == 0
    installed = installed_host / "data/plugins/astrbot_plugin_dswhale/dswhale/bili_bridge"
    shutil.copytree(ROOT / BRIDGE / "node_modules", installed / "node_modules")
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "scripts.verify_artifact",
            "--node",
            shutil.which("node"),
            "--installed-bridge",
            str(installed),
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=25,
        check=False,
    )
    assert result.returncode == 0, "Actual isolated bridge must reach ready within 15 seconds"
    assert "ready" in result.stdout.lower()
    (installed / "upstream/lib/credentials.js").unlink()
    from scripts.verify_artifact import ArtifactError, smoke_bridge

    with pytest.raises(ArtifactError, match="[Bb]ridge"):
        smoke_bridge(installed, node=shutil.which("node"))


def test_ready_smoke_rejects_bridge_attempting_network_before_ready(tmp_path):
    from importlib.util import find_spec

    assert find_spec("scripts.verify_artifact") is not None
    from scripts.verify_artifact import ArtifactError, smoke_bridge

    entry = tmp_path / "server.mjs"
    entry.write_text("await fetch('https://example.invalid');")
    with pytest.raises(ArtifactError, match="[Bb]ridge"):
        smoke_bridge(tmp_path, node=shutil.which("node"))
