import { Buffer } from "buffer";
import React, { useEffect, useMemo, useState, useRef } from "react";
import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  Commitment,
} from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddress,
  getMint,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";

// === DEVNET ADDRESSES ===
const PROGRAM_ID = new PublicKey(
  "An4RAQ5KT7jbsQn6N1SdQfXV7MJCYnRsZRY2DTxNrsHU"
);
const RESERVE_MINT = new PublicKey("6LLA1CwguZrV2og8yy5RWj9KhtPHjD2oxpupHLHckA73"); // Dec 9
const VAULT_MINT = new PublicKey("C2QoyXuuWjTk5JCY2inLe3EQrWLry2ByL5FxyrwN5qNr"); // Dec 6

const VAULT_DEC = 6;
const COMMIT: Commitment = "confirmed";

// === Claim UI only (now with a soft cooldown) ===
const CLAIM_VAULT_AMOUNT_UI = 100;
const CLAIM_VAULT_AMOUNT_BASE = BigInt(
  Math.round(CLAIM_VAULT_AMOUNT_UI * 10 ** VAULT_DEC)
);

// ---- Soft cooldown config (front-only) ----
const COOLDOWN_MIN = 120; // minutes
const keyFor = (walletB58: string | null) =>
  `vault_claim_${PROGRAM_ID.toBase58()}_${VAULT_MINT.toBase58()}_${
    walletB58 ?? "no-wallet"
  }`;

// --- URL dynamique pour Phantom deep-link (CSB, Vercel, domaine custom) ---
function getAppUrl() {
  try {
    if (typeof window !== "undefined") {
      const u = new URL(window.location.href);
      // on garde origin + pathname (sans hash/querry)
      return `${u.origin}${u.pathname}`;
    }
  } catch {}
  // fallback utile si rendu côté build sans window
  return "https://f3qtvl.csb.app/";
}

function isMobileUA() {
  if (typeof navigator === "undefined") return false;
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent
  );
}
function isInPhantomInApp() {
  if (typeof navigator === "undefined") return false;
  return /Phantom/i.test(navigator.userAgent);
}
function buildPhantomDeepLink(targetUrl: string) {
  const scheme = `phantom://browse/${encodeURIComponent(targetUrl)}`;
  const universal = `https://phantom.app/ul/browse?url=${encodeURIComponent(
    targetUrl
  )}`;
  return { scheme, universal };
}

