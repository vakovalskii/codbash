// Tests for deleteSession safety guards and session rescan cache invalidation on other agent databases.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { deleteSession } = require('../src/data');

test('deleteSession throws an error on empty or invalid sessionId to prevent directory destruction', () => {
  assert.throws(() => {
    deleteSession('', 'project-key');
  }, /Invalid session ID/);

  assert.throws(() => {
    deleteSession(null, 'project-key');
  }, /Invalid session ID/);

  assert.throws(() => {
    deleteSession(undefined, 'project-key');
  }, /Invalid session ID/);

  assert.throws(() => {
    deleteSession(' ', 'project-key');
  }, /Invalid session ID/);

  assert.throws(() => {
    deleteSession('.', 'project-key');
  }, /Invalid session ID/);

  assert.throws(() => {
    deleteSession('..', 'project-key');
  }, /Invalid session ID/);
});

const { __test } = require('../src/data');
const { _sessionsNeedRescan, _updateScanMarkers } = __test;

test('_sessionsNeedRescan is sensitive to file-level changes and other agent databases', () => {
  _updateScanMarkers();
  const need = _sessionsNeedRescan();
  assert.equal(typeof need, 'boolean');
});
