"""Release metadata binds exact official installers to a separate Ed25519 key."""

import hashlib
import json
import subprocess
import sys
from pathlib import Path

import pytest

try:
    from scripts import release_manifest
except ImportError:
    release_manifest = None


def require_module():
    assert release_manifest is not None, "release manifest publisher must exist"
    return release_manifest


def asset_folder(tmp_path, version="0.3.0-alpha.3"):
    folder = tmp_path / "assets"
    folder.mkdir()
    for suffix in ("Windows-x86_64-setup.exe", "macOS-arm64.dmg", "Linux-x86_64.deb"):
        (folder / f"DSWhale-{version}-{suffix}").write_bytes(b"installer fixture")
    return folder


def keypair(tmp_path):
    key = tmp_path / "private-test-key.pem"
    public = tmp_path / "public-test-key.pem"
    subprocess.run(
        [
            "node",
            "-e",
            "const c=require('node:crypto'),f=require('node:fs');const k=c.generateKeyPairSync('ed25519');f.writeFileSync(process.argv[1],k.privateKey.export({format:'pem',type:'pkcs8'}),{mode:0o600});f.writeFileSync(process.argv[2],k.publicKey.export({format:'pem',type:'spki'}));",
            str(key),
            str(public),
        ],
        check=True,
        capture_output=True,
    )
    return key, public


def trust_file(tmp_path, public):
    trust = tmp_path / "test-trust.json"
    trust.write_text(
        json.dumps(
            {
                "repository": "XianZe1226/DSWhale",
                "algorithm": "ed25519",
                "publicKey": public.read_text(),
            }
        )
    )
    return trust


def test_publisher_binds_platform_assets_hashes_and_normalized_version(tmp_path):
    module = require_module()
    folder = asset_folder(tmp_path)
    manifest = module.build_manifest(
        folder, version="0.3.0a3", npm_version="0.3.0-alpha.3", commit="a" * 40
    )
    assert manifest["channel"] == "alpha"
    assert manifest["tag"] == "v0.3.0a3"
    assert set(manifest["assets"]) == {"win32-x64", "darwin-arm64", "linux-x64"}
    asset = manifest["assets"]["darwin-arm64"]
    assert asset["name"] == "DSWhale-0.3.0-alpha.3-macOS-arm64.dmg"
    assert (
        asset["url"]
        == "https://github.com/XianZe1226/DSWhale/releases/download/v0.3.0a3/DSWhale-0.3.0-alpha.3-macOS-arm64.dmg"
    )
    assert asset["size"] == 17
    assert asset["sha256"] == hashlib.sha256(b"installer fixture").hexdigest()


def test_cli_signs_exact_manifest_bytes_and_never_prints_private_key(tmp_path):
    require_module()
    folder = asset_folder(tmp_path)
    key, public = keypair(tmp_path)
    trust = trust_file(tmp_path, public)
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "scripts.release_manifest",
            "--assets",
            str(folder),
            "--key",
            str(key),
            "--trust",
            str(trust),
            "--version",
            "0.3.0a3",
            "--npm-version",
            "0.3.0-alpha.3",
            "--commit",
            "a" * 40,
        ],
        cwd=Path(__file__).resolve().parents[1],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert "PRIVATE KEY" not in result.stdout + result.stderr
    assert str(key) not in result.stdout + result.stderr
    raw = (folder / "release-manifest.json").read_bytes()
    signature = folder / "release-manifest.sig"
    assert len(signature.read_bytes()) == 64
    verify = subprocess.run(
        [
            "node",
            "-e",
            "const u=require('./desktop/lib/app-updater.cjs'),f=require('node:fs');const v=u.verifyManifest(f.readFileSync(process.argv[2]),f.readFileSync(process.argv[3]),{trust:JSON.parse(f.readFileSync(process.argv[1],'utf8'))});process.exit(v.version==='0.3.0a3'?0:1);",
            str(trust),
            str(folder / "release-manifest.json"),
            str(signature),
        ],
        cwd=Path(__file__).resolve().parents[1],
        capture_output=True,
    )
    assert verify.returncode == 0
    assert json.loads(raw)["version"] == "0.3.0a3"


@pytest.mark.parametrize(
    "version,npm,commit",
    [
        ("0.3.0a3", "0.3.0-alpha.2", "a" * 40),
        ("../secret", "0.3.0-alpha.3", "a" * 40),
        ("0.3.0a3", "0.3.0-alpha.3", "HEAD"),
    ],
)
def test_publisher_rejects_inconsistent_metadata(tmp_path, version, npm, commit):
    module = require_module()
    folder = asset_folder(tmp_path)
    with pytest.raises(ValueError):
        module.build_manifest(folder, version=version, npm_version=npm, commit=commit)


def test_publisher_rejects_missing_or_symlink_installers(tmp_path):
    module = require_module()
    folder = asset_folder(tmp_path)
    asset = folder / "DSWhale-0.3.0-alpha.3-macOS-arm64.dmg"
    asset.unlink()
    with pytest.raises(ValueError):
        module.build_manifest(
            folder, version="0.3.0a3", npm_version="0.3.0-alpha.3", commit="a" * 40
        )
    external = tmp_path / "outside"
    external.write_bytes(b"private fixture")
    asset.symlink_to(external)
    with pytest.raises(ValueError):
        module.build_manifest(
            folder, version="0.3.0a3", npm_version="0.3.0-alpha.3", commit="a" * 40
        )


def test_invalid_signing_key_leaves_no_published_manifest_and_no_secret_output(tmp_path):
    require_module()
    folder = asset_folder(tmp_path)
    key = tmp_path / "private.key"
    key.write_text("PRIVATE_FIXTURE invalid key")
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "scripts.release_manifest",
            "--assets",
            str(folder),
            "--key",
            str(key),
            "--version",
            "0.3.0a3",
            "--npm-version",
            "0.3.0-alpha.3",
            "--commit",
            "a" * 40,
        ],
        cwd=Path(__file__).resolve().parents[1],
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0
    assert not (folder / "release-manifest.json").exists()
    assert not (folder / "release-manifest.sig").exists()
    assert "PRIVATE_FIXTURE" not in result.stdout + result.stderr
    assert str(key) not in result.stdout + result.stderr


def test_signing_rejects_a_key_that_does_not_match_embedded_release_trust(tmp_path):
    module = require_module()
    key, _ = keypair(tmp_path)
    with pytest.raises(ValueError, match="sign"):
        module.sign_manifest(b"public metadata", key)


def test_publisher_rejects_versions_that_cannot_be_compared_by_the_desktop(tmp_path):
    module = require_module()
    folder = asset_folder(tmp_path)
    huge = "999999999999999999999999999.0.0"
    with pytest.raises(ValueError, match="version"):
        module.build_manifest(folder, version=huge, npm_version=huge, commit="a" * 40)


def test_private_signing_key_cannot_be_published_inside_the_installer_folder(tmp_path):
    module = require_module()
    folder = asset_folder(tmp_path)
    key, public = keypair(folder)
    trust = trust_file(tmp_path, public)
    with pytest.raises(ValueError, match="key"):
        module.publish_manifest(
            folder,
            key=key,
            trust=trust,
            version="0.3.0a3",
            npm_version="0.3.0-alpha.3",
            commit="a" * 40,
        )
