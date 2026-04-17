#!/bin/bash
# -----------------------------------------------
# GoDaddy cPanel Deployment Script
# -----------------------------------------------
# Prerequisites:
#   - lftp installed locally (brew install lftp)
#   - SSH/SFTP access enabled on your GoDaddy plan
#   - Node.js app configured in cPanel Node.js Manager
#
# Usage:
#   chmod +x deploy.sh
#   ./deploy.sh
# -----------------------------------------------

set -e

# -----------------------------------------------
# CONFIGURATION — fill these in
# -----------------------------------------------
FTP_HOST=""          # e.g. ftp.yourdomain.com
FTP_USER=""          # your cPanel username
FTP_PASS=""          # your cPanel password
REMOTE_DIR=""        # e.g. /home/username/public_html/player
APP_NAME=""          # Node.js app name as set in cPanel (for restart via API)
CPANEL_USER=""       # cPanel username (usually same as FTP_USER)
CPANEL_DOMAIN=""     # e.g. yourdomain.com
CPANEL_TOKEN=""      # cPanel API token (Manage API Tokens in cPanel)
# -----------------------------------------------

# Validate config
if [[ -z "$FTP_HOST" || -z "$FTP_USER" || -z "$FTP_PASS" || -z "$REMOTE_DIR" ]]; then
  echo "❌ Error: Fill in the CONFIGURATION section of deploy.sh before running."
  exit 1
fi

echo "🚀 Starting deployment to $FTP_HOST..."

# -----------------------------------------------
# Build: copy files to a temp staging directory
# -----------------------------------------------
STAGE_DIR=$(mktemp -d)
trap "rm -rf $STAGE_DIR" EXIT

echo "📦 Staging files..."
cp -r index.html server.js package.json package-lock.json css js "$STAGE_DIR/"

# Install production dependencies into staging dir
echo "📦 Installing production dependencies..."
cd "$STAGE_DIR"
npm install --omit=dev --silent
cd - > /dev/null

# -----------------------------------------------
# Upload via SFTP using lftp
# -----------------------------------------------
echo "⬆️  Uploading to $REMOTE_DIR..."

lftp -u "$FTP_USER","$FTP_PASS" sftp://"$FTP_HOST" <<EOF
set sftp:auto-confirm yes
set net:max-retries 3
mirror --reverse --delete --verbose \
  --exclude .git \
  --exclude deploy.sh \
  "$STAGE_DIR/" "$REMOTE_DIR/"
bye
EOF

echo "✅ Upload complete."

# -----------------------------------------------
# Restart Node.js app via cPanel API (optional)
# Requires an API token generated in cPanel >
# Manage API Tokens
# -----------------------------------------------
if [[ -n "$CPANEL_TOKEN" && -n "$CPANEL_DOMAIN" && -n "$APP_NAME" ]]; then
  echo "🔄 Restarting Node.js app '$APP_NAME'..."
  RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: cpanel $CPANEL_USER:$CPANEL_TOKEN" \
    "https://$CPANEL_DOMAIN:2083/execute/NodeJS/restart_app?app_name=$APP_NAME")

  if [[ "$RESPONSE" == "200" ]]; then
    echo "✅ App restarted successfully."
  else
    echo "⚠️  App restart returned HTTP $RESPONSE — restart manually in cPanel > Node.js."
  fi
else
  echo "ℹ️  Skipping app restart (CPANEL_TOKEN not set)."
  echo "   Restart manually: cPanel > Node.js > $APP_NAME > Restart."
fi

echo ""
echo "🎵 Deployment complete."
