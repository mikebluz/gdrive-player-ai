#!/bin/bash
# Run every ~80 days to renew SSL for mercywizard.com

sudo certbot certonly --manual --preferred-challenges http \
  -d mercywizard.com -d www.mercywizard.com

echo ""
echo "Now install the new cert in cPanel → SSL/TLS → Install and Manage SSL:"
echo ""
sudo cat /etc/letsencrypt/live/mercywizard.com/cert.pem
echo "--- PRIVATE KEY ---"
sudo cat /etc/letsencrypt/live/mercywizard.com/privkey.pem
echo "--- CA BUNDLE ---"
sudo cat /etc/letsencrypt/live/mercywizard.com/chain.pem
