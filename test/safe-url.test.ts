import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { fetch as undiciFetch } from 'undici';
import { AppError } from '../src/errors.js';
import { assertNoHttpRedirect, createPinnedHttpTarget, isPrivateOrReservedAddress } from '../src/safe-url.js';

test('private and metadata addresses are rejected', () => {
  for (const value of ['127.0.0.1', '10.0.0.1', '172.16.1.2', '192.168.1.2', '169.254.169.254', '::1', 'fd00::1', 'fe80::1']) {
    assert.equal(isPrivateOrReservedAddress(value), true, value);
  }
  assert.equal(isPrivateOrReservedAddress('8.8.8.8'), false);
  assert.equal(isPrivateOrReservedAddress('2606:4700:4700::1111'), false);
});

test('pinned targets reject private DNS results unless explicitly allowed', async () => {
  await assert.rejects(
    createPinnedHttpTarget(new URL('http://127.0.0.1/image.png'), false),
    (error) => error instanceof AppError && error.code === 'image_url_private_address'
  );
  const target = await createPinnedHttpTarget(new URL('http://127.0.0.1/image.png'), true);
  await target.close();
});

test('pinned target supports undici all-address DNS lookups', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'image/png' });
    response.end('image');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const target = await createPinnedHttpTarget(new URL(`http://localhost:${port}/image.png`), true);

  try {
    const response = await undiciFetch(`http://localhost:${port}/image.png`, {
      dispatcher: target.dispatcher,
      redirect: 'manual'
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'image');
  } finally {
    await target.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('redirect responses are rejected', () => {
  assert.throws(
    () => assertNoHttpRedirect(new Response(null, { status: 302, headers: { location: 'https://example.com/image.png' } })),
    (error) => error instanceof AppError && error.code === 'image_url_redirect_not_allowed'
  );
});
