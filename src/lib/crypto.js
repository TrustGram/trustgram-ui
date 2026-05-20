// src/primitives.ts
function toBase64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function fromBase64(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
}
async function generateKeyPair() {
  return crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveKey", "deriveBits"]
  );
}
async function exportPublicKey(key) {
  const raw = await crypto.subtle.exportKey("raw", key);
  return toBase64(raw);
}
async function importPublicKey(b64) {
  return crypto.subtle.importKey(
    "raw",
    fromBase64(b64),
    { name: "ECDH", namedCurve: "P-256" },
    true,
    []
  );
}
async function deriveBits(privateKey, publicKey) {
  return crypto.subtle.deriveBits(
    { name: "ECDH", public: publicKey },
    privateKey,
    256
  );
}
async function hkdf(inputKey, salt, info, length = 32) {
  const key = await crypto.subtle.importKey(
    "raw",
    inputKey,
    "HKDF",
    false,
    ["deriveBits"]
  );
  return crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info: new TextEncoder().encode(info)
    },
    key,
    length * 8
  );
}
async function hkdfExpand(inputKey, salt, info) {
  const output = await hkdf(inputKey, salt, info, 64);
  return {
    key1: output.slice(0, 32),
    key2: output.slice(32, 64)
  };
}
async function importAESKey(raw) {
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}
async function aesEncrypt(keyBytes, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importAESKey(keyBytes);
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded
  );
  return {
    iv: toBase64(iv.buffer),
    ciphertext: toBase64(ciphertext)
  };
}
async function aesDecrypt(keyBytes, iv, ciphertext) {
  const key = await importAESKey(keyBytes);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(iv) },
    key,
    fromBase64(ciphertext)
  );
  return new TextDecoder().decode(decrypted);
}
async function sha256(data) {
  return crypto.subtle.digest("SHA-256", data);
}
async function generateSigningKeyPair() {
  return crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"]
  );
}
async function exportSigningPublicKey(key) {
  const spki = await crypto.subtle.exportKey("spki", key);
  return toBase64(spki);
}
async function importSigningPublicKey(b64) {
  return crypto.subtle.importKey(
    "spki",
    fromBase64(b64),
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["verify"]
  );
}
async function ecdsaSign(privateKey, message) {
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    message
  );
  return toBase64(sig);
}
async function ecdsaVerify(publicKey, signatureB64, message) {
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    fromBase64(signatureB64),
    message
  );
}

