'use strict';
// Print a fresh VAPID key pair for the host environment.
// Usage: node scripts/generate-vapid.js
// Paste the three lines into Render. Do not commit the private key.
const { generateVapidKeys } = require('../push-crypto');

const keys = generateVapidKeys();
console.log('Set these on the Render web service, then redeploy.');
console.log('Dashboard: the kolopoly-game service, Environment, Add environment variable.');
console.log('Do not commit the private key. Keep the same keys, or phones must subscribe again.');
console.log('');
console.log('VAPID_PUBLIC_KEY=' + keys.publicKey);
console.log('VAPID_PRIVATE_KEY=' + keys.privateKey);
console.log('VAPID_SUBJECT=mailto:you@yourdomain');
console.log('');
console.log('VAPID_SUBJECT must be a mailto: address or an https: URL. Push services require it.');
