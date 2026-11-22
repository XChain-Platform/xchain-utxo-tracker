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
 **********************************************************************
 *
 * XChain UTXO Tracker - output script predicates
 *
 * Dependency-free so the bulk-sync parse worker and the live sync loop load the
 * same rule: the two paths must drop exactly the same outputs to stay
 * byte-identical.
 *
 ********************************************************************/

const OP_RETURN = 0x6a
// Consensus MAX_SCRIPT_SIZE: a longer script fails evaluation, so it can never be spent.
const MAX_SCRIPT_SIZE = 10000

// The node's own CScript::IsUnspendable rule. Such an output can never be spent, so
// no spend ever removes its UTXO records; the tracker stores none for it.
function isProvablyUnspendable(script) {
    return (script.length > 0 && script[0] === OP_RETURN) || script.length > MAX_SCRIPT_SIZE
}

module.exports = { isProvablyUnspendable }
