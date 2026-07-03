// Ad-hoc code-sign the macOS app after packing.
//
// We don't have a paid Apple Developer certificate yet, so electron-builder
// leaves the app unsigned — and Apple Silicon rejects unsigned downloaded apps
// as "damaged". An ad-hoc signature (codesign --sign -) makes the OS instead
// show the normal "unidentified developer" prompt, which a user can clear with
// right-click → Open. No cost, no cert.
const { execSync } = require("child_process");
const path = require("path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  execSync(`codesign --force --deep --sign - "${appPath}"`, {
    stdio: "inherit",
  });
  console.log(`ad-hoc signed ${appPath}`);
};
