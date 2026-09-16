'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { expect } = require('chai');
const sinon = require('sinon');
const supertest = require('supertest');
const { createTestApp, createMockTracker } = require('./support/test_app');

let mockTracker;

function registerApiHooks() {
  beforeEach(function () {
    mockTracker = createMockTracker(sinon);
    createTestApp(mockTracker);
  });

  afterEach(function () {
    sinon.restore();
  });
}

function registerAdminMethodAuthTests() {
  describe('admin-method auth', function () {
    let adminApp;

    beforeEach(function () {
      mockTracker.onAdminExecuted = sinon.stub();
      mockTracker.db.getValuesFromKeyPattern = sinon.stub().resolves([]);
      adminApp = createTestApp(mockTracker, 'secret-key');
    });

    it('rejects a single admin request with no key (401)', async function () {
      const res = await supertest(adminApp)
        .post('/')
        .send({ jsonrpc: '2.0', method: 'getbootstrap', params: {}, id: 1 })
        .expect(401);
      expect(res.body.error.message).to.equal('Unauthorized');
      expect(mockTracker.onAdminExecuted.called).to.equal(false);
    });

    it('rejects an admin method smuggled inside a BATCH with no key (401)', async function () {
      const res = await supertest(adminApp)
        .post('/')
        .send([{ jsonrpc: '2.0', method: 'getbootstrap', params: {}, id: 1 }])
        .expect(401);
      expect(res.body.error.message).to.equal('Unauthorized');
      // The controller must never run: the gate short-circuits before the router.
      expect(mockTracker.onAdminExecuted.called).to.equal(false);
    });

    it('rejects an admin method mixed with a public method in a batch (401)', async function () {
      const res = await supertest(adminApp)
        .post('/')
        .send([
          { jsonrpc: '2.0', method: 'ping', id: 1 },
          { jsonrpc: '2.0', method: 'getbootstrap', params: {}, id: 2 }
        ])
        .expect(401);
      expect(res.body.error.message).to.equal('Unauthorized');
      expect(mockTracker.onAdminExecuted.called).to.equal(false);
    });

    it('allows an admin batch with the correct Bearer key', async function () {
      const res = await supertest(adminApp)
        .post('/')
        .set('Authorization', 'Bearer secret-key')
        .send([{ jsonrpc: '2.0', method: 'getbootstrap', params: {}, id: 1 }])
        .expect(200);
      expect(res.body[0].result).to.deep.equal({ task_id: 'stub' });
      expect(mockTracker.onAdminExecuted.calledOnce).to.equal(true);
    });

    it('still allows public methods in a batch with no key', async function () {
      const res = await supertest(adminApp)
        .post('/')
        .send([{ jsonrpc: '2.0', method: 'ping', id: 1 }])
        .expect(200);
      expect(res.body[0].result).to.deep.equal({ status: 'success' });
    });
  });
}

describe('API', function () {
  registerApiHooks();
  registerAdminMethodAuthTests();
});
