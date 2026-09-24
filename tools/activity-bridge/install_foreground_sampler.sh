#!/usr/bin/env bash
# Prepare a stable macOS app identity for Accessibility. Does not start collection.
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
app_dir="$HOME/Applications/MattoForegroundSampler.app"
binary="$app_dir/Contents/MacOS/foreground-sampler"
agent="$HOME/Library/LaunchAgents/local.matto.foreground-sampler.plist"
private_dir="$HOME/todo-review-20260907/activity"
config="$private_dir/config.json"

if [[ ! -f "$config" ]]; then
  echo "Activity config is missing" >&2
  exit 1
fi
if launchctl list | /usr/bin/grep -q 'local.matto.foreground-sampler'; then
  echo "Stop the running sampler before replacing its executable" >&2
  exit 1
fi

mkdir -p "$app_dir/Contents/MacOS" "$HOME/Library/LaunchAgents"
cat > "$app_dir/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>foreground-sampler</string>
  <key>CFBundleIdentifier</key><string>local.matto.foreground-sampler</string>
  <key>CFBundleName</key><string>Matto Foreground Sampler</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
</dict></plist>
PLIST
swiftc "$script_dir/foreground_sampler.swift" -o "$binary"
codesign --force --sign - --timestamp=none "$app_dir"
/usr/bin/plutil -lint "$app_dir/Contents/Info.plist" >/dev/null

cat > "$agent" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>local.matto.foreground-sampler</string>
  <key>ProgramArguments</key><array>
    <string>$binary</string>
    <string>--run</string>
    <string>$config</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$private_dir/foreground-sampler.stdout.log</string>
  <key>StandardErrorPath</key><string>$private_dir/foreground-sampler.stderr.log</string>
</dict></plist>
PLIST
chmod 600 "$agent"
/usr/bin/plutil -lint "$agent" >/dev/null
echo "$app_dir"
echo "$agent"
