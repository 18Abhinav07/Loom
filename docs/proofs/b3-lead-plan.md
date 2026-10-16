---
goal: Hyperledger Fabric network for multiple clients
sources: [one-line request from the user, "Hyperledger Fabric network for multiple clients"]
test: python -m pytest app
compile: python -m compileall -q app
base: main
tasks:
  - id: network
    title: Fabric network config and bring-up scripts
    owns: [app/network/**]
    reads: []
    after: []
    done: crypto-config and configtx templates exist; a script brings up two orgs with one peer each, one orderer, and one channel; pytest covers config parsing and generated file names
    prompt: |
      Create the Hyperledger Fabric network definition under app/network/.
      - crypto-config.yaml and configtx.yaml describing two peer orgs (org1, org2) and one orderer org, with one channel "clientschannel".
      - docker-compose.yaml that starts one orderer, one peer per org, and a CouchDB per peer.
      - scripts/up.sh and scripts/down.sh that generate crypto material, create the channel, and join both peers.
      - A small Python module app/network/config.py that loads the channel name and org list from a single settings file, so the client layer and tests share one source.
      - pytest tests in app/network/tests/ that validate the YAML files parse and the settings module returns the expected org list. Do not require Docker to run the tests.
      Do not touch files outside app/network/.

  - id: chaincode
    title: Multi-client asset chaincode
    owns: [app/chaincode/**]
    reads: [app/network/config.py]
    after: [network]
    done: chaincode unit tests pass; exposes create, read, update, transfer and list asset functions with per-client ownership checks
    prompt: |
      Write the Fabric chaincode under app/chaincode/ in Python using the fabric-chaincode-python shim.
      - Asset model: id, owner_msp, owner_client, value, updated_at.
      - Functions: CreateAsset, ReadAsset, UpdateAsset, TransferAsset, ListAssetsByClient.
      - Ownership: only the owning client (matched by the caller's client id from the transaction creator) may update or transfer an asset; other clients get a clear error.
      - Keep business logic in plain functions that take a stub-like interface so unit tests run without a peer.
      - Tests live in app/chaincode/tests/. Do not touch app/network/ or app/client/.

  - id: client-sdk
    title: Python client layer for multiple clients
    owns: [app/client/**]
    reads: [app/network/config.py, app/chaincode/**]
    after: [network, chaincode]
    done: client wrapper submits and evaluates transactions per client identity; unit tests with a mocked gateway pass
    prompt: |
      Build the Python client layer under app/client/.
      - A ClientSession class per enrolled client identity (org + client name) that wraps Fabric gateway calls for the chaincode functions.
      - A factory that loads each client's certificate and key from the crypto material path given in app/network/config.py.
      - Methods mirror the chaincode: create, read, update, transfer, list.
      - Map chaincode errors to Python exceptions with the original message.
      - Tests in app/client/tests/ use a mocked gateway; no live network needed.
      Do not modify files under app/network/ or app/chaincode/.
---

# Notes

- Drafted from a one-line request. Assumptions to confirm:
  - Two peer orgs plus one orderer, one channel, CouchDB state database.
  - Chaincode written in Python with the Fabric Python shim to match the repo's Python-only layout.
  - Client layer uses a Python Fabric gateway SDK.
- The repo currently has no test runner configured (`testCmd` is null in .loom/config.json); the plan uses `python -m pytest app`, which needs pytest installed.
- Tests are written to run without Docker or a live network.
