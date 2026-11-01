"""Create signed desktop release metadata; the private signing key stays local.

Usage: python -m scripts.release_manifest --assets desktop-dist --key /secure/key.pem
       --version 0.3.0a3 --npm-version 0.3.0-alpha.3 --commit <full-commit>

Requires Node.js (already required for the desktop build). Outputs
release-manifest.json and its raw, 64-byte Ed25519 release-manifest.sig. This
authenticates release metadata; it is not OS code signing or notarization.
Upload both files alongside the exact three installers to the v<version> release.
The a2 app has no updater; install a3 manually first. Future in-app upgrades
require a signed manifest and installer for the running version as rollback media.
"""

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

REPOSITORY = "XianZe1226/DSWhale"
MAX_INSTALLER_BYTES = 4 * 1024**3
SUFFIXES = {
    "win32-x64": "Windows-x86_64-setup.exe",
    "darwin-arm64": "macOS-arm64.dmg",
    "linux-x64": "Linux-x86_64.deb",
}
MINIMUM_OS = {
    "win32": "10.0.19045",
    "darwin": "13.0",
    "linux": ["ubuntu:22.04", "ubuntu:24.04"],
}
RUNTIME = {"astrbot": "4.29.3", "python": "3.12", "node": "22.23.4", "ffmpeg": "9.0.2"}
DEFAULT_TRUST = Path(__file__).resolve().parents[1] / "desktop/lib/release-trust.json"


def build_manifest(assets, *, version, npm_version, commit, impact=None):
    """Bind only fixed official release URLs to regular, nonempty installer files."""
    match = re.fullmatch(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:a(0|[1-9]\d*))?", version)
    if (
        not match
        or len(version) > 64
        or any(int(part) > 9007199254740991 for part in match.groups() if part is not None)
        or npm_version != re.sub(r"a(\d+)$", r"-alpha.\1", version)
    ):
        raise ValueError("Release versions do not match")
    if not re.fullmatch(r"[a-f0-9]{40}", commit):
        raise ValueError("A full release commit is required")
    flags = {
        "runtime": True,
        "dataMigration": False,
        "configuration": False,
        "rollbackCompatible": True,
    }
    if impact is not None:
        if (
            not isinstance(impact, dict)
            or set(impact) != set(flags)
            or any(type(v) is not bool for v in impact.values())
        ):
            raise ValueError("Invalid release impact flags")
        flags = dict(impact)
    folder = Path(assets)
    if folder.is_symlink() or not folder.is_dir():
        raise ValueError("Installer folder must be a regular directory")
    manifest_assets = {}
    for platform, suffix in SUFFIXES.items():
        name = f"DSWhale-{npm_version}-{suffix}"
        file = folder / name
        if file.is_symlink() or not file.is_file():
            raise ValueError("A required regular installer is missing")
        size = file.stat().st_size
        if not 0 < size <= MAX_INSTALLER_BYTES:
            raise ValueError("Installer size is outside release limits")
        digest = hashlib.sha256()
        with file.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        if file.stat().st_size != size:
            raise ValueError("Installer changed while preparing the manifest")
        manifest_assets[platform] = {
            "name": name,
            "url": f"https://github.com/{REPOSITORY}/releases/download/v{version}/{name}",
            "size": size,
            "sha256": digest.hexdigest(),
        }
    return {
        "schemaVersion": 1,
        "product": "DSWhale",
        "repository": REPOSITORY,
        "version": version,
        "npmVersion": npm_version,
        "channel": "alpha" if match[4] is not None else "stable",
        "tag": f"v{version}",
        "commit": commit,
        "minimumOS": MINIMUM_OS,
        "runtime": RUNTIME,
        "impact": flags,
        "assets": manifest_assets,
    }


def sign_manifest(manifest_bytes, key, *, trust=DEFAULT_TRUST):
    """Keep key material in Node's crypto process; never expose dependency errors."""
    script = """
const fs = require('node:fs'), crypto = require('node:crypto');
try {
  const key = crypto.createPrivateKey(fs.readFileSync(process.argv[1]));
  if (key.asymmetricKeyType !== 'ed25519') process.exit(2);
  const trust = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  if (trust.repository !== 'XianZe1226/DSWhale' || trust.algorithm !== 'ed25519') process.exit(2);
  const publicKey = crypto.createPublicKey(trust.publicKey);
  const bytes = fs.readFileSync(0), signature = crypto.sign(null, bytes, key);
  if (signature.length !== 64) process.exit(2);
  if (publicKey.asymmetricKeyType !== 'ed25519' || !crypto.verify(null, bytes, publicKey, signature)) process.exit(2);
  process.stdout.write(signature);
} catch { process.exit(2); }
"""
    try:
        result = subprocess.run(
            ["node", "-e", script, str(Path(key)), str(Path(trust))],
            input=manifest_bytes,
            capture_output=True,
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise ValueError("Release signing could not run") from error
    if result.returncode != 0 or len(result.stdout) != 64:
        raise ValueError("Release signing failed; check the local Ed25519 key")
    return result.stdout


def publish_manifest(
    assets, *, key, version, npm_version, commit, impact=None, trust=DEFAULT_TRUST
):
    key_path = Path(key).resolve()
    if key_path.is_relative_to(Path(assets).resolve()) or key_path.is_relative_to(
        Path(__file__).resolve().parents[1]
    ):
        raise ValueError("The signing key must stay outside source and release folders")
    manifest = build_manifest(
        assets, version=version, npm_version=npm_version, commit=commit, impact=impact
    )
    raw = (
        json.dumps(manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n"
    ).encode("utf-8")
    signature = sign_manifest(raw, key, trust=trust)
    folder = Path(assets)
    # Sign successfully before touching published output. Exclusive staging files
    # prevent following a stale symlink; publishing the pair requires both assets.
    staged = []
    try:
        for name, data in (("release-manifest.json", raw), ("release-manifest.sig", signature)):
            target = folder / name
            if target.is_symlink():
                raise ValueError("Release output cannot be a symlink")
            temporary = folder / f".{name}.{os.getpid()}.tmp"
            with temporary.open("xb") as stream:
                staged.append((temporary, target))
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
        for temporary, target in staged:
            temporary.replace(target)
    finally:
        for temporary, _ in staged:
            temporary.unlink(missing_ok=True)
    return manifest


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assets", type=Path, required=True)
    parser.add_argument("--key", type=Path, required=True)
    parser.add_argument(
        "--trust",
        type=Path,
        default=DEFAULT_TRUST,
        help="Public trust file; defaults to the app's embedded release key",
    )
    parser.add_argument("--version", required=True)
    parser.add_argument("--npm-version", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--data-migration", action="store_true")
    parser.add_argument("--configuration-change", action="store_true")
    parser.add_argument("--rollback-incompatible", action="store_true")
    options = parser.parse_args(argv)
    try:
        publish_manifest(
            options.assets,
            key=options.key,
            version=options.version,
            trust=options.trust,
            npm_version=options.npm_version,
            commit=options.commit,
            impact={
                "runtime": True,
                "dataMigration": options.data_migration,
                "configuration": options.configuration_change,
                "rollbackCompatible": not options.rollback_incompatible,
            },
        )
    except (ValueError, OSError):
        print(
            "Release manifest was not published. Check versions, installers and the local signing key.",
            file=sys.stderr,
        )
        return 1
    print("Signed release manifest written.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