// Utils
async function anchorDiscriminator(name: string): Promise<Uint8Array> {
  const preimage = new TextEncoder().encode(`global:${name}`);
  const hash = await crypto.subtle.digest("SHA-256", preimage);
  return new Uint8Array(hash).slice(0, 8);
}
function u64le(n: bigint) {
  const buf = new Uint8Array(8);
  let x = n;
  for (let i = 0; i < 8; i++) {
    buf[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return buf;
}
const fmt0 = (n: number, max = 6) =>
  n.toLocaleString(undefined, { maximumFractionDigits: max });
const fmtInt = (n: number) =>
  Math.floor(n).toLocaleString(undefined, { maximumFractionDigits: 0 });

// Lightweight retry for RPC reads
async function withRetry<T>(
  fn: () => Promise<T>,
  tries = 3,
  delayMs = 250
): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

const getLastClaimTs = (walletB58: string | null) => {
  try {
    const v = localStorage.getItem(keyFor(walletB58));
    return v ? Number(v) : 0;
  } catch {
    return 0;
  }
};
const setLastClaimTs = (walletB58: string | null, ts: number) => {
  try {
    localStorage.setItem(keyFor(walletB58), String(ts));
  } catch {}
};

export default function BurnVaultWidget() {
  const { connection } = useConnection();
  const { publicKey, connected, sendTransaction } = useWallet();

  // Burn state
  const [amountUi, setAmountUi] = useState("");
  const [preview, setPreview] = useState("-");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Indicators
  const [rateNow, setRateNow] = useState("-"); // JitoSOL / 1 VAULT
  const [pctBurn, setPctBurn] = useState("-");
  const [pctReserve, setPctReserve] = useState("-");

  // Live stats
  const [liveReserveUi, setLiveReserveUi] = useState<string>("-");
  const [liveSupplyUi, setLiveSupplyUi] = useState<string>("-");
  const [liveRatio, setLiveRatio] = useState<string>("-");

  // Faucet VAULT balance
  const [faucetVaultUi, setFaucetVaultUi] = useState<string>("-");

  // Claim state
  const [claimLoading, setClaimLoading] = useState(false);
  const [claimErr, setClaimErr] = useState<string | null>(null);

  // ---- Soft cooldown state ----
  const [lastClaimTs, setLastClaimTsState] = useState<number>(0);
  const [nowTs, setNowTs] = useState<number>(Date.now());

  const [debug, setDebug] = useState<{ [k: string]: string }>({});
  const [refreshTick, setRefreshTick] = useState(0);

  // Phantom in-app banner state
  const [showPhantomHint, setShowPhantomHint] = useState(false);
  const [phantomLinks, setPhantomLinks] = useState<{
    scheme: string;
    universal: string;
  } | null>(null);

  // Websocket subscriptions
  const mintSubRef = useRef<number | null>(null);
  const reserveSubRef = useRef<number | null>(null);
  const faucetSubRef = useRef<number | null>(null);

  // PDA/ATA accounts
  const [
    statePda,
    vaultReserveAta,
    faucetVaultAta,
    userVaultAta,
    userReserveAta,
  ] = useMemo(() => {
    try {
      const [state] = PublicKey.findProgramAddressSync(
        [Buffer.from("state"), RESERVE_MINT.toBuffer(), VAULT_MINT.toBuffer()],
        PROGRAM_ID
      );
      const vRes = getAssociatedTokenAddress(
        RESERVE_MINT,
        state,
        true,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      const faucetVault = getAssociatedTokenAddress(
        VAULT_MINT,
        state,
        true,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      const uVault = publicKey
        ? getAssociatedTokenAddress(
            VAULT_MINT,
            publicKey,
            false,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
          )
        : Promise.resolve(null as any);
      const uRes = publicKey
        ? getAssociatedTokenAddress(
            RESERVE_MINT,
            publicKey,
            false,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
          )
        : Promise.resolve(null as any);
      return [state, vRes, faucetVault, uVault, uRes] as const;
    } catch {
      return [
        null,
        Promise.resolve(null as any),
        Promise.resolve(null as any),
        Promise.resolve(null as any),
        Promise.resolve(null as any),
      ] as any;
    }
  }, [publicKey]);

  const [vaultReserveAtaPk, setVaultReserveAtaPk] = useState<PublicKey | null>(
    null
  );
  const [faucetVaultAtaPk, setFaucetVaultAtaPk] = useState<PublicKey | null>(
    null
  );
  const [userVaultAtaPk, setUserVaultAtaPk] = useState<PublicKey | null>(null);
  const [userReserveAtaPk, setUserReserveAtaPk] = useState<PublicKey | null>(
    null
  );

  useEffect(() => {
    (async () => {
      setVaultReserveAtaPk(await vaultReserveAta);
      setFaucetVaultAtaPk(await faucetVaultAta);
      setUserVaultAtaPk(await userVaultAta);
      setUserReserveAtaPk(await userReserveAta);
    })().catch(console.error);
  }, [vaultReserveAta, faucetVaultAta, userVaultAta, userReserveAta]);

  // Init cooldown on wallet change
  useEffect(() => {
    setLastClaimTsState(getLastClaimTs(publicKey?.toBase58() ?? null));
  }, [publicKey]);

  // Tick every 30s to update remaining time text
  useEffect(() => {
    const id = setInterval(() => setNowTs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // Phantom in-app banner mount (single button, deep link + fallback)
  useEffect(() => {
    const onClient = typeof window !== "undefined";
    if (!onClient) return;
    const mobile = isMobileUA();
    const inPhantom = isInPhantomInApp();
    if (mobile && !inPhantom) {
      setShowPhantomHint(true);
      setPhantomLinks(buildPhantomDeepLink(getAppUrl())); // URL dynamique
    } else {
      setShowPhantomHint(false);
    }
  }, []);

  // Compute cooldown status
  const minsElapsed = (nowTs - lastClaimTs) / 60000;
  const cooldownLeftMin = Math.max(0, COOLDOWN_MIN - minsElapsed);
  const cooldownActive = cooldownLeftMin > 0.001;
  const cooldownLabel = (() => {
    if (!cooldownActive) return null;
    const totalSec = Math.ceil(cooldownLeftMin * 60);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}m ${s.toString().padStart(2, "0")}s`;
  })();

  // -------- LIVE STATS (fetch + websocket) --------
  const refreshLive = useMemo(
    () => async () => {
      try {
        if (!statePda || !vaultReserveAtaPk) return;

        const [mintVault, accReserve] = await Promise.all([
          withRetry(() => getMint(connection, VAULT_MINT, COMMIT)),
          withRetry(() => getAccount(connection, vaultReserveAtaPk, COMMIT)),
        ]);

        const supply = Number(mintVault.supply.toString()); // 6d
        const reserve = Number(accReserve.amount.toString()); // 9d

        const supplyUi = supply / 1e6;
        const reserveUi = reserve / 1e9;

        setLiveSupplyUi(fmtInt(supplyUi));
        setLiveReserveUi(fmtInt(reserveUi));

        if (supply > 0) {
          const ratio = reserveUi / supplyUi;
          setLiveRatio(fmt0(ratio, 9));
          setRateNow(fmt0(ratio, 9));
        } else {
          setLiveRatio("-");
          setRateNow("-");
        }

        // Faucet VAULT balance
        try {
          if (faucetVaultAtaPk) {
            const accFaucet = await withRetry(() =>
              getAccount(connection, faucetVaultAtaPk, COMMIT)
            );
            const faucetUi = Number(accFaucet.amount.toString()) / 1e6; // 6d
            setFaucetVaultUi(fmtInt(faucetUi));
          } else {
            setFaucetVaultUi("-");
          }
        } catch {
          setFaucetVaultUi("0");
        }

        setDebug((d) => ({
          ...d,
          liveSupplyUi: supplyUi.toString(),
          liveReserveUi: reserveUi.toString(),
          liveRatio: (supply > 0 ? reserveUi / supplyUi : 0).toString(),
        }));
      } catch {
        // ignore
      }
    },
    [connection, statePda, vaultReserveAtaPk, faucetVaultAtaPk]
  );

  useEffect(() => {
    refreshLive();
  }, [refreshTick, refreshLive]);

  // Websocket subscriptions
  useEffect(() => {
    // cleanup
    if (mintSubRef.current !== null) {
      try {
        connection.removeAccountChangeListener(mintSubRef.current);
      } catch {}
      mintSubRef.current = null;
    }
    if (reserveSubRef.current !== null) {
      try {
        connection.removeAccountChangeListener(reserveSubRef.current);
      } catch {}
      reserveSubRef.current = null;
    }
    if (faucetSubRef.current !== null) {
      try {
        connection.removeAccountChangeListener(faucetSubRef.current);
      } catch {}
      faucetSubRef.current = null;
    }

    (async () => {
      if (!statePda) return;
      try {
        // Mint VAULT
        mintSubRef.current = connection.onAccountChange(
          VAULT_MINT,
          () => setRefreshTick((t) => t + 1),
          COMMIT
        );
        // PDA reserve ATA
        if (vaultReserveAtaPk) {
          reserveSubRef.current = connection.onAccountChange(
            vaultReserveAtaPk,
            () => setRefreshTick((t) => t + 1),
            COMMIT
          );
        }
        // Faucet VAULT
        if (faucetVaultAtaPk) {
          faucetSubRef.current = connection.onAccountChange(
            faucetVaultAtaPk,
            () => setRefreshTick((t) => t + 1),
            COMMIT
          );
        }
      } catch {}
    })();

    return () => {
      if (mintSubRef.current !== null) {
        try {
          connection.removeAccountChangeListener(mintSubRef.current);
        } catch {}
        mintSubRef.current = null;
      }
      if (reserveSubRef.current !== null) {
        try {
          connection.removeAccountChangeListener(reserveSubRef.current);
        } catch {}
        reserveSubRef.current = null;
      }
      if (faucetSubRef.current !== null) {
        try {
          connection.removeAccountChangeListener(faucetSubRef.current);
        } catch {}
        faucetSubRef.current = null;
      }
    };
  }, [connection, statePda, vaultReserveAtaPk, faucetVaultAtaPk]);

  // -------- Burn preview + proportions --------
  useEffect(() => {
    (async () => {
      try {
        setErr(null);
        setPreview("-");
        setPctBurn("-");
        setPctReserve("-");

        if (!publicKey || !statePda || !vaultReserveAtaPk) return;
        if (!amountUi || Number(amountUi) <= 0) return;

        const [mintVault, accReserve] = await Promise.all([
          withRetry(() => getMint(connection, VAULT_MINT, COMMIT)),
          withRetry(() => getAccount(connection, vaultReserveAtaPk, COMMIT)),
        ]);

        const preSupply = BigInt(mintVault.supply.toString()); // 6d
        const vaultBal = BigInt(accReserve.amount.toString()); // 9d
        const burnAmount = BigInt(Math.floor(Number(amountUi) * 10 ** VAULT_DEC));

        if (preSupply === 0n) {
          setPreview("0");
          return;
        }

        const out = (vaultBal * burnAmount) / preSupply;
        const outUi = Number(out) / 1e9;
        setPreview(fmt0(outUi));

        const pct = (Number(burnAmount) / Number(preSupply)) * 100;
        const pctStr = fmt0(pct) + "%";
        setPctBurn(pctStr);
        setPctReserve(pctStr);

        setDebug((d) => ({
          ...d,
          connected: String(!!publicKey),
          state: statePda.toBase58?.() ?? "",
          vaultReserveAta: vaultReserveAtaPk?.toBase58?.() ?? "",
          faucetVaultAta: faucetVaultAtaPk?.toBase58?.() ?? "",
          userVaultAta: userVaultAtaPk?.toBase58?.() ?? "",
          userReserveAta: userReserveAtaPk?.toBase58?.() ?? "",
          preSupply: mintVault.supply.toString(),
          vaultBal: accReserve.amount.toString(),
          pctBurn: pctStr,
          pctReserve: pctStr,
        }));
      } catch (e: any) {
        setErr(e?.message || String(e));
      }
    })();
  }, [
    amountUi,
    publicKey,
    statePda,
    vaultReserveAtaPk,
    faucetVaultAtaPk,
    userVaultAtaPk,
    userReserveAtaPk,
    connection,
    refreshTick,
  ]);

  // Gentle periodic refresh (less load for OperaGX / CodeSandbox)
  useEffect(() => {
    if (!connected || !statePda || !vaultReserveAtaPk) return;
    const id = setInterval(() => setRefreshTick((t) => t + 1), 8000);
    return () => clearInterval(id);
  }, [connected, statePda, vaultReserveAtaPk]);

  // ====== ACTION: BURN ======
  const onBurn = async () => {
    try {
      setLoading(true);
      setErr(null);
      if (!publicKey || !sendTransaction)
        throw new Error("Connect your wallet.");

      const state = statePda,
        vRes = vaultReserveAtaPk,
        uVault = userVaultAtaPk,
        uRes = userReserveAtaPk;
      if (!state || !vRes) throw new Error("Derived accounts missing.");
      if (!uVault || !uRes) throw new Error("User ATAs missing.");

      const burnAmountUi = parseFloat(amountUi);
      if (!Number.isFinite(burnAmountUi) || burnAmountUi <= 0)
        throw new Error("Invalid amount.");
      const burnAmount = BigInt(Math.round(burnAmountUi * 10 ** VAULT_DEC));

      const discr = await anchorDiscriminator("burn_to_redeem");
      const data = new Uint8Array(8 + 8);
      data.set(discr, 0);
      data.set(u64le(burnAmount), 8);

      const tx = new Transaction();

      // Ensure RESERVE ATA exists
      try {
        await getAccount(connection, uRes, COMMIT);
      } catch {
        tx.add(
          createAssociatedTokenAccountInstruction(
            publicKey,
            uRes,
            publicKey,
            RESERVE_MINT,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
          )
        );
      }
      // Ensure VAULT ATA exists
      try {
        await getAccount(connection, uVault, COMMIT);
      } catch {
        tx.add(
          createAssociatedTokenAccountInstruction(
            publicKey,
            uVault,
            publicKey,
            VAULT_MINT,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
          )
        );
      }

      const keys = [
        { pubkey: state, isSigner: false, isWritable: true },
        { pubkey: RESERVE_MINT, isSigner: false, isWritable: true },
        { pubkey: vRes, isSigner: false, isWritable: true },
        { pubkey: VAULT_MINT, isSigner: false, isWritable: true },
        { pubkey: uVault, isSigner: false, isWritable: true },
        { pubkey: uRes, isSigner: false, isWritable: true },
        { pubkey: publicKey, isSigner: true, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ];
      tx.add(
        new TransactionInstruction({
          programId: PROGRAM_ID,
          keys,
          data: Buffer.from(data),
        })
      );

      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash(COMMIT);
      tx.feePayer = publicKey;
      tx.recentBlockhash = blockhash;

      // Use sendTransaction for mobile Phantom
      const signature = await sendTransaction(tx, connection, {
        skipPreflight: false,
      });
      await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        COMMIT
      );

      setRefreshTick((t) => t + 1);
      alert(`✔️ Burn sent!\nTx: ${signature}`);
    } catch (e: any) {
      console.error(e);
      setErr(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  // ====== ACTION: CLAIM (front-only cooldown) ======
  const onClaim = async () => {
    try {
      setClaimLoading(true);
      setClaimErr(null);
      if (!publicKey || !sendTransaction)
        throw new Error("Connect your wallet.");

      const state = statePda,
        faucet = faucetVaultAtaPk;
      let uVault = userVaultAtaPk;
      if (!state || !faucet) throw new Error("Derived PDA accounts missing.");

      const tx = new Transaction();
      // Ensure user VAULT ATA exists
      try {
        if (!uVault) throw new Error("missing");
        await getAccount(connection, uVault, COMMIT);
      } catch {
        const p = await getAssociatedTokenAddress(
          VAULT_MINT,
          publicKey!,
          false,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        );
        uVault = p;
        tx.add(
          createAssociatedTokenAccountInstruction(
            publicKey!,
            uVault,
            publicKey!,
            VAULT_MINT,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
          )
        );
      }

      // Build claim instruction (client-side amount stays; your program must accept it)
      const discr = await anchorDiscriminator("claim");
      const data = new Uint8Array(8 + 8);
      data.set(discr, 0);
      data.set(u64le(CLAIM_VAULT_AMOUNT_BASE), 8);

      const keys = [
        { pubkey: state, isSigner: false, isWritable: true },
        { pubkey: RESERVE_MINT, isSigner: false, isWritable: false },
        { pubkey: VAULT_MINT, isSigner: false, isWritable: false },
        { pubkey: faucet, isSigner: false, isWritable: true },
        { pubkey: uVault!, isSigner: false, isWritable: true },
        { pubkey: publicKey!, isSigner: true, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ];
      tx.add(
        new TransactionInstruction({
          programId: PROGRAM_ID,
          keys,
          data: Buffer.from(data),
        })
      );

      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash(COMMIT);
      tx.feePayer = publicKey!;
      tx.recentBlockhash = blockhash;

      // Use sendTransaction (fixes most mobile “missing signature” issues)
      const signature = await sendTransaction(tx, connection, {
        skipPreflight: false,
      });
      await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        COMMIT
      );

      // Mark cooldown locally
      const b58 = publicKey?.toBase58() ?? null;
      const now = Date.now();
      setLastClaimTs(b58, now);
      setLastClaimTsState(now);

      setRefreshTick((t) => t + 1);
      alert(`✔️ Claim sent!\nTx: ${signature}\nAmount: ${CLAIM_VAULT_AMOUNT_UI} VAULT`);
    } catch (e: any) {
      console.error(e);
      setClaimErr(e?.message || String(e));
    } finally {
      setClaimLoading(false);
    }
  };

  // Wrapper enforcing cooldown on the client
  const handleClaimClick = async () => {
    if (cooldownActive) {
      alert(`Please wait ${cooldownLabel} before claiming again.`);
      return;
    }
    await onClaim();
  };

  // Single-button handler: Deep link → fallback
  const openInPhantom = () => {
    if (!phantomLinks) return;
    // Try custom scheme first
    window.location.href = phantomLinks.scheme;
    // Fallback to universal link if the scheme isn't handled
    setTimeout(() => {
      window.location.href = phantomLinks.universal;
    }, 800);
  };

  // ---------------- UI ----------------
  const StatCard = ({
    title,
    value,
    subtitle,
  }: {
    title: string;
    value: string;
    subtitle?: string;
  }) => (
    <div
      style={{
        padding: 12,
        border: "1px solid #eee",
        borderRadius: 12,
        boxShadow: "0 1px 4px rgba(0,0,0,0.04)",
        background: "#fff",
      }}
    >
      <div style={{ fontSize: 12, opacity: 0.7 }}>{title}</div>
      <div style={{ fontSize: 20, fontWeight: 700, marginTop: 2 }}>{value}</div>
      {subtitle && <div style={{ fontSize: 11, opacity: 0.7, marginTop: 4 }}>{subtitle}</div>}
    </div>
  );

  return (
    <div
      style={{
        maxWidth: 620,
        margin: "0 auto",
        padding: 16,
        border: "1px solid #eee",
        borderRadius: 12,
        background: "#fafafa",
      }}
    >
      {/* Phantom in-app browser hint (mobile only, not already in Phantom) */}
      {showPhantomHint && phantomLinks && (
        <div
          style={{
            marginBottom: 12,
            padding: 12,
            borderRadius: 12,
            background: "#fff7e6",
            border: "1px solid #ffe0a3",
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 6 }}>
            Having trouble signing on mobile?
          </div>
          <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 10 }}>
            Open this page directly in Phantom’s in-app browser for the most reliable experience.
          </div>
          <button
            onClick={openInPhantom}
            style={{
              padding: "8px 12px",
              borderRadius: 10,
              background: "#111",
              color: "#fff",
              border: 0,
              cursor: "pointer",
            }}
          >
            Open in Phantom
          </button>
        </div>
      )}

      <h3>Burn VAULT → Redeem JitoSOL (Devnet)</h3>
      <p style={{ fontSize: 12, opacity: 0.7, marginTop: -8 }}>
        Program: {PROGRAM_ID.toBase58().slice(0, 6)}…{PROGRAM_ID.toBase58().slice(-6)}
      </p>

      {/* ===== Live Reserve & Supply ===== */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 12,
          marginTop: 10,
          marginBottom: 14,
        }}
      >
        <StatCard title="Reserve balance" value={`${liveReserveUi} JitoSOL`} />
        <StatCard title="Total VAULT supply" value={`${liveSupplyUi} VAULT`} />
        <StatCard title="Current rate" value={`${rateNow} JitoSOL / VAULT`} />
      </div>

      {/* ===== BURN Section ===== */}
      <div style={{ marginTop: 12 }}>
        <label>Amount to burn (VAULT)</label>
        <input
          type="number"
          placeholder="e.g. 1000"
          value={amountUi}
          onChange={(e) => setAmountUi(e.target.value)}
          style={{
            width: "100%",
            padding: 10,
            borderRadius: 8,
            border: "1px solid #ddd",
            marginTop: 6,
            background: "#fff",
          }}
        />
      </div>

      <div style={{ marginTop: 12 }}>
        <div>
          Estimated redemption ≈ <b>{preview}</b> JitoSOL
        </div>
        <div style={{ fontSize: 12, opacity: 0.8, marginTop: 6, lineHeight: 1.5 }}>
          <div>
            Current rate: <b>{rateNow}</b> JitoSOL per <b>1 VAULT</b>
          </div>
          <div>
            You burn <b>{pctBurn}</b> of total supply → you receive <b>{pctReserve}</b> of the reserve.
          </div>
        </div>
        <button
          onClick={() => setRefreshTick((t) => t + 1)}
          style={{
            marginTop: 8,
            padding: "4px 10px",
            borderRadius: 8,
            border: "1px solid #ddd",
            background: "#f7f7f7",
            cursor: "pointer",
          }}
          title="Refresh now"
        >
          Refresh
        </button>
      </div>

      <button
        disabled={!connected || loading || !amountUi}
        onClick={onBurn}
        style={{
          marginTop: 16,
          width: "100%",
          padding: 12,
          borderRadius: 10,
          background: "#111",
          color: "#fff",
          border: 0,
          cursor: "pointer",
        }}
      >
        {loading ? "Send..." : "Burn & Redeem"}
      </button>

      {err && (
        <pre style={{ marginTop: 12, color: "#b00020", whiteSpace: "pre-wrap" }}>
          {err}
        </pre>
      )}

      {/* ===== CLAIM Section (soft cooldown front-only) ===== */}
      <hr style={{ margin: "24px 0", border: "none", borderTop: "1px solid #eee" }} />
      <h4>Claim VAULT from the PDA faucet (testnet)</h4>

      <div style={{ marginTop: 6, fontSize: 13 }}>
        Faucet balance: <b>{faucetVaultUi}</b> VAULT
      </div>
      <div style={{ marginTop: 6, fontSize: 13 }}>
        Claim amount: <b>{CLAIM_VAULT_AMOUNT_UI} VAULT</b>{" "}
        <span style={{ opacity: 0.7 }}>(Cooldown: {COOLDOWN_MIN} min)</span>
      </div>
      {cooldownActive && (
        <div style={{ marginTop: 6, fontSize: 12, color: "#b06f00" }}>
          Next claim available in <b>{cooldownLabel}</b>
        </div>
      )}

      <button
        disabled={!connected || claimLoading || cooldownActive}
        onClick={handleClaimClick}
        style={{
          marginTop: 12,
          width: "100%",
          padding: 12,
          borderRadius: 10,
          background: cooldownActive ? "#888" : "#111",
          color: "#fff",
          border: 0,
          cursor: cooldownActive ? "not-allowed" : "pointer",
        }}
        title={
          cooldownActive ? `Please wait ${cooldownLabel} before claiming again.` : undefined
        }
      >
        {claimLoading ? "Send..." : `Claim ${CLAIM_VAULT_AMOUNT_UI} VAULT`}
      </button>

      {claimErr && (
        <pre style={{ marginTop: 12, color: "#b00020", whiteSpace: "pre-wrap" }}>
          {claimErr}
        </pre>
      )}

      {/* ===== Debug ===== */}
      <details style={{ marginTop: 12 }}>
        <summary>Accounts debug</summary>
        <div style={{ fontFamily: "monospace", fontSize: 12 }}>
          <div>connected: {String(connected)}</div>
          <div>state: {debug.state}</div>
          <div>vaultReserveAta: {debug.vaultReserveAta}</div>
          <div>faucetVaultAta: {debug.faucetVaultAta}</div>
          <div>userVaultAta: {debug.userVaultAta}</div>
          <div>userReserveAta: {debug.userReserveAta}</div>
          <div>preSupply: {debug.preSupply}</div>
          <div>vaultBal: {debug.vaultBal}</div>
          <div>liveSupplyUi: {debug.liveSupplyUi}</div>
          <div>liveReserveUi: {debug.liveReserveUi}</div>
          <div>liveRatio: {debug.liveRatio}</div>
          <div>rateNow: {rateNow} (JitoSOL / VAULT)</div>
          <div>faucetVaultUi: {faucetVaultUi}</div>
          <div>cooldownActive: {String(cooldownActive)}</div>
          <div>lastClaimTs: {lastClaimTs}</div>
        </div>
      </details>
    </div>
  );
}


