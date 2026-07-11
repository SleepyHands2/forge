import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import Database from 'better-sqlite3';
import { IdentityFileService } from '../../services/identity-files.ts';
import { identityRoutes } from './identity.ts';

const SCHEMA = fs.readFileSync(
  new URL('../../db/schemas/messages.sql', import.meta.url),
  'utf-8',
);

async function withIdentityServer(fn: (ctx: {
  url: string;
  service: IdentityFileService;
  dir: string;
}) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-identity-route-'));
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  const service = new IdentityFileService({ db, identityDir: dir });
  const app = express();
  app.use(express.json());
  app.use('/api/identity', identityRoutes({ identityFiles: service }));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP server address');

  try {
    await fn({ url: `http://127.0.0.1:${address.port}`, service, dir });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('GET /api/identity lists all four files with trust metadata', async () => {
  await withIdentityServer(async ({ url }) => {
    const response = await fetch(`${url}/api/identity`);
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.deepEqual(body.files.map((file: { name: string }) => file.name), [
      'IDENTITY.md',
      'SOUL.md',
      'USER.md',
      'NOTES.md',
    ]);
    assert.deepEqual(body.files.map((file: { trust: string }) => file.trust), ['high', 'high', 'high', 'low']);
    assert.deepEqual(body.files.map((file: { modelWritable: false | string }) => file.modelWritable), [
      false,
      false,
      false,
      'append-only',
    ]);
    assert.deepEqual(body.proposals, []);
    assert.deepEqual(body.events, []);
  });
});

test('PUT /api/identity/:filename rejects arbitrary filenames', async () => {
  await withIdentityServer(async ({ url }) => {
    const response = await fetch(`${url}/api/identity/OTHER.md`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'nope' }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /allowlisted/);
  });
});

test('PUT /api/identity/:filename writes allowlisted files and records manual_file_edit', async () => {
  await withIdentityServer(async ({ url, service, dir }) => {
    const response = await fetch(`${url}/api/identity/NOTES.md`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '# Manual notes\n' }),
    });
    assert.equal(response.status, 200);
    assert.equal(fs.readFileSync(path.join(dir, 'NOTES.md'), 'utf-8'), '# Manual notes\n');
    assert.equal((await response.json()).file.modelWritable, 'append-only');

    const events = service.listEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, 'manual_file_edit');
    assert.equal(events[0].filename, 'NOTES.md');
  });
});

test('GET /api/identity/proposals lists pending proposals by default', async () => {
  await withIdentityServer(async ({ url, service }) => {
    service.createProposal({ filename: 'IDENTITY.md', title: 'A', content: 'pending A', reason: 'test' });
    const rejected = service.createProposal({ filename: 'SOUL.md', title: 'B', content: 'pending B', reason: 'test' });
    service.rejectProposal(rejected.proposal!.id);

    const response = await fetch(`${url}/api/identity/proposals`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.proposals.map((proposal: { title: string }) => proposal.title), ['A']);
  });
});

test('POST /api/identity/proposals/:id/approve approves a proposal', async () => {
  await withIdentityServer(async ({ url, service, dir }) => {
    const created = service.createProposal({
      filename: 'USER.md',
      title: 'Preference',
      content: 'Use focused tests',
      reason: 'request',
    });

    const response = await fetch(`${url}/api/identity/proposals/${created.proposal!.id}/approve`, { method: 'POST' });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'approved');
    assert.equal(body.proposal.status, 'approved');
    assert.match(fs.readFileSync(path.join(dir, 'USER.md'), 'utf-8'), /Use focused tests/);
  });
});

test('POST /api/identity/proposals/:id/approve supports edited final content', async () => {
  await withIdentityServer(async ({ url, service, dir }) => {
    const created = service.createProposal({
      filename: 'SOUL.md',
      title: 'Tone',
      content: 'Draft wording',
      reason: 'request',
    });

    const response = await fetch(`${url}/api/identity/proposals/${created.proposal!.id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'Final wording' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.proposal.content, 'Final wording');
    const file = fs.readFileSync(path.join(dir, 'SOUL.md'), 'utf-8');
    assert.match(file, /Final wording/);
    assert.doesNotMatch(file, /Draft wording/);
  });
});

test('POST /api/identity/proposals/:id/reject rejects a proposal', async () => {
  await withIdentityServer(async ({ url, service }) => {
    const created = service.createProposal({
      filename: 'IDENTITY.md',
      title: 'Reject',
      content: 'Maybe later',
      reason: 'request',
    });

    const response = await fetch(`${url}/api/identity/proposals/${created.proposal!.id}/reject`, { method: 'POST' });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'rejected');
    assert.equal(body.proposal.status, 'rejected');
  });
});

test('proposal approval is idempotent', async () => {
  await withIdentityServer(async ({ url, service, dir }) => {
    const created = service.createProposal({
      filename: 'IDENTITY.md',
      title: 'Once',
      content: 'Only append once',
      reason: 'request',
    });
    const endpoint = `${url}/api/identity/proposals/${created.proposal!.id}/approve`;

    assert.equal((await fetch(endpoint, { method: 'POST' })).status, 200);
    const second = await fetch(endpoint, { method: 'POST' });
    assert.equal(second.status, 200);
    assert.equal((await second.json()).status, 'already_approved');
    assert.equal(fs.readFileSync(path.join(dir, 'IDENTITY.md'), 'utf-8').match(/FORGE_PROPOSAL_START/g)?.length, 1);
  });
});

test('proposal rejection is idempotent', async () => {
  await withIdentityServer(async ({ url, service }) => {
    const created = service.createProposal({
      filename: 'USER.md',
      title: 'No',
      content: 'Reject once',
      reason: 'request',
    });
    const endpoint = `${url}/api/identity/proposals/${created.proposal!.id}/reject`;

    assert.equal((await fetch(endpoint, { method: 'POST' })).status, 200);
    const second = await fetch(endpoint, { method: 'POST' });
    assert.equal(second.status, 200);
    assert.equal((await second.json()).status, 'already_rejected');
  });
});

test('GET /api/identity/events validates and clamps event limits', async () => {
  await withIdentityServer(async ({ url }) => {
    for (let index = 0; index < 105; index += 1) {
      const response = await fetch(`${url}/api/identity/NOTES.md`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: `event ${index}` }),
      });
      assert.equal(response.status, 200);
    }

    const clampedHigh = await fetch(`${url}/api/identity/events?limit=500`);
    assert.equal(clampedHigh.status, 200);
    assert.equal((await clampedHigh.json()).events.length, 100);

    const clampedLow = await fetch(`${url}/api/identity/events?limit=0`);
    assert.equal(clampedLow.status, 200);
    assert.equal((await clampedLow.json()).events.length, 1);

    const invalid = await fetch(`${url}/api/identity/events?limit=nope`);
    assert.equal(invalid.status, 400);
  });
});

test('static proposal routes are not captured by PUT /:filename', async () => {
  await withIdentityServer(async ({ url, service }) => {
    const created = service.createProposal({
      filename: 'SOUL.md',
      title: 'Route order',
      content: 'Static route wins',
      reason: 'test',
    });

    const list = await fetch(`${url}/api/identity/proposals`);
    assert.equal(list.status, 200);

    const approve = await fetch(`${url}/api/identity/proposals/${created.proposal!.id}/approve`, { method: 'POST' });
    assert.equal(approve.status, 200);
    assert.equal((await approve.json()).status, 'approved');
  });
});
