import assert from 'node:assert/strict';
import test from 'node:test';
import { looksLikeSecret, redactSecrets } from '../src/secrets.mjs';

test('looksLikeSecret catches tokens, jwt, private keys, and long hex or base64', () => {
  assert.equal(looksLikeSecret('Approve invoice 240'), false);
  assert.equal(looksLikeSecret('CI red on main'), false);
  assert.equal(looksLikeSecret('sk-abc123'), true);
  assert.equal(looksLikeSecret('ghp_abc123'), true);
  assert.equal(looksLikeSecret('xoxb-1234'), true);
  assert.equal(looksLikeSecret('AKIAAAAAAAAA'), true);
  assert.equal(looksLikeSecret('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0'), true);
  assert.equal(looksLikeSecret('token=abc'), true);
  assert.equal(looksLikeSecret('password=secret'), true);
  assert.equal(looksLikeSecret('api_key: abc'), true);
  assert.equal(looksLikeSecret('Bearer abcdef'), true);
  assert.equal(looksLikeSecret('deadbeefdeadbeefdeadbeefdeadbeef'), true);
  assert.equal(looksLikeSecret('AbCdEfGhIjKlMnOpQrStUvWxYz012345+/=='), true);
  assert.equal(looksLikeSecret('-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----'), true);
  assert.equal(looksLikeSecret('-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----'), true);
  assert.equal(looksLikeSecret('-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----'), true);
});

test('redactSecrets replaces credential-shaped text', () => {
  assert.match(redactSecrets('key sk-abc123 gone'), /\[redacted\]/);
  assert.equal(redactSecrets('-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----'), '[redacted]');
  assert.equal(looksLikeSecret(redactSecrets('ghp_abc123')), false);
});
