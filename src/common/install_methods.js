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
 * XChain UTXO Tracker - Split Class Method Installer
 *
 ********************************************************************/

// A class split into part modules has to put the moved methods back on its
// prototype. Object.assign would do that as enumerable own properties, while
// a method written in the class body is non-enumerable. Define each moved
// method with the flags class syntax gives so split prototypes behave the same.
function installMethods(target, ...sources) {
    for (const source of sources) {
        for (const key of Reflect.ownKeys(source)) {
            if (!Object.prototype.propertyIsEnumerable.call(source, key)) continue
            Object.defineProperty(target, key, {
                value: source[key],
                writable: true,
                enumerable: false,
                configurable: true,
            })
        }
    }
    return target
}

module.exports = { installMethods }
