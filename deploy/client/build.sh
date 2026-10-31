#!/usr/bin/env bash
# Builds Hearth Client into dist/:
#   Hearth-Client-<v>-mac-arm64.dmg / -mac-x64.dmg   (on a Mac)
#   hearth-client_<v>_amd64.deb / _arm64.deb          (with dpkg-deb, or Docker)
#   Hearth-Client-<v>-windows-x64.exe
# Each is one program with Bun built in; nothing else to install except Claude Code (or Codex) for the work itself.
#   bash deploy/client/build.sh            everything this machine can build
#   bash deploy/client/build.sh mac        just one
set -euo pipefail
cd "$(dirname "$0")/../.."
ONLY="${1:-all}"
V=$(bun -e 'console.log(require("./package.json").version)')
OUT=dist; mkdir -p "$OUT/bin"
want() { [ "$ONLY" = all ] || [ "$ONLY" = "$1" ]; }
build() { bun build src/client.ts --compile --minify --target="bun-$1" --outfile "$OUT/bin/hearth-client-$1$2" >/dev/null && echo "built $OUT/bin/hearth-client-$1$2"; }

if want mac && [ "$(uname)" = Darwin ]; then
  ICONSET=$(mktemp -d)/icon.iconset; mkdir -p "$ICONSET"
  for s in 16 32 64 128 256 512; do sips -z $s $s web/icon-512.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null; done
  cp web/icon-512.png "$ICONSET/icon_512x512@2x.png"; iconutil -c icns "$ICONSET" -o "$OUT/icon.icns"
  for arch in arm64 x64; do
    build "darwin-$arch" ""
    STAGE="$OUT/mac-$arch"; APP="$STAGE/Hearth Client.app"; rm -rf "$STAGE"; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
    cp "$OUT/bin/hearth-client-darwin-$arch" "$APP/Contents/MacOS/hearth-client"
    cp "$OUT/icon.icns" "$APP/Contents/Resources/icon.icns"
    cat > "$APP/Contents/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Hearth Client</string>
  <key>CFBundleDisplayName</key><string>Hearth Client</string>
  <key>CFBundleIdentifier</key><string>com.hearth.client</string>
  <key>CFBundleVersion</key><string>$V</string>
  <key>CFBundleShortVersionString</key><string>$V</string>
  <key>CFBundleExecutable</key><string>hearth-client</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSUIElement</key><true/>
</dict></plist>
PL
    # Ad-hoc signature (Apple Silicon won't run unsigned code). For no Gatekeeper warning at all, sign with a
    # Developer ID and notarize: codesign -s "Developer ID Application: …" --options runtime, then xcrun notarytool.
    codesign --force --deep -s - "$APP" >/dev/null 2>&1 || true
    ln -s /Applications "$STAGE/Applications"
    hdiutil create -quiet -volname "Hearth Client" -srcfolder "$STAGE" -ov -format UDZO "$OUT/Hearth-Client-$V-mac-$arch.dmg"
    rm -rf "$STAGE" # its /Applications shortcut would send tools that walk the repo through your whole Applications folder
    echo "packed $OUT/Hearth-Client-$V-mac-$arch.dmg"
  done
fi

if want ubuntu; then
  for arch in x64 arm64; do
    build "linux-$arch" ""
    deb=$([ $arch = x64 ] && echo amd64 || echo arm64)
    PKG="$OUT/deb-$deb"; rm -rf "$PKG"; mkdir -p "$PKG/DEBIAN" "$PKG/usr/bin" "$PKG/usr/share/applications" "$PKG/usr/share/icons/hicolor/512x512/apps"
    cp "$OUT/bin/hearth-client-linux-$arch" "$PKG/usr/bin/hearth-client"; chmod 755 "$PKG/usr/bin/hearth-client"
    cp web/icon-512.png "$PKG/usr/share/icons/hicolor/512x512/apps/hearth-client.png"
    printf '[Desktop Entry]\nType=Application\nName=Hearth Client\nComment=Link this computer to your Hearth Hub\nExec=hearth-client\nIcon=hearth-client\nCategories=Utility;\nTerminal=false\n' > "$PKG/usr/share/applications/hearth-client.desktop"
    printf 'Package: hearth-client\nVersion: %s\nArchitecture: %s\nMaintainer: Hearth\nDepends: xdg-utils, python3\nDescription: Hearth Client\n Links this computer to your Hearth Hub so work runs here with its own Claude login.\n' "$V" "$deb" > "$PKG/DEBIAN/control"
    if command -v dpkg-deb >/dev/null; then dpkg-deb --root-owner-group --build "$PKG" "$OUT/hearth-client_${V}_$deb.deb" >/dev/null
    else docker run --rm -v "$PWD/$OUT:/out" ubuntu:24.04 dpkg-deb --root-owner-group --build "/out/deb-$deb" "/out/hearth-client_${V}_$deb.deb" >/dev/null; fi
    rm -rf "$PKG"
    echo "packed $OUT/hearth-client_${V}_$deb.deb"
  done
fi

if want windows; then
  build "windows-x64" ".exe"
  cp "$OUT/bin/hearth-client-windows-x64.exe" "$OUT/Hearth-Client-$V-windows-x64.exe"
  echo "packed $OUT/Hearth-Client-$V-windows-x64.exe"
fi
