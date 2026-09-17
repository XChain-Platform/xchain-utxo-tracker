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

// the shared /metrics exporter and structured log shim. The suite
// pins the three properties services depend on: valid Prometheus exposition
// text, default-off wiring (no route, no timer, no socket without env), and a
// log shim that redacts credentials and never throws at a dead collector.
//
// Ported from the canonical suite at xchain-hub/test/unit/observability/observability.test.js.
// src/observability/ here is a verbatim vendored copy, vendored and verified by
// xchain-hub/bin/sync-observability.sh. Parity is gated in the HUB, not here:
// the hub's pre-push gate (bin/ci-full.sh) and the drift-guards job of its
// ci.yml both run that script with --check against all six consumers, so a
// hand-edit to this copy reddens the hub. This file runs the same assertions
// against xchain-utxo-tracker's own copy, express version and Node engine.
// Behaviour changes belong in the canonical suite first; re-port rather than
// hand-editing, or the two drift apart silently.

const {
    registerMetricDeclarationTests,
    registerMetricRenderingTests,
    registerMetricStateTests,
    registerInstallConfigTests,
    registerInstallEndpointTests,
    registerRouteLabelTests,
    registerCustomRouteTests
} = require('./observability.test/01_metrics_and_routes.test.js');
const {
    registerTextFieldFormatTests,
    registerTextFieldSafetyTests,
    registerMessageRedactionTests,
    registerConsoleRoutingTests,
    registerConsoleLifecycleTests,
    registerConsoleRecordTests
} = require('./observability.test/02_log_shipper_hooks.test.js');
const {
    registerLocalShipperTests,
    registerShipperRedactionTests,
    registerShipperBatchTests,
    registerShipperFailureTests,
    registerShipperShutdownTests
} = require('./observability.test/03_health_and_flush.test.js');

describe('observability/metrics: exposition format', function () {
    registerMetricDeclarationTests();
    registerMetricRenderingTests();
    registerMetricStateTests();
});

describe('observability/logShipper', function () {
    registerLocalShipperTests();
    registerShipperRedactionTests();
    registerShipperBatchTests();
    registerShipperFailureTests();
    registerShipperShutdownTests();
});

describe('observability/installObservability', function () {
    // The registry and shipper are process-wide by design (one process is one
    // service), so a suite that installs many times has to drop them between
    // cases or it reads the previous case's service label and HTTP series.
    afterEach(function () { require('../../src/observability/index.js')._resetObservability(); });

    registerInstallConfigTests();
    registerInstallEndpointTests();
    registerRouteLabelTests();
    registerCustomRouteTests();
});

// The fleet runs text mode, so text mode is where the structured record has to
// survive. Before this, _emitLocal's text branch printed the message alone and
// threw the whole record away: LOG_LEVEL and LOG_FORMAT changed nothing an
// operator could see on any box.
describe('observability/logShipper: text-with-fields format', function () {
    registerTextFieldFormatTests();
    registerTextFieldSafetyTests();
});

describe('observability/logShipper: message redaction', function () {
    registerMessageRedactionTests();
});

describe('observability/patchConsole', function () {
    const { _resetObservability } = require('../../src/observability/index.js');

    afterEach(function () { _resetObservability(); });

    registerConsoleRoutingTests();
    registerConsoleLifecycleTests();
    registerConsoleRecordTests();
});
