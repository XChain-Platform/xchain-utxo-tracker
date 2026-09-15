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
 * XChain UTXO Tracker - UTXO Tracker Class
 *
 ********************************************************************/

const bitcoin = require('bitcoinjs-lib')
const { MEMPOOL_INTERVAL } = require('./constants.js')

module.exports = {
    async sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    },

    millisecondsToTimeString(ms){
        var milliseconds = Math.floor((ms % 1000) / 100),
        seconds = Math.floor((ms / 1000) % 60),
        minutes = Math.floor((ms / (1000 * 60)) % 60),
        hours = Math.floor((ms / (1000 * 60 * 60)) % 24),
        days = Math.floor(ms / (1000 * 60 * 60 * 24));

        hours = (hours < 10) ? "0" + hours : hours;
        minutes = (minutes < 10) ? "0" + minutes : minutes;
        seconds = (seconds < 10) ? "0" + seconds : seconds;

        let result = hours + "h" + minutes + "m" + seconds + "." + milliseconds+"s";
        if (days > 0) result = days + "d " + result;
        return result;
    },

    isSynced(){
        return this.synced
    },

    // True once the mempool has reconverged at least once since the last
    // synced=true transition. Pairs with isSynced() to form the readiness signal:
    // synced alone can be true while the mempool DB is still empty/repopulating.
    isMempoolReconverged(){
        return this.mempoolReconverged
    },


    // Drain entry for SIGTERM (src/server/shutdown.js). Unlike stopParsing(), which is
    // the RPC-facing pause and RESTORES the loop when it cannot stop within ten
    // seconds, this only asks: the loop takes its else branch at its next
    // keepParsing check (a block boundary), closes the store and breaks, and
    // start() resolves. The caller bounds the wait with its hard-exit timer.
    stop(){
        this.keepParsing = false
        if (this.mempoolInterval) {
            clearInterval(this.mempoolInterval)
            this.mempoolInterval = null
        }
    },

    async stopParsing(){
        return new Promise(async(resolve, reject) => {
            this.keepParsing = false

            if (this.mempoolInterval) {
                clearInterval(this.mempoolInterval)
                this.mempoolInterval = null
            }

            // The loop aborted (halt path) instead of stopping normally, so nothing
            // is left running to reach the else branch and the wait below could only
            // ever time out and reject, which is what made restorebootstrap and
            // getbootstrap unreachable on a halted tracker. Finalize the stop here
            // the way that branch would, closing the store FIRST so a restore wipes
            // /data with no handle held open. parsingStopped is the idempotence guard:
            // a second stop call falls through to the resolve path below.
            if (this.parsingAborted && !this.parsingStopped){
                try {
                    await this.db.close()
                } catch (err) {
                    // Reject explicitly: a throw inside this executor never reaches the
                    // caller's await, it becomes an unhandled rejection and the RPC hangs.
                    reject(err)
                    return
                }
                this.parsingStopped = true
                resolve(true)
                return
            }

            let triesCount = 10

            while((!this.parsingStopped) && (triesCount > 0)){
                await this.sleep(1000)
                triesCount = triesCount - 1
            }

            if ((triesCount == 0) && (!this.parsingStopped)){
                // The block loop did not reach its keepParsing check within the
                // budget (parked in a 200-block commit or the multi-batch mempool
                // wait). If we reject and leave keepParsing=false, the loop takes
                // its else branch the moment it next checks, closes the LevelDB, and
                // sets parsingStopped=true, so start() resolves and launchTracker's
                // .catch never relaunches: every query then 500s on a closed store
                // with no process exit for a restart policy to catch. A failed stop
                // must be a no-op that leaves the tracker running: restore
                // keepParsing so the loop continues, and re-arm the mempool poller
                // (the loop also re-arms it once synced, but do it here in case the
                // loop is parked in the synced branch's sleep).
                this.keepParsing = true
                if (this.mempoolInterval == null){
                    this.mempoolInterval = setInterval(this.updateMempool.bind(this), MEMPOOL_INTERVAL)
                }
                reject(new Error("There was an error trying to stop the parsing"))
            } else {
                resolve(true)
            }
        })
    },

    getAddressType(address, network) {
        try {
            bitcoin.payments.p2pkh({ address, network })
            return 'p2pkh'
        } catch (e) {}

        try {
            bitcoin.payments.p2sh({ address, network });
            return 'p2sh'
        } catch (e) {}

        try {
            bitcoin.payments.p2wpkh({ address, network });
            return 'p2wpkh'
        } catch (e) {}

        try {
            bitcoin.payments.p2tr({ address, network });
            return 'p2tr';
        } catch (e) {}

        return "unknown"
    }
}
