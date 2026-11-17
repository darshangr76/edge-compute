# Edge Compute: Local-First Spatial AI Agent

A 100% local, zero-cloud AI spatial agent for WebXR. Built for the Meta VR Start Developer Competition.

## 🏗️ Architecture
*   **The AI Brain:** Runs locally via Ollama (Qwen 2.5 7B). Constrained by GBNF grammar to guarantee 100% valid JSON.
*   **The Backend (C++):** A custom C++ WebSocket bridge using `cpp-httplib` with OpenSSL for secure WSS transport. Handles state management, multi-step plan execution, and scene memory.
*   **The Frontend (WebXR):** Built with Three.js. Tracks hand movements, renders 3D objects, and connects securely to the C++ backend.

## 🧠 Agentic Capabilities
*   **Multi-Step Planning:** Executes complex sequences (e.g., "spawn three cubes").
*   **Plan-Level Undo:** Reverses entire plans with a single command.
*   **Semantic Targeting:** Targets objects by color or type based on memory.
*   **Explain + Predict:** The AI explains its actions and suggests next steps.

## 🚀 Quick Start
1. **Start Ollama:** `ollama serve` (Make sure you have `qwen2.5:7b` pulled).
2. **Build the Backend:** 
   ```bash
   cd backend
   g++ -std=c++17 -O2 src/main.cpp -o build/edge-server -Iinclude -lssl -lcrypto -lpthread

YouTube link 
https://youtu.be/ZexDESrvYbk
