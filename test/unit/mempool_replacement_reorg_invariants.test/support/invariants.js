'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { createHash } = require('crypto');
const { expect } = require('chai');
const {
  TEST_KEYS,
  amountToSatoshi,
  makeOutput,
  makeSpendInput,
  makeTx,
  makeBlock,
  createTestTracker,
  closeTracker
} = require('../../../integration/support/helpers');

function fixedHash(label) {
  return createHash('sha256').update(label).digest('hex');
}

function outpoint(txid, vout) {
  return txid + ':' + vout;
}

async function commitBlock(tracker, block) {
  await tracker.db.beginTransaction();
  await tracker.db.insertBlock({
    hash: block.hash,
    height: block.height,
    timestamp: block.timestamp,
    previousHash: block.previousHash
  });

  for (const tx of block.transactions) {
    await tracker.db.insertTransaction({ hash: tx.getId(), blockHash: block.hash });
    await tracker.parseTxOutputs(tracker.db, tx, block.hash, block.height, false, true);
  }

  const inputs = [];
  for (const tx of block.transactions) {
    for (const input of tx.ins) {
      const standardInput = ('standard_input' in input ? input.standard_input : true);
      if (input.index === 0xffffffff || !standardInput) continue;
      inputs.push({
        prevTxHash: Buffer.from(input.hash).reverse().toString('hex'),
        prevOutputIndex: input.index,
        blockHash: block.hash
      });
    }
  }
  await tracker.db.removeOutputsWithInputsBatch(inputs);
  await tracker.addToLastBlocks(block.hash);
  await tracker.db.setLastBlockHeight(block.height);
  await tracker.db.setLastBlockHash(block.hash);
  await tracker.db.endTransaction();
  await tracker.cleanupAgedBlocks();
}

function installMempoolNode(tracker, transactions) {
  let txids = [];
  const byId = new Map(transactions.map(tx => [tx.getId(), tx]));

  tracker.connector.getRawMempool = async () => txids.slice();
  tracker.connector.getRawTransactions = async requested => requested.map(txid => 'wire:' + txid);
  tracker.connector.getBlockchainInfo = async () => ({
    blocks: await tracker.db.getLastBlockHeight(),
    bestblockhash: await tracker.db.getLastBlockHash()
  });
  tracker.xchainBlockDecoder.txFromHex = wire => byId.get(wire.substring(5));
  tracker.sleep = async () => {};

  return {
    set(nextTxids) { txids = nextTxids.slice(); },
    setTransaction(txid, tx) { byId.set(txid, tx); }
  };
}

async function cleanupConfirmedMempoolTransactions(tracker, txids) {
  await tracker.mempoolDb.beginTransaction();
  for (const txid of txids) {
    await tracker.mempoolDb.deleteOutputsByHint(txid);
    await tracker.mempoolDb.deleteInputsByHint(txid);
    await tracker.mempoolDb.deleteTransaction(txid);
  }
  await tracker.mempoolDb.endTransaction();
}

async function rewindTip(tracker, forkHeight, forkHash) {
  tracker.connector.getBlockHash = async height => height === forkHeight ? forkHash : fixedHash('replacement-' + height);
  tracker.db.transactionArray = null;
  tracker.db.deletedTransactionArray = null;
  await tracker.verifyReorg();
}

async function checkInvariants(tracker, expected) {
  const observed = new Map();

  for (let addressIndex = 0; addressIndex < TEST_KEYS.length; addressIndex++) {
    const address = TEST_KEYS[addressIndex].address;
    const utxos = await tracker.getUtxosAddress(address);
    const info = await tracker.getBalanceInfo(address);
    let utxoTotal = 0n;

    for (const utxo of utxos) {
      const key = outpoint(utxo.txid, utxo.vout);
      expect(observed.has(key), key + ' appears more than once').to.equal(false);
      expect(await tracker.mempoolDb.getInput(utxo.txid, utxo.vout), key + ' is both spent and unspent').to.equal(null);
      observed.set(key, { addressIndex, value: BigInt(utxo.value) });
      utxoTotal += BigInt(utxo.value);
    }

    const balanceTotal = amountToSatoshi(info.balances.confirmed) + amountToSatoshi(info.balances.pending);
    expect(balanceTotal, address + ' balance differs from its UTXO sum').to.equal(utxoTotal);
  }

  expect([...observed.keys()].sort()).to.deep.equal([...expected.keys()].sort());
  for (const [key, value] of expected) expect(observed.get(key), key).to.deep.equal(value);
}

// Two confirmed coinbase outputs, the starting set every phase below edits.
async function seedTwoCoinbases(tracker) {
  const coinbase0 = makeTx({
    txid: fixedHash('coinbase-0'),
    ins: [{ hash: Buffer.alloc(32), index: 0xffffffff, script: Buffer.alloc(4) }],
    outs: [makeOutput(0, 5000000000)]
  });
  const coinbase1 = makeTx({
    txid: fixedHash('coinbase-1'),
    ins: [{ hash: Buffer.alloc(32), index: 0xffffffff, script: Buffer.alloc(4) }],
    outs: [makeOutput(1, 3000000000)]
  });
  const block0 = makeBlock(0, '0'.repeat(64), [coinbase0], fixedHash('block-0'));
  const block1 = makeBlock(1, block0.hash, [coinbase1], fixedHash('block-1'));
  await commitBlock(tracker, block0);
  await commitBlock(tracker, block1);
  return { coinbase0, coinbase1, block1 };
}

function confirmedSet(coinbase0, coinbase1) {
  return new Map([
    [outpoint(coinbase0.getId(), 0), { addressIndex: 0, value: 5000000000n }],
    [outpoint(coinbase1.getId(), 0), { addressIndex: 1, value: 3000000000n }]
  ]);
}

// The original spends both coinbases; the replacement spends only the first.
function originalAndReplacement(coinbase0, coinbase1) {
  const original = makeTx({
    txid: fixedHash('mempool-original'),
    ins: [makeSpendInput(coinbase0.getId()), makeSpendInput(coinbase1.getId())],
    outs: [makeOutput(2, 7000000000)]
  });
  const replacement = makeTx({
    txid: fixedHash('mempool-replacement'),
    ins: [makeSpendInput(coinbase0.getId())],
    outs: [makeOutput(3, 4500000000)]
  });
  return { original, replacement };
}

module.exports = {
  TEST_KEYS,
  amountToSatoshi,
  makeOutput,
  makeSpendInput,
  makeTx,
  makeBlock,
  createTestTracker,
  closeTracker,
  expect,
  createHash,
  fixedHash,
  outpoint,
  commitBlock,
  installMempoolNode,
  cleanupConfirmedMempoolTransactions,
  rewindTip,
  checkInvariants,
  seedTwoCoinbases,
  confirmedSet,
  originalAndReplacement
};