// src/x3dh.ts
var ONE_TIME_PREKEY_COUNT = 10;
async function generateIdentityBundle() {
  const identityKey = await generateKeyPair();
  const signingKey = await generateSigningKeyPair();
  const signedPreKey = await generateKeyPair();
  const oneTimePreKeys = [];
  for (let i = 0; i < ONE_TIME_PREKEY_COUNT; i++) {
    oneTimePreKeys.push(await generateKeyPair());
  }
  return { identityKey, signingKey, signedPreKey, oneTimePreKeys };
}
async function signSignedPreKey(signingKey, signedPreKeyPub) {
  const rawSpk = await crypto.subtle.exportKey("raw", signedPreKeyPub);
  return ecdsaSign(signingKey.privateKey, rawSpk);
}
async function exportPublicBundle(bundle) {
  const signedPreKeySignature = await signSignedPreKey(bundle.signingKey, bundle.signedPreKey.publicKey);
  return {
    identityKey: await exportPublicKey(bundle.identityKey.publicKey),
    signingKey: await exportSigningPublicKey(bundle.signingKey.publicKey),
    signedPreKey: await exportPublicKey(bundle.signedPreKey.publicKey),
    signedPreKeySignature,
    oneTimePreKeys: await Promise.all(
      bundle.oneTimePreKeys.map((kp) => exportPublicKey(kp.publicKey))
    )
  };
}
async function verifyRecipientBundle(bundle) {
  if (!bundle.signedPreKeySignature) {
    throw new Error("Recipient bundle is missing SPK signature");
  }
  const signingPub = await importSigningPublicKey(bundle.signingKey);
  const rawSpk = fromBase64(bundle.signedPreKey);
  const ok = await ecdsaVerify(signingPub, bundle.signedPreKeySignature, rawSpk);
  if (!ok) {
    throw new Error("Invalid SPK signature \u2014 possible MITM attack");
  }
}
async function x3dhSend(myIdentityKey, recipientBundle) {
  await verifyRecipientBundle(recipientBundle);
  const ephemeralKey = await generateKeyPair();
  const theirIK = await importPublicKey(recipientBundle.identityKey);
  const theirSPK = await importPublicKey(recipientBundle.signedPreKey);
  const dh1 = await deriveBits(myIdentityKey.privateKey, theirSPK);
  const dh2 = await deriveBits(ephemeralKey.privateKey, theirIK);
  const dh3 = await deriveBits(ephemeralKey.privateKey, theirSPK);
  let masterSecret;
  if (recipientBundle.oneTimePreKey) {
    const theirOPK = await importPublicKey(recipientBundle.oneTimePreKey);
    const dh4 = await deriveBits(ephemeralKey.privateKey, theirOPK);
    masterSecret = await combineDH(dh1, dh2, dh3, dh4);
  } else {
    masterSecret = await combineDH3(dh1, dh2, dh3);
  }
  return {
    masterSecret,
    senderBundle: {
      identityKey: await exportPublicKey(myIdentityKey.publicKey),
      ephemeralKey: await exportPublicKey(ephemeralKey.publicKey),
      oneTimePreKeyId: recipientBundle.oneTimePreKey ?? null
    }
  };
}
async function x3dhReceive(myIdentityKey, mySignedPreKey, myOneTimePreKey, senderIdentityKeyB64, senderEphemeralKeyB64) {
  const theirIK = await importPublicKey(senderIdentityKeyB64);
  const theirEK = await importPublicKey(senderEphemeralKeyB64);
  const dh1 = await deriveBits(mySignedPreKey.privateKey, theirIK);
  const dh2 = await deriveBits(myIdentityKey.privateKey, theirEK);
  const dh3 = await deriveBits(mySignedPreKey.privateKey, theirEK);
  if (myOneTimePreKey) {
    const dh4 = await deriveBits(myOneTimePreKey.privateKey, theirEK);
    return combineDH(dh1, dh2, dh3, dh4);
  }
  return combineDH3(dh1, dh2, dh3);
}
async function combineDH(dh1, dh2, dh3, dh4) {
  const combined = new Uint8Array(128);
  combined.set(new Uint8Array(dh1), 0);
  combined.set(new Uint8Array(dh2), 32);
  combined.set(new Uint8Array(dh3), 64);
  combined.set(new Uint8Array(dh4), 96);
  const salt = new Uint8Array(32).fill(0).buffer;
  return hkdf(combined.buffer, salt, "TrustGram_X3DH_v1");
}
async function combineDH3(dh1, dh2, dh3) {
  const combined = new Uint8Array(96);
  combined.set(new Uint8Array(dh1), 0);
  combined.set(new Uint8Array(dh2), 32);
  combined.set(new Uint8Array(dh3), 64);
  const salt = new Uint8Array(32).fill(0).buffer;
  return hkdf(combined.buffer, salt, "TrustGram_X3DH_v1");
}

