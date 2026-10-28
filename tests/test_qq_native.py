"""Native launcher must validate an independent QQ without starting it in checks."""

import os
import subprocess
import sys

import pytest


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS launcher")
def test_store_qq_is_rejected_before_open_or_account_changes(tmp_path):
    app = tmp_path / "QQ.app"
    receipt = app / "Contents/_MASReceipt/receipt"
    receipt.parent.mkdir(parents=True)
    receipt.write_bytes(b"fixture")
    fake_open = tmp_path / "open"
    fake_open.write_text("#!/bin/sh\nexit 99\n")
    fake_open.chmod(0o700)
    result = subprocess.run(
        ["bash", "scripts/start-qq-native.command", "--check"],
        env={
            **os.environ,
            "PATH": str(tmp_path) + os.pathsep + os.environ["PATH"],
            "DSWHALE_QQ_APP": str(app),
        },
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0
    assert "商店版" in result.stdout
    assert receipt.read_bytes() == b"fixture"


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS launcher")
def test_unsigned_pristine_qq_is_rejected_without_open(tmp_path):
    import json

    app = tmp_path / "QQ.app"
    package = app / "Contents/Resources/app/package.json"
    package.parent.mkdir(parents=True)
    package.write_text(json.dumps({"main": "./application.asar/app_launcher/index.js"}))
    fake_open = tmp_path / "open"
    fake_open.write_text("#!/bin/sh\nexit 99\n")
    fake_open.chmod(0o700)
    result = subprocess.run(
        ["bash", "scripts/start-qq-native.command", "--check"],
        env={
            **os.environ,
            "PATH": str(tmp_path) + os.pathsep + os.environ["PATH"],
            "DSWHALE_QQ_APP": str(app),
        },
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0
    assert "签名校验" in result.stdout


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS launcher")
def test_owner_launcher_never_accepts_external_napcat_loader(tmp_path):
    import json

    loader = tmp_path / "Library/Containers/com.tencent.qq/Data/Documents/loadNapCat.js"
    loader.parent.mkdir(parents=True)
    loader.write_text("const frameworkVersion = 'fixture';")
    app = tmp_path / "QQ.app"
    package = app / "Contents/Resources/app/package.json"
    package.parent.mkdir(parents=True)
    package.write_text(json.dumps({"main": str(loader)}))
    result = subprocess.run(
        ["bash", "scripts/start-qq-native.command", "--check"],
        env={**os.environ, "DSWHALE_QQ_APP": str(app)},
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0
    assert "NapCat" in result.stdout
