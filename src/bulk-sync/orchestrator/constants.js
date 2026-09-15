'use strict'

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************/

const path = require('path')

// constants

const OUTPUTS_KEY_SIZE = 12   // txHash8(8) + vout(4)
const SPENDS_KEY_SIZE  = 12   // prevTxHash8(8) + prevVout(4)

// The bulk-sync programs (dump.js, parse_worker.js) sit beside the orchestrator
// entry, one directory above this part.
const BULK_SYNC_DIR = path.resolve(__dirname, '..')

module.exports = { OUTPUTS_KEY_SIZE, SPENDS_KEY_SIZE, BULK_SYNC_DIR }
