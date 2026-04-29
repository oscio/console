import { createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto"

// Per-agent SSH keypair generator.
//
// Used by VM-attached agents only — the agent pod SSH-shims its bash
// into the workspace pod, so it needs a private key the workspace's
// sshd will accept. Keys are throwaway: tied to the agent's lifetime,
// stored in a k8s Secret, regenerated on agent re-create.
//
// We use ed25519 (small, fast, modern) and emit the private key in
// PKCS#8 PEM format. OpenSSH client (the one in our agent image,
// 9.x) reads PKCS#8 PEM ed25519 private keys natively.
//
// The public key is encoded by hand into OpenSSH's wire format —
// `ssh-ed25519 <base64> <comment>` — because Node's crypto only
// emits SPKI / PEM, not the SSH-specific encoding.

export type AgentKeypair = {
  // Private key in PKCS#8 PEM. Contents written into the agent
  // pod's Secret-mounted file at /etc/agent-ssh/id_ed25519.
  privateKeyPem: string
  // Single-line `ssh-ed25519 BASE64 comment` form — what goes into
  // the workspace's authorized_keys.
  publicKeyOpenssh: string
}

export function generateAgentKeypair(comment: string): AgentKeypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  })
  // Round-trip through KeyObject to get the SPKI DER (which has the
  // raw 32-byte ed25519 public key in its tail).
  const pubObj = createPublicKey(publicKey)
  return {
    privateKeyPem: privateKey,
    publicKeyOpenssh: encodeSshEd25519(pubObj, comment),
  }
}

function encodeSshEd25519(key: KeyObject, comment: string): string {
  const der = key.export({ type: "spki", format: "der" }) as Buffer
  // Ed25519 SPKI DER is fixed shape: 12-byte AlgorithmIdentifier +
  // bit-string header + 32-byte raw public key. Take the last 32.
  const raw = der.subarray(der.length - 32)
  const algo = "ssh-ed25519"
  const algoBytes = Buffer.from(algo, "ascii")
  const algoLen = u32be(algoBytes.length)
  const keyLen = u32be(raw.length)
  const blob = Buffer.concat([algoLen, algoBytes, keyLen, raw])
  return `${algo} ${blob.toString("base64")} ${comment}`
}

function u32be(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n, 0)
  return b
}
