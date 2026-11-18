import { describe, it, expect } from 'vitest';
import * as ed from '@noble/ed25519';
import { createPublicKey, createPrivateKey, sign as nodeSign, verify as nodeVerify } from 'node:crypto';

/**
 * Byte-compatibility pin for @noble/ed25519 (AuthContext generates the device key with it). Any major bump of the
 * library must keep producing the RFC 8032 keys and signatures, and the API verifies with Node's crypto
 * (apps/api/src/devices/identity-proof.util.ts), so noble and Node must agree in both directions.
 */
const hex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], b => parseInt(b, 16));
const toHex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');

// RFC 8032 section 7.1, TEST 1 / TEST 2 / TEST 3.
const VECTORS = [
    {
        seed: '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
        pub: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
        msg: '',
        sig: 'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
    },
    {
        seed: '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb',
        pub: '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
        msg: '72',
        sig: '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00',
    },
    {
        seed: 'c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7',
        pub: 'fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025',
        msg: 'af82',
        sig: '6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a',
    },
];

const SPKI_PREFIX = hex('302a300506032b6570032100');
const PKCS8_PREFIX = hex('302e020100300506032b657004220420');
const cat = (a: Uint8Array, b: Uint8Array) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };
const nodePub = (pub: Uint8Array) => createPublicKey({ key: Buffer.from(cat(SPKI_PREFIX, pub)), format: 'der', type: 'spki' });
const nodePriv = (sk: Uint8Array) => createPrivateKey({ key: Buffer.from(cat(PKCS8_PREFIX, sk)), format: 'der', type: 'pkcs8' });

describe('@noble/ed25519 byte compatibility', () => {
    it.each(VECTORS.map((v, i) => [i + 1, v] as const))('RFC 8032 test %i: public key and signature', async (_n, v) => {
        const sk = hex(v.seed);
        const msg = hex(v.msg);
        expect(toHex(await ed.getPublicKeyAsync(sk))).toBe(v.pub);
        const sig = await ed.signAsync(msg, sk);
        expect(toHex(sig)).toBe(v.sig);
        expect(await ed.verifyAsync(sig, msg, hex(v.pub))).toBe(true);
    });

    it('a noble signature verifies with Node crypto (the API side), and a Node signature verifies with noble', async () => {
        const sk = ed.utils.randomSecretKey();
        const pub = await ed.getPublicKeyAsync(sk);
        const msg = new TextEncoder().encode('cipherline-device-proof-v1|example');
        const sig = await ed.signAsync(msg, sk);
        expect(nodeVerify(null, Buffer.from(msg), nodePub(pub), Buffer.from(sig))).toBe(true);
        const nodeSig = nodeSign(null, Buffer.from(msg), nodePriv(sk));
        expect(toHex(new Uint8Array(nodeSig))).toBe(toHex(sig)); // Ed25519 is deterministic
        expect(await ed.verifyAsync(new Uint8Array(nodeSig), msg, pub)).toBe(true);
        const bad = sig.slice(); bad[0] ^= 1;
        expect(await ed.verifyAsync(bad, msg, pub)).toBe(false);
    });
});
