"""Include AstrBot's root entry files in the wheel without duplicating source files."""

import importlib.util
from pathlib import Path
from shutil import copy2, copytree, ignore_patterns

from setuptools import setup
from setuptools.command.build_py import build_py
from setuptools.command.sdist import sdist

ASSETS = (
    "main.py",
    "metadata.yaml",
    "_conf_schema.json",
    "requirements.txt",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
)


class BuildPy(build_py):
    def run(self):
        super().run()
        target = Path(self.build_lib) / "dswhale" / "_plugin"
        target.mkdir(parents=True, exist_ok=True)
        for name in ASSETS:
            copy2(name, target / name)
        copytree(
            "dswhale/bili_bridge",
            Path(self.build_lib) / "dswhale/bili_bridge",
            dirs_exist_ok=True,
            ignore=ignore_patterns("node_modules", "__pycache__", ".DS_Store"),
        )


class SourceDistribution(sdist):
    def make_distribution(self):
        super().make_distribution()
        root = Path(__file__).resolve().parent
        spec = importlib.util.spec_from_file_location(
            "_release_normalizer", root / "scripts/normalize_release.py"
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        for archive in self.archive_files:
            if str(archive).endswith(".tar.gz"):
                module.normalize_tar(Path(archive), epoch=module.release_epoch(root))


setup(cmdclass={"build_py": BuildPy, "sdist": SourceDistribution})
