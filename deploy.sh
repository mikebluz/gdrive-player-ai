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

echo "🚀 Starting deployment to $FTP_HOST..."

# -----------------------------------------------
# Stage static files only
# -----------------------------------------------
STAGE_DIR=$(mktemp -d)
trap "rm -rf $STAGE_DIR" EXIT

echo "📦 Staging files..."
cp -r index.html player.html sounds.html css js "$STAGE_DIR/"

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
