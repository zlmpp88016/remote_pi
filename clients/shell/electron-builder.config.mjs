/**
 * @type {import('electron-builder').Configuration}
 */
const config = {
  appId: "com.remotepi.desktop",
  productName: "Remote Pi",
  directories: {
    output: "release",
  },
  files: [
    "dist/**/*",
    "package.json",
  ],
  extraResources: [
    {
      from: "../web/dist-shell",
      to: "dist-shell",
    },
  ],
  win: {
    target: ["nsis"],
  },
  mac: {
    target: ["dmg"],
  },
  asar: true,
};

export default config;
