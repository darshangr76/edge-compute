#!/bin/bash
set -e
cd "$(dirname "$0")"
mkdir -p build

OPENSSL_DIR=$(brew --prefix openssl)

clang++ -std=c++17 -O2 \
  -DCPPHTTPLIB_OPENSSL_SUPPORT \
  -I third_party \
  -I${OPENSSL_DIR}/include \
  src/main.cpp \
  -o build/edge-server \
  -L${OPENSSL_DIR}/lib \
  -lssl -lcrypto \
  -framework CoreFoundation -framework Security

echo "✅ Built: backend/build/edge-server"
