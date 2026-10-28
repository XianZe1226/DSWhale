# Included upstream source

[dsh-bili-whale](https://github.com/Alterssss/dsh-bili-whale), version 0.4.6, commit `8b0009f8ce2ebdc421afcb2e727b19ac18912ec6`. Copyright 2026 ALTERSSSS. MIT; full original license: `upstream/LICENSE`. Original source and tests retained.

DSWhale changes: isolated `DSWHALE_DATA_HOME` path precedence; host compatibility sidecar and AstrBot adapter are separate DSWhale AGPL-3.0-only code. Additional patches are listed here as implemented. Runtime dependencies qrcode (MIT), React/ReactDOM (MIT) are installed from their pinned npm lockfile; no QQ/NapCat binaries are redistributed.

Additional changes: QQ share option in original settings; missing-runtime integration test mocks process probing to remain deterministic on macOS with global Node installations.

Additional adaptation: wake prompt recognizes QQ sharing; native settings display the isolated data location and DSWhale grants; toolsPath and custom DSH session home are read-only because the adapter fixes its executable. Covers are written under the isolated shots directory with BV validation, not beside installed source files. All original commands remain available to the local manual operator. Automated tools additionally block arbitrary file publishing and require separate owner grants; quota auto-feedback remains available.