// src/ratchet.ts
var MAX_SKIP = 100;
async function initSenderRatchet(masterSecret, theirPublicKeyB64) {
  const dhSendKey = await generateKeyPair();
  const theirPub = await importPublicKey(theirPublicKeyB64);
  const dh = await deriveBits(dhSendKey.privateKey, theirPub);
  const { key1: rootKey, key2: sendChainKey } = await hkdfExpand(
    masterSecret,
    dh,
    "TrustGram_Ratchet_v1"
  );
  return {
    dhSendKey,
    dhRecvKey: theirPub,
    rootKey,
    sendChainKey,
    recvChainKey: null,
    sendCount: 0,
    recvCount: 0,
    prevSendCount: 0,
    skippedKeys: []
  };
}
async function initReceiverRatchet(masterSecret, spkKeyPair) {
  return {
    dhSendKey: spkKeyPair,
    dhRecvKey: null,
    rootKey: masterSecret,
    sendChainKey: null,
    recvChainKey: null,
    sendCount: 0,
    recvCount: 0,
    prevSendCount: 0,
    skippedKeys: []
  };
}
async function ratchetEncrypt(state, plaintext) {
  const { messageKey, nextChainKey } = await advanceChain(state.sendChainKey);
  const dhPub = await exportPublicKey(state.dhSendKey.publicKey);
  const { iv, ciphertext } = await aesEncrypt(messageKey, plaintext);
  const message = {
    dhPub,
    n: state.sendCount,
    pn: state.prevSendCount,
    iv,
    ciphertext
  };
  const nextState = {
    ...state,
    sendChainKey: nextChainKey,
    sendCount: state.sendCount + 1
  };
  return { message, state: nextState };
}
async function ratchetDecrypt(state, message) {
  const skipped = state.skippedKeys.find(
    (k) => k.dhKey === message.dhPub && k.n === message.n
  );
  if (skipped) {
    const plaintext2 = await aesDecrypt(skipped.messageKey, message.iv, message.ciphertext);
    const nextState2 = {
      ...state,
      skippedKeys: state.skippedKeys.filter((k) => k !== skipped)
    };
    return { plaintext: plaintext2, state: nextState2 };
  }
  let currentState = state;
  const theirDhPub = await importPublicKey(message.dhPub);
  const isDHRatchetNeeded = !state.dhRecvKey || await exportPublicKey(state.dhRecvKey) !== message.dhPub;
  if (isDHRatchetNeeded) {
    currentState = await skipMessageKeys(currentState, message.pn);
    currentState = await dhRatchetStep(currentState, theirDhPub);
  }
  currentState = await skipMessageKeys(currentState, message.n);
  const { messageKey, nextChainKey } = await advanceChain(currentState.recvChainKey);
  const plaintext = await aesDecrypt(messageKey, message.iv, message.ciphertext);
  const nextState = {
    ...currentState,
    recvChainKey: nextChainKey,
    recvCount: currentState.recvCount + 1
  };
  return { plaintext, state: nextState };
}
async function dhRatchetStep(state, theirPub) {
  const dh1 = await deriveBits(state.dhSendKey.privateKey, theirPub);
  const { key1: rootKey1, key2: recvChainKey } = await hkdfExpand(
    state.rootKey,
    dh1,
    "TrustGram_Ratchet_v1"
  );
  const newDhSendKey = await generateKeyPair();
  const dh2 = await deriveBits(newDhSendKey.privateKey, theirPub);
  const { key1: rootKey2, key2: sendChainKey } = await hkdfExpand(
    rootKey1,
    dh2,
    "TrustGram_Ratchet_v1"
  );
  return {
    ...state,
    dhSendKey: newDhSendKey,
    dhRecvKey: theirPub,
    rootKey: rootKey2,
    sendChainKey,
    recvChainKey,
    prevSendCount: state.sendCount,
    sendCount: 0,
    recvCount: 0
  };
}
async function advanceChain(chainKey) {
  const salt = new Uint8Array(32).fill(0).buffer;
  const messageKey = await hkdf(chainKey, salt, "TrustGram_MessageKey_v1");
  const nextChainKey = await hkdf(chainKey, salt, "TrustGram_ChainKey_v1");
  return { messageKey, nextChainKey };
}
async function skipMessageKeys(state, until) {
  if (until - state.recvCount > MAX_SKIP) {
    throw new Error("Too many skipped messages");
  }
  let chainKey = state.recvChainKey;
  const skippedKeys = [...state.skippedKeys];
  let recvCount = state.recvCount;
  while (recvCount < until) {
    const { messageKey, nextChainKey } = await advanceChain(chainKey);
    skippedKeys.push({
      dhKey: await exportPublicKey(state.dhRecvKey),
      n: recvCount,
      messageKey
    });
    chainKey = nextChainKey;
    recvCount++;
  }
  return { ...state, recvChainKey: chainKey, recvCount, skippedKeys };
}

