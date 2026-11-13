#!/usr/bin/env node
// Mint two LiveKit access tokens (publisher, viewer) for a THROWAWAY SFU. Usage: node mint-tokens.mjs <key> <secret> <room>
// Prints {"pub": "...", "view": "..."} on stdout.
const [key, secret, room] = process.argv.slice(2);
if (!key || !secret || !room) { console.error('usage: mint-tokens.mjs <key> <secret> <room>'); process.exit(2); }
const { AccessToken } = await import(process.env.LK_SDK ?? '/home/antigravity/Cipherline/node_modules/livekit-server-sdk/dist/index.js');
const mint = async (identity) => {
    const at = new AccessToken(key, secret, { identity, ttl: '1h' });
    at.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true });
    return at.toJwt();
};
console.log(JSON.stringify({ pub: await mint('pub'), view: await mint('view') }));
