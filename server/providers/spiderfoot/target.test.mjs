import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTarget } from './target.js';

const ok = (input, kind, value = input.trim().toLowerCase()) => {
  const result = classifyTarget(input);
  assert.deepEqual(result, { ok: true, kind, value }, input);
};
const refused = (input, pattern) => {
  const result = classifyTarget(input);
  assert.equal(result.ok, false, String(input));
  if (pattern) assert.match(result.reason, pattern, String(input));
};

test('infrastructure targets are accepted and normalised', () => {
  ok('Example.COM', 'domain', 'example.com');
  ok('mail.sub.example.com.my', 'domain');
  ok('8.8.8.8', 'ip');
  ok('203.0.113.0/24', 'netblock');
  ok('AS4788', 'asn', '4788');
});

test('targets that identify people are refused', () => {
  refused('someone@example.com', /e-mail/);
  refused('+60123456789', /phone/);
  refused('"Jane Doe"', /names/);
  refused('Jane Doe', /names/);
  refused('jane_doe', /expected/);
  refused('1BoatSLRHtKNngkdXEeobR76b53LETtpyT', /expected/);
});

test('private, loopback, huge and malformed targets are refused', () => {
  refused('127.0.0.1', /private/);
  refused('10.1.2.3', /private/);
  refused('192.168.1.1', /private/);
  refused('172.20.0.5', /private/);
  refused('169.254.169.254', /private/);
  refused('203.0.113.0/16', /too large/);
  refused('10.0.0.0/24', /private/);
  refused('300.1.1.1', /invalid|expected/);
  refused('printer.local', /local/);
  refused('localhost', /expected/);
  refused('', /empty/);
  refused(42);
  refused('a'.repeat(300), /too long/);
});