// src/index.ts
async function createIdentity() {
  return generateIdentityBundle();
}
async function getPublicBundle(identity) {
  return exportPublicBundle(identity);
}
async function signSPK(identity, newSignedPreKey) {
  return signSignedPreKey(identity.signingKey, newSignedPreKey.publicKey);
}
async function initiateSession(myIdentity, theirBundle) {
  const { masterSecret, senderBundle } = await x3dhSend(myIdentity.identityKey, theirBundle);
  const state = await initSenderRatchet(masterSecret, theirBundle.signedPreKey);
  return { state, senderInfo: senderBundle };
}
async function acceptSession(myIdentity, usedOneTimePreKey, senderIdentityKey, senderEphemeralKey) {
  let usedOPK = null;
  if (usedOneTimePreKey) {
    for (const kp of myIdentity.oneTimePreKeys) {
      const pub = await exportPublicKey(kp.publicKey);
      if (pub === usedOneTimePreKey) {
        usedOPK = kp;
        break;
      }
    }
    if (!usedOPK) throw new Error("One-time pre-key not found");
  }
  const masterSecret = await x3dhReceive(
    myIdentity.identityKey,
    myIdentity.signedPreKey,
    usedOPK,
    senderIdentityKey,
    senderEphemeralKey
  );
  return initReceiverRatchet(masterSecret, myIdentity.signedPreKey);
}
async function encryptMessage(state, plaintext) {
  return ratchetEncrypt(state, plaintext);
}
async function decryptMessage(state, message) {
  return ratchetDecrypt(state, message);
}
async function computeFingerprint(myIdentity, theirIdentityKeyB64, theirSigningKeyB64) {
  const myIdRaw = new Uint8Array(await crypto.subtle.exportKey("raw", myIdentity.identityKey.publicKey));
  const mySignRaw = new Uint8Array(fromBase64(await exportSigningPublicKey(myIdentity.signingKey.publicKey)));
  const myHalf = new Uint8Array(myIdRaw.length + mySignRaw.length);
  myHalf.set(myIdRaw, 0);
  myHalf.set(mySignRaw, myIdRaw.length);
  const theirIdRaw = new Uint8Array(fromBase64(theirIdentityKeyB64));
  const theirSignRaw = new Uint8Array(fromBase64(theirSigningKeyB64));
  const theirHalf = new Uint8Array(theirIdRaw.length + theirSignRaw.length);
  theirHalf.set(theirIdRaw, 0);
  theirHalf.set(theirSignRaw, theirIdRaw.length);
  let cmp = 0;
  const minLen = Math.min(myHalf.length, theirHalf.length);
  for (let i = 0; i < minLen && cmp === 0; i++) {
    cmp = myHalf[i] - theirHalf[i];
  }
  if (cmp === 0) cmp = myHalf.length - theirHalf.length;
  const combined = cmp < 0 ? new Uint8Array([...myHalf, ...theirHalf]) : new Uint8Array([...theirHalf, ...myHalf]);
  const hash = await sha256(combined.buffer);
  const hex = Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
  const display = hex.match(/.{1,4}/g).join(" ");
  return { hex, display };
}
export {
  acceptSession,
  computeFingerprint,
  createIdentity,
  decryptMessage,
  encryptMessage,
  getPublicBundle,
  initiateSession,
  signSPK
};
//# sourceMappingURL=crypto.js.map
