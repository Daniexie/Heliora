#!/usr/bin/env bash
# Builds the Groth16 artifacts served at NEXT_PUBLIC_ZK_ARTIFACTS_URL (default: public/zk).
#
# Phase 1 uses the public PSE Perpetual Powers of Tau (contribution 80, beacon applied,
# prepared for phase 2). Groth16 needs a circuit-specific phase 2: for production, have
# several independent parties run `snarkjs zkey contribute` in turn before the beacon.
#
# Requires circom >= 2.1.6 and the repo's dev dependencies (snarkjs, circomlib).
# Usage: BEACON=<64 hex chars of public randomness, e.g. a future block hash> circuits/setup.sh
set -euo pipefail

: "${BEACON:?set BEACON to 64 hex characters of public, unpredictable randomness}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$ROOT/build/zk"
OUT="$ROOT/public/zk"
PTAU="$BUILD/ppot_0080_10.ptau"
SNARKJS="$ROOT/node_modules/.bin/snarkjs"
mkdir -p "$BUILD" "$OUT"

[ -f "$PTAU" ] || curl -fL -o "$PTAU" https://pse-trusted-setup-ppot.s3.eu-central-1.amazonaws.com/pot28_0080/ppot_0080_10.ptau

for circuit in age_eligibility insurance_coverage; do
  circom "$ROOT/circuits/$circuit.circom" --r1cs --wasm -l "$ROOT/node_modules" -o "$BUILD"
  "$SNARKJS" groth16 setup "$BUILD/$circuit.r1cs" "$PTAU" "$BUILD/${circuit}_0000.zkey"
  "$SNARKJS" zkey contribute "$BUILD/${circuit}_0000.zkey" "$BUILD/${circuit}_0001.zkey" \
    --name="Heliora contribution" -e="$(openssl rand -hex 32)"
  "$SNARKJS" zkey beacon "$BUILD/${circuit}_0001.zkey" "$OUT/$circuit.zkey" "$BEACON" 10 -n="Final beacon"
  "$SNARKJS" zkey verify "$BUILD/$circuit.r1cs" "$PTAU" "$OUT/$circuit.zkey"
  "$SNARKJS" zkey export verificationkey "$OUT/$circuit.zkey" "$OUT/$circuit.vkey.json"
  cp "$BUILD/${circuit}_js/$circuit.wasm" "$OUT/$circuit.wasm"
done
