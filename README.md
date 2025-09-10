# XChainUtxoTracker

**XChainUtxoTracker** sorts all inputs and outputs of all blockchain transactions in a database and then serves the balance, utxos, and the oldest transaction associated with an address through an API.

---

## 💻 Installation

Clone this repository. Make sure you have Node.js y npm installed on your system.

```bash
git clone [https://github.com/XChain-platform/xchain-utxo-tracker.git](https://XChain-platform/xchain-utxo-tracker.git)
cd XChainUtxoTracker
npm install
```
Para ejecutar el servidor, usa el siguiente comando:

```bash
npm api
```

---

## 📖 API

There are two interfaces for **XChainUtxoTracker** API: **REST** y **JSON-RPC**.

### REST Endpoints 

All REST endpoints are designed to be simple and straightforward using **GET** requests.

| Endpoint | Description | Parameters | Response Example |
| :--- | :--- | :--- | :--- |
| `GET /utxos/:address` | Gets the UTXOs (Unspent Transaction Outputs) list for a specific address. | `address` (string) | [<br>&emsp;{<br>&emsp;&emsp;"txid":"850c6...3a8bcb1",<br>&emsp;&emsp;"vout":0,<br>&emsp;&emsp;"value":"100000000",<br>&emsp;&emsp;"height":119,<br>&emsp;&emsp;"confirmations":13,<br>&emsp;&emsp;"amount":1,<br>&emsp;&emsp;"scriptPubKey":"76a914...7988ac"<br>&emsp;}<br>]|
| `GET /oldesttx/:address` | Gets the oldest transaction for an address in the blockchain. | `address` (string) | {<br>&emsp;"txid": "850c6...3a8bcb1",<br>&emsp;"vout": 0,<br>&emsp;"value": "100000000",<br>&emsp;"height": 119,<br>&emsp;"confirmations": 13,<br>&emsp;"amount": 1<br>} |
| `GET /balance/:address` | Gets the total balance of an address. | `address` (string) | `12.345678` (value is a number, is not in satoshis) |
| `GET /info/:address` | Gets the confirmed and pending balances and UTXO count of an address. | `address` (string) | <br>{<br>&emsp;"address": "1EXAMPLE..ABC",<br>&emsp;"type": "p2pkh",<br>&emsp;"balances": {<br>&emsp;&emsp;"confirmed": "1.00000000",<br>&emsp;&emsp;"pending": "0.00000000",<br>&emsp;&emsp;"received": "1.00000000"<br>&emsp;},<br>&emsp;"utxos":{<br>&emsp;&emsp;"confirmed": 1,<br>&emsp;&emsp;"pending": 0<br>&emsp;}<br>} |




### JSON-RPC Methods

The JSON-RPC interface allows to do the same requests and some others using **POST** calls

**Endpoint:** `POST /`

**Request example:**

```json
{
  "jsonrpc": "2.0",
  "method": "get_balance",
  "params": {
    "address": "bc1q..."
  },
  "id": 1
}
```

| Method | Description | Parameters | Response Example |
| :--- | :--- | :--- | :--- |
| `ping` | Useful to check if the server is up. | None | `{ "status": "success" }` |
| `get_utxos` | Gets the utxos for an address. | `{ "address": "string" }` | `{ "utxos": [ { "txid": "...", "vout": 0, "value": 10000 }, ... ] }` |
| `get_oldest_tx` | Gets the oldest transaction in the blockchain for an address. | `{ "address": "string" }` | `{ "oldest_tx": { "txid": "...", "blockhash": "...", ... } }` |
| `get_balance` | Gets the total balance of an address | `{ "address": "string" }` | `{ "balance": 12345678 }` |
| `get_info` | Gets confirmed and pending balances and UTXO count of an address. | `{ "address": "string" }` | `{ "address": ..., "balances":{"confirmed":..., "pending":...} }` |
| `getbootstrap` | Starts a task in the server to create a compressed backup of the database. | `{ "filename": "string" }` | `{ "task_id": "uuid" }` |
| `getbootstrapstatus` | Gets the status of a task. | `{ "taskid": "string" }` | `{ "progress": 50, "filename": "..." }` |
| `restorebootstrap` | Restores a compressed backup in the server. | `{ "filename": "string" }` | `{ "task_id": "uuid" }` |
| `getbootstraprestorestatus`| Gets the status of a backup restoration. | `{ "taskid": "string" }` | `{ "progress": 80, "filename": "..." }` |

---
