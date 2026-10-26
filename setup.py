"""Include AstrBot's root entry files in the wheel without duplicating source files."""

from pathlib import Path
from shutil import copy2

from setuptools import setup
from setuptools.command.build_py import build_py

ASSETS = ("main.py", "metadata.yaml", "_conf_schema.json", "requirements.txt", "LICENSE")


class BuildPy(build_py):
    def run(self):
        super().run()
        target = Path(self.build_lib) / "dswhale" / "_plugin"
        target.mkdir(parents=True, exist_ok=True)
        for name in ASSETS:
            copy2(name, target / name)


setup(cmdclass={"build_py": BuildPy})
