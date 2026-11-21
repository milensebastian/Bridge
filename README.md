# Bridge

Send a photo from your phone to your laptop by scanning a QR code. Bridge connects two browsers so you can move files and clipboard text without installing an app or creating an account.

[Open Bridge](https://bridge-eight-beryl.vercel.app/) · [Phone-to-laptop guide](https://bridge-eight-beryl.vercel.app/guide/)

[![Bridge phone-to-laptop file sharing](public/bridge-preview.png)](https://bridge-eight-beryl.vercel.app/)

1. On the laptop, select **Create a connection**.
2. Scan the QR code with your phone and confirm the matching symbols on both screens.
3. On either device, open **Files** and choose what to send. The other device can save the download.

**Files** streams encrypted files and folders to browser storage. Folders download as ZIP archives. **Clipboard** sends text and links. **Touch & sign** turns the paired phone into a PDF slide remote or a signature pad. Camera scanning is available for pairing.

## Run locally

```sh
npm install
npm run dev
```

Open `http://localhost:5173`. Create a connection, copy its pairing link into a second browser window, and confirm the symbols on **both** screens. You can then send text and links, copy received entries, or explicitly read your clipboard. Clipboard access requires browser permission. Optional focus sync is off by default. The desktop/companion toggle changes the layout for testing.

```sh
npm run build
npm test
```

## Use on a phone / deploy

Serve the Vite build and reverse-proxy `/signal` to the Node server behind **HTTPS/WSS**. Localhost is a secure-context exception; opening an HTTP LAN IP on a phone is not. The QR uses the current page origin, so load the desktop page through the same HTTPS address reachable from the phone. `npm run server` starts the relay. Set `NODE_ENV=production`, `ALLOWED_ORIGINS` to an explicit comma-separated allowlist, and optionally `PORT` (default 8787). The relay refuses production startup without the allowlist.

Bridge uses Cloudflare public STUN to discover direct connections across networks. An explicit `VITE_ICE_SERVERS` JSON array overrides the default. For restrictive networks, configure a TURN REST-compatible service such as coturn with shared-secret authentication. On Render, set `TURN_URLS` to its comma-separated TURN addresses and `TURN_SHARED_SECRET` to its authentication secret. The signaling service issues hour-long credentials when each device joins. Configure allocation quotas and bandwidth limits on the TURN service before enabling it on a public deployment.

Set the Vercel Production Config variable `VITE_RELAY_URL` to the signaling endpoint (`wss://.../signal`). The frontend also accepts the older `VITE_SIGNAL_URL` name.

## Structure

- `src/App.tsx`, `src/style.css`: responsive light/dark utility interface.
- `src/lib/bridge.ts`: connection lifecycle, ordered encrypted messaging, replay counters, verification gate, ICE candidate queuing.
- `src/lib/crypto.ts`: ephemeral identities, session derivation, authenticated encryption.
- `src/components/Scanner.tsx`: rear-camera QR scanning with jsQR.
- `src/store/session.ts`: in-memory session and bounded clipboard history.
- `src/store/transfers.ts`: transfer progress and received download references.
- `server/`: bounded, two-peer signaling rooms; five-minute expiry, size and rate limits.
- `tests/`: key agreement, tampering/context isolation, and relay integration tests.

## Security and scope

Public host keys travel in the QR URL fragment, not HTTP requests. Private keys stay in the tab. Both devices must manually compare the full four-symbol code before clipboard exchange. Verification is encrypted and gates both sending and receiving. Encryption uses random 96-bit IVs, direction-bound authenticated context, and monotonically increasing per-direction replay counters. The relay closes after WebRTC connects. It retains only transient signaling room membership and never logs or stores payloads. Session history holds at most 50 entries of 12,000 characters and clears on disconnect/reload. Clipboard messages are capped to fit within conservative WebRTC message sizes.

Compare all four symbols before confirming the connection. Clipboard history is session-only. Completed downloads can be reopened from local browser storage for 24 hours. After a disconnect, create a fresh pairing session.

Cryptographic API reference: [MDN Web Crypto key derivation](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/deriveKey).
