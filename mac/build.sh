#!/usr/bin/env bash
# Build Hearth.app and Hearth.dmg: open the DMG, drag Hearth to Applications, open it, and the setup appears.
#
#   bash mac/build.sh            → mac/build/Hearth.dmg
#
# The app is a small Swift window (mac/Hearth/main.swift) plus Bun and Hearth's own files, so the person installing
# needs nothing else. Without an Apple Developer ID it's signed ad hoc: the first time, right-click the app → Open.
# With one, set DEVELOPER_ID="Developer ID Application: …" (and NOTARY_PROFILE for notarization).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
OUT="$ROOT/mac/build"
APP="$OUT/Hearth.app"
VERSION="$(bun -e 'console.log(require("./package.json").version)')"
say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

rm -rf "$OUT"; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

say "Window (Swift)"
swiftc -O -o "$APP/Contents/MacOS/Hearth" -target "$(uname -m)-apple-macos12" -framework Cocoa -framework WebKit mac/Hearth/main.swift

say "Info.plist"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Hearth</string>
  <key>CFBundleDisplayName</key><string>Hearth</string>
  <key>CFBundleIdentifier</key><string>app.hearth.mac</string>
  <key>CFBundleExecutable</key><string>Hearth</string>
  <key>CFBundleIconFile</key><string>Hearth</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST

say "Icon"
# mac/icon-1024.png is mac/icon.svg rendered on Apple's icon grid (824px body in a 1024px canvas).
# The web icon is full-bleed, which makes the Dock icon look ~20% too big.
ICONSET="$OUT/Hearth.iconset"; mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s mac/icon-1024.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) mac/icon-1024.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/Hearth.icns"; rm -rf "$ICONSET"

say "Bun $(bun --version)"
cp "$(command -v bun)" "$APP/Contents/Resources/bun"

say "Hearth's files"
rsync -a --exclude .git --exclude node_modules --exclude data --exclude .env --exclude mac/build --exclude '*.log' "$ROOT/" "$APP/Contents/Resources/hearth-src/"
(cd "$APP/Contents/Resources/hearth-src" && "$APP/Contents/Resources/bun" install --production --frozen-lockfile >/dev/null)

say "Signing"
SIGN="${DEVELOPER_ID:--}"
# Inner binaries first, then the app. Bun needs JIT; the hub spawns claude/codex, so no sandbox.
cat > "$OUT/entitlements.plist" <<ENT
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict></plist>
ENT
find "$APP/Contents/Resources/hearth-src/node_modules" -type f \( -name '*.node' -o -name '*.dylib' \) -exec codesign --force --timestamp=none -s "$SIGN" {} \; 2>/dev/null || true
codesign --force --options runtime --entitlements "$OUT/entitlements.plist" --timestamp=none -s "$SIGN" "$APP/Contents/Resources/bun"
codesign --force --options runtime --entitlements "$OUT/entitlements.plist" --timestamp=none -s "$SIGN" "$APP"
codesign --verify --deep --strict "$APP" && echo "   signed ($([ "$SIGN" = - ] && echo "ad hoc: right-click → Open the first time" || echo "$SIGN"))"

say "Hearth.dmg"
STAGE="$OUT/dmg"; mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Hearth" -srcfolder "$STAGE" -ov -format UDZO "$OUT/Hearth.dmg" >/dev/null
rm -rf "$STAGE"
if [ -n "${NOTARY_PROFILE:-}" ] && [ "$SIGN" != - ]; then
  say "Notarizing"; xcrun notarytool submit "$OUT/Hearth.dmg" --keychain-profile "$NOTARY_PROFILE" --wait && xcrun stapler staple "$OUT/Hearth.dmg"
fi
echo "   $OUT/Hearth.dmg ($(du -h "$OUT/Hearth.dmg" | cut -f1))"
