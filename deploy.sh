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
# CONFIGURATION — fill these in
# -----------------------------------------------
FTP_HOST=""      # e.g. ftp.yourdomain.com
FTP_USER=""      # your cPanel username
FTP_PASS=""      # your cPanel password
REMOTE_DIR=""    # e.g. /home/username/public_html/player
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
cp -r index.html player.html css js "$STAGE_DIR/"

# -----------------------------------------------
# Upload via SFTP using lftp
# -----------------------------------------------
echo "⬆️  Uploading to $REMOTE_DIR..."

lftp -u "$FTP_USER","$FTP_PASS" sftp://"$FTP_HOST" <<EOF
set sftp:auto-confirm yes
set net:max-retries 3
mirror --reverse --delete --verbose "$STAGE_DIR/" "$REMOTE_DIR/"
bye
EOF

echo ""
echo "🎵 Deployment complete."
