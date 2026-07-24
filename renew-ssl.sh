#!/bin/bash
# -----------------------------------------------------------------------------
# renew-ssl.sh — renew the Let's Encrypt cert for mercywizard.com (GoDaddy
# shared hosting) with as little manual work as the host allows.
#
#   ./renew-ssl.sh          # run every ~80 days, or whenever the cert is invalid
#
# What it automates vs the old script:
#   • The ACME http-01 challenge file is UPLOADED AUTOMATICALLY over FTP
#     (certbot --manual-auth-hook + the same deploy.env credentials deploy.sh
#     uses) — no more copying validation strings around mid-run.
#   • No sudo: certs live in ~/.letsencrypt (a fresh ACME account the first
#     time; that's fine for certonly).
#   • The one step GoDaddy shared hosting won't let us script without a cPanel
#     API token — pasting the cert into cPanel → SSL/TLS — is clipboard-driven:
#     press Enter to copy each block (cert / key / CA bundle) in turn.
#   • Afterwards it verifies the LIVE site is serving the new cert.
#
# Requirements: certbot + lftp   (brew install certbot lftp)
# Optional in deploy.env:  LE_EMAIL=you@example.com   (expiry reminders from LE)
# -----------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")"

DOMAIN="mercywizard.com"
LE_DIR="$HOME/.letsencrypt"          # sudo-free certbot home (config/work/logs)

# ---- config -----------------------------------------------------------------
if [[ ! -f "deploy.env" ]]; then
  echo "❌ deploy.env not found (needs the same FTP credentials deploy.sh uses)."
  exit 1
fi
source deploy.env
if [[ -z "${FTP_HOST:-}" || -z "${FTP_USER:-}" || -z "${FTP_PASS:-}" || -z "${REMOTE_DIR:-}" ]]; then
  echo "❌ deploy.env must set FTP_HOST / FTP_USER / FTP_PASS / REMOTE_DIR."
  exit 1
fi
for tool in certbot lftp; do
  command -v "$tool" >/dev/null || { echo "❌ $tool not installed — brew install $tool"; exit 1; }
done

# ---- ACME hook scripts --------------------------------------------------------
# certbot calls these once per domain: auth uploads the validation file to
# <site>/.well-known/acme-challenge/<token>, cleanup deletes it. Credentials
# and paths pass via exported env (the hooks run as child processes).
export FTP_HOST FTP_USER FTP_PASS REMOTE_DIR
HOOK_DIR=$(mktemp -d)
trap 'rm -rf "$HOOK_DIR"' EXIT

cat > "$HOOK_DIR/auth.sh" <<'HOOK'
#!/bin/bash
set -euo pipefail
f=$(mktemp)
printf '%s' "$CERTBOT_VALIDATION" > "$f"
lftp -u "$FTP_USER","$FTP_PASS" ftp://"$FTP_HOST" <<EOF
set ftp:ssl-allow no
set net:max-retries 3
set net:timeout 30
mkdir -pf "$REMOTE_DIR/.well-known"
mkdir -pf "$REMOTE_DIR/.well-known/acme-challenge"
put "$f" -o "$REMOTE_DIR/.well-known/acme-challenge/$CERTBOT_TOKEN"
bye
EOF
rm -f "$f"
# Give the host a beat, then confirm the challenge is actually reachable.
sleep 2
url="http://$CERTBOT_DOMAIN/.well-known/acme-challenge/$CERTBOT_TOKEN"
got=$(curl -s --max-time 15 "$url" || true)
if [[ "$got" != "$CERTBOT_VALIDATION" ]]; then
  echo "⚠️  challenge readback mismatch at $url (continuing — LE may still reach it)" >&2
fi
HOOK

cat > "$HOOK_DIR/cleanup.sh" <<'HOOK'
#!/bin/bash
lftp -u "$FTP_USER","$FTP_PASS" ftp://"$FTP_HOST" <<EOF
set ftp:ssl-allow no
rm -f "$REMOTE_DIR/.well-known/acme-challenge/$CERTBOT_TOKEN"
bye
EOF
exit 0
HOOK
chmod +x "$HOOK_DIR/auth.sh" "$HOOK_DIR/cleanup.sh"

# ---- issue the cert -----------------------------------------------------------
EMAIL_ARGS=(--register-unsafely-without-email)
[[ -n "${LE_EMAIL:-}" ]] && EMAIL_ARGS=(-m "$LE_EMAIL" --no-eff-email)

echo "🔐 Requesting certificate for $DOMAIN + www.$DOMAIN ..."
certbot certonly --manual --preferred-challenges http -n --agree-tos \
  "${EMAIL_ARGS[@]}" \
  --manual-auth-hook "$HOOK_DIR/auth.sh" \
  --manual-cleanup-hook "$HOOK_DIR/cleanup.sh" \
  --config-dir "$LE_DIR" --work-dir "$LE_DIR/work" --logs-dir "$LE_DIR/logs" \
  -d "$DOMAIN" -d "www.$DOMAIN"

LIVE="$LE_DIR/live/$DOMAIN"
echo ""
echo "✅ Certificate issued → $LIVE"
openssl x509 -noout -enddate < "$LIVE/cert.pem" | sed 's/^/   /'

# ---- clipboard-assisted cPanel install -----------------------------------------
# GoDaddy shared hosting has no scriptable install without a cPanel API token,
# so walk the paste: cPanel → SSL/TLS → “Install and Manage SSL” → $DOMAIN.
echo ""
echo "📋 Open cPanel → SSL/TLS → Install and Manage SSL for $DOMAIN, then:"
read -r -p "   Enter → copy CERTIFICATE (CRT) to clipboard... "
pbcopy < "$LIVE/cert.pem";    echo "   ✔ cert copied — paste into the CRT box"
read -r -p "   Enter → copy PRIVATE KEY to clipboard... "
pbcopy < "$LIVE/privkey.pem"; echo "   ✔ key copied — paste into the KEY box"
read -r -p "   Enter → copy CA BUNDLE to clipboard... "
pbcopy < "$LIVE/chain.pem";   echo "   ✔ bundle copied — paste into CABUNDLE, then click Install"

# ---- verify the live site -------------------------------------------------------
read -r -p "🔎 Enter once installed to verify the live site... "
for host in "$DOMAIN" "www.$DOMAIN"; do
  live_end=$(echo | openssl s_client -servername "$host" -connect "$host:443" 2>/dev/null \
             | openssl x509 -noout -enddate 2>/dev/null || echo "notAfter=UNREACHABLE")
  echo "   $host → ${live_end#notAfter=}"
done
new_end=$(openssl x509 -noout -enddate < "$LIVE/cert.pem"); new_end=${new_end#notAfter=}
echo ""
echo "   New cert expires: $new_end"
echo "   (If the live dates above don't match, the cPanel install didn't take.)"
echo ""
echo "⏰ Run this again in ~80 days."
