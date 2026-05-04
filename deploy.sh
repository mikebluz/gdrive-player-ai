#!/bin/bash
# -----------------------------------------------
# GoDaddy Shared Hosting Static Deployment Script
# -----------------------------------------------
# Usage:
#   chmod +x deploy.sh
#   ./deploy.sh
# -----------------------------------------------

set -e

# -----------------------------------------------
# CONFIGURATION — loaded from deploy.env
# -----------------------------------------------
if [[ ! -f "deploy.env" ]]; then
  echo "❌ Error: deploy.env not found. Copy deploy.example.env and fill in your FTP credentials."
  exit 1
fi
source deploy.env
# -----------------------------------------------

# Validate config
if [[ -z "$FTP_HOST" || -z "$FTP_USER" || -z "$FTP_PASS" || -z "$REMOTE_DIR" ]]; then
  echo "❌ Error: Fill in the CONFIGURATION section of deploy.sh before running."
  exit 1
fi

# Ensure credentials file exists before deploying
if [[ ! -f "js/config.js" ]]; then
  echo "❌ Error: js/config.js not found. Copy js/config.example.js to js/config.js and fill in your credentials."
  exit 1
fi

# -----------------------------------------------
# Make sure the dev sign-in bypass isn't shipped to production. The
# bloops.html source carries `const DEV_BYPASS_SIGNIN = true|false;`
# and we want it as `false` for the deployed build (sign-in required).
# If it's currently `true`, flip it to `false` for the upload, then
# flip it back at the end so local dev mode survives the deploy.
# -----------------------------------------------
DEV_BYPASS_FLIPPED=0
if grep -qE 'const[[:space:]]+DEV_BYPASS_SIGNIN[[:space:]]*=[[:space:]]*true' bloops.html; then
  echo "⚠️  DEV_BYPASS_SIGNIN was set to true in bloops.html — flipping to false for deploy."
  # macOS / BSD sed needs a backup-suffix arg; keep the in-place edit
  # portable by writing then moving.
  sed -E 's/(const[[:space:]]+DEV_BYPASS_SIGNIN[[:space:]]*=[[:space:]]*)true/\1false/' bloops.html > bloops.html.tmp
  mv bloops.html.tmp bloops.html
  DEV_BYPASS_FLIPPED=1
  echo "    ✅ Auth flow enabled for the uploaded build."
fi

echo "🚀 Starting deployment to $FTP_HOST..."

# -----------------------------------------------
# Stage static files only
# -----------------------------------------------
STAGE_DIR=$(mktemp -d)
# Restore DEV_BYPASS_SIGNIN=true on every exit path (success or failure)
# so the local copy goes back to dev mode regardless of whether lftp
# completed. Stage dir cleanup runs alongside.
restore_dev_bypass() {
  if [[ "$DEV_BYPASS_FLIPPED" == "1" ]]; then
    echo "🔧 Restoring DEV_BYPASS_SIGNIN=true for local dev."
    sed -E 's/(const[[:space:]]+DEV_BYPASS_SIGNIN[[:space:]]*=[[:space:]]*)false/\1true/' bloops.html > bloops.html.tmp
    mv bloops.html.tmp bloops.html
  fi
}
trap 'rm -rf "$STAGE_DIR"; restore_dev_bypass' EXIT

echo "📦 Staging files..."
cp -r index.html bloops.html artwork.html css js banner.jpg me2026.jpg samples artwork "$STAGE_DIR/"

# -----------------------------------------------
# Upload via SFTP using lftp
# -----------------------------------------------
echo "🔌 Testing connection to $FTP_HOST on port 21..."
if ! nc -zw5 "$FTP_HOST" 21 2>&1; then
  echo "❌ Cannot reach $FTP_HOST on port 21 (FTP). Check the IP and that FTP is enabled."
  exit 1
fi
echo "✅ Port 21 reachable."

echo "⬆️  Uploading to $REMOTE_DIR..."

lftp -d -u "$FTP_USER","$FTP_PASS" ftp://"$FTP_HOST" <<EOF
set ftp:ssl-allow no
set net:max-retries 1
set net:timeout 15
mirror --reverse --verbose "$STAGE_DIR/" "$REMOTE_DIR/"
bye
EOF

echo ""
echo "🎵 Deployment complete."
