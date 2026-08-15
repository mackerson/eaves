# Device Sync

Optional device synchronization uses a **coordination model** (like Tailscale)
rather than cloud storage. **LAN peer-to-peer sync (Phase 1) has shipped**;
cross-network coordination is on the roadmap.

Diagrams and invariants: [architecture overview](architecture/README.md).
Implementation: `src/main/services/sync/SyncService.ts`.

## Direct P2P sync (free, always) — Phase 1 shipped

- Devices connect directly over IP (local network today; internet via
  coordination later)
- Direct peer-to-peer encrypted sync between your devices
- Pairing pins a device certificate; a peer presenting a different identity
  is dropped
- No servers, no cloud storage, no middleman
- Works on LAN, VPN, or direct IP connection
- Like AirDrop, but for any of your devices that can reach each other

## Eaves Mesh — in development, optional, premium

- Mobile phone app
- Helps devices find each other across networks and NAT
- Provides encrypted relay when direct connection isn't possible
- End-to-end encrypted — we **can't read your data**
- Coordination metadata only (device info, connection logs)
- Your conversations, agents, and content never touch our servers

## What this means

**Privacy by architecture:**

- We coordinate connections, not content
- Even if our servers were compromised, your data is safe
- End-to-end encryption means we physically can't read your conversations
- Similar trust model to Signal, Tailscale, Syncthing
