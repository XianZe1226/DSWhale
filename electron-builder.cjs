'use strict';
// GitHub Actions supplies an empty value when an optional secret is absent.
// electron-builder treats an empty CSC_LINK as the working directory.
for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD']) {
  if (process.env[name] === '') delete process.env[name];
}
// A local ad-hoc signature lets Apple Silicon launch the app. It is not a
// trusted Developer ID signature or notarization. Real certificates are opt-in.
const config = {
  "appId": "dev.dswhale.desktop",
  "productName": "DSWhale",
  "electronVersion": "45.1.0",
  "asar": true,
  "npmRebuild": false,
  "buildDependenciesFromSource": false,
  "directories": {
    "output": "desktop-dist",
    "buildResources": "desktop/assets"
  },
  "files": [
    "desktop/main.cjs",
    "desktop/preload.cjs",
    "desktop/lib/runtime.cjs",
    "desktop/lib/security.cjs",
    "desktop/lib/services.cjs",
    "desktop/lib/tool-assets.json",
    "desktop/ui/index.html",
    "desktop/ui/app.js",
    "desktop/ui/model.js",
    "desktop/ui/style.css",
    "desktop/ui/whale.svg",
    "desktop/assets/icon.png",
    "package.json",
    "!**/*.test.*",
    "!**/.DS_Store",
    "!**/node_modules/**"
  ],
  "extraResources": [
    {
      "from": "desktop-resources/backend",
      "to": "backend"
    },
    {
      "from": "desktop-resources/backend-manifest.json",
      "to": "backend-manifest.json"
    },
    {
      "from": "THIRD_PARTY_NOTICES.md",
      "to": "THIRD_PARTY_NOTICES.md"
    },
    {
      "from": "LICENSE",
      "to": "LICENSE"
    }
  ],
  "mac": {
    "target": [
      {
        "target": "dmg",
        "arch": [
          "arm64"
        ]
      }
    ],
    "category": "public.app-category.social-networking",
    "minimumSystemVersion": "13.0",
    "icon": "desktop/assets/icon.icns",
    "artifactName": "DSWhale-${version}-macOS-arm64.${ext}",
    "hardenedRuntime": false,
    "entitlements": "desktop/assets/entitlements.mac.plist",
    "entitlementsInherit": "desktop/assets/entitlements.mac.plist",
    "notarize": false
  },
  "dmg": {
    "title": "DSWhale ${version}"
  },
  "win": {
    "target": [
      {
        "target": "nsis",
        "arch": [
          "x64"
        ]
      }
    ],
    "icon": "desktop/assets/icon.ico",
    "artifactName": "DSWhale-${version}-Windows-x86_64-setup.${ext}",
    "requestedExecutionLevel": "asInvoker"
  },
  "nsis": {
    "oneClick": false,
    "perMachine": false,
    "allowElevation": false,
    "allowToChangeInstallationDirectory": true,
    "deleteAppDataOnUninstall": false,
    "createDesktopShortcut": true,
    "createStartMenuShortcut": true
  },
  "linux": {
    "target": [
      {
        "target": "deb",
        "arch": [
          "x64"
        ]
      },
      {
        "target": "tar.gz",
        "arch": [
          "x64"
        ]
      }
    ],
    "category": "Network",
    "icon": "desktop/assets/icon.png",
    "artifactName": "DSWhale-${version}-Linux-x86_64.${ext}",
    "maintainer": "DSWhale Contributors",
    "executableName": "dswhale",
    "synopsis": "QQ companion with shared memory and video experiences",
    "desktop": {
      "entry": {
        "StartupWMClass": "DSWhale",
        "Keywords": "QQ;AstrBot;Companion;"
      }
    }
  },
  "deb": {
    "depends": [
      "libgtk-3-0",
      "libnss3",
      "libxss1",
      "libxtst6",
      "libatspi2.0-0",
      "libdrm2",
      "libgbm1",
      "fonts-noto-cjk",
      "libasound2 | libasound2t64"
    ]
  },
  "publish": null
};
const hasCertificate = Boolean(process.env.CSC_LINK || process.env.CSC_NAME);
config.mac.identity = hasCertificate ? undefined : '-';
config.mac.hardenedRuntime = hasCertificate;
if (process.platform === 'darwin' && hasCertificate) config.forceCodeSigning = true;
module.exports = config;
