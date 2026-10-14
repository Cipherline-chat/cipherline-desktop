import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { apiPath, apiUrl } from './apiPath';
import { API_BASE } from '../constants';

const UUID = '3f2b8c1e-9a4d-4e57-8b6f-0c1d2e3f4a5b';
const UUID2 = 'a1b2c3d4-e5f6-4789-abcd-ef0123456789';

describe('apiPath / apiUrl: normal ids are byte-identical to the old raw interpolation', () => {
  it('uuid segments', () => {
    expect(apiUrl`/conversations/${UUID}/messages`).toBe(`${API_BASE}/conversations/${UUID}/messages`);
    expect(apiUrl`/servers/${UUID}/channels/${UUID2}/recipient-devices`)
      .toBe(`${API_BASE}/servers/${UUID}/channels/${UUID2}/recipient-devices`);
    expect(apiPath`/devices/${UUID}/revoke`).toBe(`/devices/${UUID}/revoke`);
  });

  it('literal query text is untouched; interpolated query values are encoded (uuid unchanged)', () => {
    expect(apiUrl`/conversations/${UUID}/devices?claim_otp=1`).toBe(`${API_BASE}/conversations/${UUID}/devices?claim_otp=1`);
    expect(apiUrl`/keys/identity_keys?user_id=${UUID}`).toBe(`${API_BASE}/keys/identity_keys?user_id=${UUID}`);
  });

  it('numbers, invite codes, slot names and literal-ish segments are unchanged', () => {
    expect(apiUrl`/history/slot/${'a'}/meta`).toBe(`${API_BASE}/history/slot/a/meta`);
    expect(apiUrl`/invites/${'Ab3-_x9.~'}/accept`).toBe(`${API_BASE}/invites/Ab3-_x9.~/accept`);
    expect(apiPath`/x/${42}/y`).toBe('/x/42/y');
    expect(apiPath`/servers/${UUID}/${'channels'}/${UUID2}/overrides`).toBe(`/servers/${UUID}/channels/${UUID2}/overrides`);
  });

  it('no interpolation: returns the static text', () => {
    expect(apiPath`/friends`).toBe('/friends');
    expect(apiUrl`/friends`).toBe(`${API_BASE}/friends`);
  });
});

describe('apiPath: hostile ids stay inside their segment', () => {
  it('encodes ../ traversal', () => {
    const p = apiPath`/conversations/${'../auth/me'}/messages`;
    expect(p).toBe('/conversations/..%2Fauth%2Fme/messages');
    expect(p.split('/').length).toBe(4); // '', conversations, <one segment>, messages
    // negative control: raw interpolation really did change the route
    expect(`/conversations/${'../auth/me'}/messages`).toBe('/conversations/../auth/me/messages');
  });

  it('encodes ? and # so an id cannot add a query or fragment', () => {
    expect(apiPath`/channels/${'c1?admin=1'}/messages`).toBe('/channels/c1%3Fadmin%3D1/messages');
    expect(apiPath`/channels/${'c1#frag'}/messages`).toBe('/channels/c1%23frag/messages');
    expect(apiPath`/keys/identity_keys?user_id=${'u&user_id=other'}`).toBe('/keys/identity_keys?user_id=u%26user_id%3Dother');
  });

  it('encodes backslash, whitespace, percent and unicode; absolute-URL ids cannot change the host', () => {
    expect(apiPath`/a/${'x\\y z%41é'}`).toBe('/a/x%5Cy%20z%2541%C3%A9');
    const u = apiUrl`/a/${'//evil.example/x'}`;
    expect(u.startsWith(API_BASE + '/a/')).toBe(true);
    expect(new URL(u).host).toBe(new URL(API_BASE).host);
  });

  it('null/undefined keep the old template behaviour (the literal words)', () => {
    expect(apiPath`/a/${undefined}`).toBe('/a/undefined');
    expect(apiPath`/a/${null}`).toBe('/a/null');
  });
});

describe('source guard: no raw ${API_BASE}/…${x} URL left in the renderer', () => {
  const SRC = join(__dirname, '..');
  function walk(dir: string, out: string[]): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
    }
    return out;
  }

  it('every id interpolated into an API URL goes through apiPath/apiUrl', () => {
    const offenders: string[] = [];
    for (const f of walk(SRC, [])) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        // `${API_BASE}/..${x}..` / `${apiBase}/..${x}..` inside a plain template literal
        if (/\$\{(?:[\w.]*[aA]piBase|API_BASE)\}[^`]*\$\{/.test(line)) offenders.push(`${f.slice(SRC.length + 1)}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
