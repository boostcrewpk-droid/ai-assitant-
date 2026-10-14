"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* =====================================================================
   Config & types
   ===================================================================== */

const API_URL = '';
const TOKEN_KEY = "lala_hisab_token";
const MAX_RECORD_SECONDS = 30;
const PAYWALL_TEXT =
  "Lala, aapka 1 ghante ka muft trial mukammal ho gaya! Rozana ka hisab mehfooz rakhne ke liye abhi unlock karein.";

const CATEGORIES = [
  { value: "Kiryana", label: "Kiryana", hint: "General store", icon: "🛒" },
  { value: "Auto Parts", label: "Auto Parts", hint: "Spare parts", icon: "⚙️" },
  { value: "Garments", label: "Garments", hint: "Kapra / suits", icon: "👕" },
  { value: "Medical", label: "Medical", hint: "Pharmacy", icon: "💊" },
  { value: "Workshop", label: "Workshop", hint: "Mistri / repair", icon: "🔧" },
] as const;

type Action = "ADD_STOCK" | "UDHAR_ENTRY" | "CASH_SALE" | "EXPENSE";

type UserState = {
  user_id: string;
  phone: string;
  business_category: string;
  first_login_at: string;
  trial_ends_at: string;
  server_now: string;
  is_paid: boolean;
  locked: boolean;
  payment_status: "pending" | "approved" | "rejected" | null;
};

type AppConfig = {
  trial_minutes: number;
  plan: { price_pkr: number; label: string };
  payment: {
    account_title: string;
    jazzcash: string;
    easypaisa: string;
    sadapay: string;
    link_url: string;
    qr_image_url: string;
  };
  support_whatsapp: string;
};

type Entry = {
  id: string;
  action: Action;
  party_name: string | null;
  item_name: string | null;
  quantity: number | null;
  unit: string | null;
  amount: number | null;
  shelf_location: string | null;
  source: "voice" | "receipt" | "manual";
  transcript: string | null;
  created_at: string;
};

type Ledger = {
  date: string;
  entries: Entry[];
  totals: { cash_sales: number; udhar_given: number; expenses: number; stock_purchases: number; cash_in_hand: number };
};

type ProductMatch = { id: string; name: string; quantity: number; unit: string | null; shelf_location: string | null };

type Toast = { tone: "ok" | "err" | "info"; title: string; detail?: string } | null;

type LocationResult = { query: string; matches: ProductMatch[]; reply: string } | null;

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

class ApiError extends Error {
  status: number;
  transcript?: string;
  constructor(status: number, message: string, transcript?: string) {
    super(message);
    this.status = status;
    this.transcript = transcript;
  }
}

/* =====================================================================
   Helpers
   ===================================================================== */

const ACTION_STYLE: Record<Action, { label: string; chip: string; sign: string }> = {
  CASH_SALE: { label: "Naqad", chip: "bg-emerald-100 text-emerald-800", sign: "+" },
  UDHAR_ENTRY: { label: "Udhar", chip: "bg-rose-100 text-rose-800", sign: "" },
  EXPENSE: { label: "Kharcha", chip: "bg-amber-100 text-amber-900", sign: "−" },
  ADD_STOCK: { label: "Stock", chip: "bg-sky-100 text-sky-800", sign: "" },
};

const rupees = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : `Rs ${Math.round(n).toLocaleString("en-PK")}`;

const fmtQty = (q: number | null, unit: string | null) =>
  q === null || q === undefined ? "" : `${Number(q).toLocaleString("en-PK", { maximumFractionDigits: 3 })}${unit ? " " + unit : ""}`;

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-PK", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Karachi" });

const pad2 = (n: number) => String(n).padStart(2, "0");

function errorMessage(detail: unknown, fallback: string): { message: string; transcript?: string } {
  if (typeof detail === "string") return { message: detail };
  if (Array.isArray(detail)) {
    const first = detail[0] as { msg?: string } | undefined;
    return { message: (first?.msg || fallback).replace(/^Value error, /, "") };
  }
  if (detail && typeof detail === "object") {
    const d = detail as { message?: string; transcript?: string };
    return { message: d.message || fallback, transcript: d.transcript };
  }
  return { message: fallback };
}

async function downscaleImage(file: File, maxSide = 1600): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.85));
    return blob ?? file;
  } catch {
    return file;
  }
}

function pickAudioMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const options = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus", "audio/aac"];
  return options.find((t) => MediaRecorder.isTypeSupported(t)) || "";
}

function extForMime(mime: string): string {
  if (mime.includes("mp4") || mime.includes("aac")) return "m4a";
  if (mime.includes("ogg")) return "ogg";
  return "webm";
}

/* =====================================================================
   Main component
   ===================================================================== */

export default function LalaHisabApp() {
  const [booting, setBooting] = useState(true);
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<UserState | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [clockOffset, setClockOffset] = useState(0); // serverNow - Date.now()
  const [now, setNow] = useState(() => Date.now());
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [location, setLocation] = useState<LocationResult>(null);
  const [busy, setBusy] = useState<null | "voice" | "scan" | "text" | "find">(null);
  const [forceLocked, setForceLocked] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* ---------- toast ---------- */
  const showToast = useCallback((t: NonNullable<Toast>, ms = 5000) => {
    setToast(t);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), ms);
  }, []);

  /* ---------- session ---------- */
  const applyUser = useCallback((u: UserState) => {
    setUser(u);
    setClockOffset(new Date(u.server_now).getTime() - Date.now());
    setForceLocked(u.locked);
  }, []);

  const logout = useCallback(() => {
    try { localStorage.removeItem(TOKEN_KEY); } catch {}
    setToken(null);
    setUser(null);
    setLedger(null);
  }, []);

  /* ---------- API ---------- */
  const api = useCallback(
    async <T,>(path: string, init: RequestInit = {}, authToken: string | null = token): Promise<T> => {
      const headers = new Headers(init.headers);
      if (authToken) headers.set("Authorization", `Bearer ${authToken}`);
      if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
      let res: Response;
      try {
        res = await fetch(`${API_URL}${path}`, { ...init, headers });
      } catch {
        throw new ApiError(0, "Internet nahi chal raha. Connection check karein.");
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 402) setForceLocked(true);
        if (res.status === 401 && authToken) logout();
        const { message, transcript } = errorMessage((body as { detail?: unknown }).detail, "Kuch ghalat ho gaya");
        throw new ApiError(res.status, message, transcript);
      }
      return body as T;
    },
    [token, logout]
  );

  const loadLedger = useCallback(async () => {
    try {
      setLedger(await api<Ledger>("/api/ledger/today"));
    } catch (e) {
      if (e instanceof ApiError && e.status !== 402 && e.status !== 401) {
        showToast({ tone: "err", title: e.message });
      }
    }
  }, [api, showToast]);

  /* ---------- boot ---------- */
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
    fetch(`${API_URL}/api/config`).then((r) => r.json()).then(setConfig).catch(() => {});
    let saved: string | null = null;
    try { saved = localStorage.getItem(TOKEN_KEY); } catch {}
    if (!saved) {
      setBooting(false);
      return;
    }
    api<UserState>("/api/me", {}, saved)
      .then((u) => {
        setToken(saved);
        applyUser(u);
      })
      .catch(() => {})
      .finally(() => setBooting(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- clock tick ---------- */
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  /* ---------- trial math (server-synced clock) ---------- */
  const serverNow = now + clockOffset;
  const trialEnd = user ? new Date(user.trial_ends_at).getTime() : 0;
  const msLeft = Math.max(0, trialEnd - serverNow);
  const locked = !!user && !user.is_paid && (forceLocked || msLeft <= 0);

  useEffect(() => {
    document.body.classList.toggle("locked", locked);
  }, [locked]);

  /* ---------- load ledger when ready ---------- */
  useEffect(() => {
    if (token && user && !locked) loadLedger();
  }, [token, user?.user_id, locked]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- while locked, poll for payment approval ---------- */
  useEffect(() => {
    if (!locked || !token) return;
    const id = setInterval(async () => {
      try {
        const u = await api<UserState>("/api/me");
        applyUser(u);
        if (u.is_paid) showToast({ tone: "ok", title: "Shukriya! Account unlock ho gaya 🎉" });
      } catch {}
    }, 15000);
    return () => clearInterval(id);
  }, [locked, token, api, applyUser, showToast]);

  /* ---------- actions ---------- */
  const handleResult = useCallback(
    (res: { kind: string; reply: string; transcript?: string; matches?: ProductMatch[]; query?: string }) => {
      if (res.kind === "location") {
        setToast(null);
        setLocation({ query: res.query || "", matches: res.matches || [], reply: res.reply });
      } else {
        showToast({ tone: "ok", title: res.reply, detail: res.transcript ? `“${res.transcript}”` : undefined }, 6000);
        loadLedger();
      }
    },
    [loadLedger, showToast]
  );

  const sendAudio = useCallback(
    async (blob: Blob, mime: string) => {
      setBusy("voice");
      try {
        const fd = new FormData();
        fd.append("audio", blob, `voice.${extForMime(mime)}`);
        handleResult(await api("/api/voice-entry", { method: "POST", body: fd }));
      } catch (e) {
        const err = e as ApiError;
        if (err.status !== 402) {
          showToast({ tone: "err", title: err.message, detail: err.transcript ? `Suna: “${err.transcript}”` : undefined }, 7000);
        }
      } finally {
        setBusy(null);
      }
    },
    [api, handleResult, showToast]
  );

  const sendText = useCallback(
    async (text: string) => {
      setBusy("text");
      try {
        handleResult(await api("/api/text-entry", { method: "POST", body: JSON.stringify({ text }) }));
        return true;
      } catch (e) {
        const err = e as ApiError;
        if (err.status !== 402) showToast({ tone: "err", title: err.message });
        return false;
      } finally {
        setBusy(null);
      }
    },
    [api, handleResult, showToast]
  );

  const scanReceipt = useCallback(
    async (file: File) => {
      setBusy("scan");
      try {
        const img = await downscaleImage(file);
        const fd = new FormData();
        fd.append("image", img, "bill.jpg");
        const res = await api<{ reply: string; bill_total: number | null }>("/api/scan-receipt", { method: "POST", body: fd });
        showToast({ tone: "ok", title: res.reply, detail: res.bill_total ? `Bill total: ${rupees(res.bill_total)}` : undefined }, 7000);
        loadLedger();
      } catch (e) {
        const err = e as ApiError;
        if (err.status !== 402) showToast({ tone: "err", title: err.message });
      } finally {
        setBusy(null);
      }
    },
    [api, loadLedger, showToast]
  );

  const findItem = useCallback(
    async (q: string) => {
      setBusy("find");
      try {
        setToast(null);
        setLocation(await api<NonNullable<LocationResult>>(`/api/find?q=${encodeURIComponent(q)}`));
      } catch (e) {
        const err = e as ApiError;
        if (err.status !== 402) showToast({ tone: "err", title: err.message });
      } finally {
        setBusy(null);
      }
    },
    [api, showToast]
  );

  const undoEntry = useCallback(
    async (id: string) => {
      try {
        await api(`/api/transactions/${id}`, { method: "DELETE" });
        showToast({ tone: "info", title: "Entry hata di gayi" }, 3000);
        loadLedger();
      } catch (e) {
        showToast({ tone: "err", title: (e as ApiError).message });
      }
    },
    [api, loadLedger, showToast]
  );

  /* ---------- render ---------- */
  if (booting) {
    return (
      <div className="grid min-h-dvh place-items-center bg-khata-900 text-kaghaz">
        <div className="text-center">
          <img src="/icons/icon-192.png" alt="" className="mx-auto h-20 w-20 rounded-3xl" />
          <p className="mt-4 text-lg font-semibold tracking-wide">Lala Hisab</p>
        </div>
      </div>
    );
  }

  if (!token || !user) {
    return (
      <Onboarding
        onRegistered={(t, u) => {
          try { localStorage.setItem(TOKEN_KEY, t); } catch {}
          setToken(t);
          applyUser(u);
        }}
      />
    );
  }

  return (
    <div className="mx-auto min-h-dvh max-w-md bg-kaghaz pb-40">
      <div inert={locked} aria-hidden={locked}>
        <TrialBanner isPaid={user.is_paid} msLeft={msLeft} totalMs={(config?.trial_minutes ?? 60) * 60000} />
        <Header user={user} onLogout={logout} />
        <InstallPrompt />
        <SummaryCards ledger={ledger} />
        <SearchBar busy={busy === "find"} onSearch={findItem} />
        <LedgerList ledger={ledger} onUndo={undoEntry} onRefresh={loadLedger} />
        <ActionDock busy={busy} onAudio={sendAudio} onImage={scanReceipt} onText={sendText} onError={(m) => showToast({ tone: "err", title: m })} />
        {toast && <ToastView toast={toast} onClose={() => setToast(null)} />}
        {location && <LocationSheet result={location} onClose={() => setLocation(null)} />}
      </div>
      {locked && (
        <Paywall
          config={config}
          user={user}
          api={api}
          onUser={applyUser}
        />
      )}
    </div>
  );
}

/* =====================================================================
   Onboarding (phone + category)
   ===================================================================== */

function Onboarding({ onRegistered }: { onRegistered: (token: string, user: UserState) => void }) {
  const [phone, setPhone] = useState("");
  const [category, setCategory] = useState<string>("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const valid = /^03\d{9}$/.test(phone) && !!category;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) {
      setError(!/^03\d{9}$/.test(phone) ? "Number 03XXXXXXXXX (11 hindsay) likhein" : "Apna karobar chunein");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${API_URL}/api/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, business_category: category }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(errorMessage(body.detail, "Registration nahi hui").message);
      const { token, ...user } = body as UserState & { token: string };
      onRegistered(token, user);
    } catch (err) {
      setError(err instanceof TypeError ? "Internet nahi chal raha" : (err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col bg-khata-900 text-kaghaz">
      <div className="px-6 pb-8 pt-[max(3rem,env(safe-area-inset-top))]">
        <img src="/icons/icon-192.png" alt="" className="h-16 w-16 rounded-2xl shadow-lg" />
        <h1 className="mt-5 text-3xl font-extrabold leading-tight">
          Bol kar hisab,<br />
          <span className="text-haldi-400">likhne ki zaroorat nahi.</span>
        </h1>
        <p className="mt-3 text-khata-100/80">
          Udhar, naqad sale, stock aur kharcha — Urdu, Punjabi, Pashto ya Sindhi mein bolein.
        </p>
      </div>

      <form onSubmit={submit} className="flex flex-1 flex-col gap-5 rounded-t-[2rem] bg-kaghaz px-6 pb-[max(2rem,env(safe-area-inset-bottom))] pt-7 text-syahi">
        <label className="block">
          <span className="text-sm font-semibold text-khata-800">Mobile number</span>
          <input
            inputMode="numeric"
            autoComplete="tel"
            placeholder="03XXXXXXXXX"
            maxLength={11}
            value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 11))}
            className="mt-2 w-full rounded-2xl border-2 border-khata-100 bg-white px-4 py-4 text-2xl font-bold tracking-[0.12em] outline-none focus:border-khata-700"
          />
        </label>

        <div>
          <span className="text-sm font-semibold text-khata-800">Aapka karobar</span>
          <div className="mt-2 grid grid-cols-2 gap-3">
            {CATEGORIES.map((c) => (
              <button
                key={c.value}
                type="button"
                onClick={() => setCategory(c.value)}
                className={`flex items-center gap-3 rounded-2xl border-2 px-3 py-3 text-left transition active:scale-[.98] ${
                  category === c.value ? "border-khata-700 bg-khata-100" : "border-khata-100 bg-white"
                } ${c.value === "Workshop" ? "col-span-2" : ""}`}
              >
                <span className="text-2xl">{c.icon}</span>
                <span>
                  <span className="block font-bold">{c.label}</span>
                  <span className="block text-xs text-khata-800/70">{c.hint}</span>
                </span>
              </button>
            ))}
          </div>
        </div>

        {error && <p className="rounded-xl bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">{error}</p>}

        <button
          disabled={loading}
          className="mt-auto rounded-2xl bg-haldi-500 py-4 text-lg font-extrabold text-khata-950 shadow-lg shadow-haldi-500/30 transition active:scale-[.98] disabled:opacity-60"
        >
          {loading ? "Shuru ho raha hai…" : "1 ghanta muft shuru karein →"}
        </button>
        <p className="text-center text-xs text-syahi/50">Koi password nahi. Sirf number aur karobar.</p>
      </form>
    </div>
  );
}

/* =====================================================================
   Trial banner, header, install prompt
   ===================================================================== */

function TrialBanner({ isPaid, msLeft, totalMs }: { isPaid: boolean; msLeft: number; totalMs: number }) {
  if (isPaid) {
    return (
      <div className="sticky top-0 z-30 bg-khata-950 px-4 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] text-center text-sm font-semibold text-haldi-400">
        ✓ Premium — hisab mehfooz hai
      </div>
    );
  }
  const mins = Math.floor(msLeft / 60000);
  const secs = Math.floor((msLeft % 60000) / 1000);
  const urgent = msLeft < 10 * 60000;
  const pct = Math.max(0, Math.min(100, (msLeft / totalMs) * 100));
  return (
    <div
      className={`sticky top-0 z-30 px-4 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] text-sm font-semibold ${
        urgent ? "bg-rose-600 text-white" : "bg-khata-950 text-khata-100"
      }`}
      role="timer"
      aria-live="off"
    >
      <div className="flex items-center justify-between">
        <span>⏳ Muft trial baqi</span>
        <span className="font-mono text-base tabular-nums">{pad2(mins)}:{pad2(secs)}</span>
      </div>
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/15">
        <div className={`h-full rounded-full ${urgent ? "bg-white" : "bg-haldi-400"}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Header({ user, onLogout }: { user: UserState; onLogout: () => void }) {
  const cat = CATEGORIES.find((c) => c.value === user.business_category);
  const today = new Date().toLocaleDateString("en-PK", { weekday: "long", day: "numeric", month: "short", timeZone: "Asia/Karachi" });
  return (
    <header className="flex items-center justify-between px-4 pb-2 pt-4">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-khata-700">{today}</p>
        <h1 className="text-xl font-extrabold">
          {cat?.icon} Aaj ka hisab
        </h1>
      </div>
      <button
        onClick={() => { if (confirm("Is phone se logout karein?")) onLogout(); }}
        className="rounded-full border border-khata-100 bg-white px-3 py-1.5 font-mono text-xs text-khata-800"
        aria-label="Logout"
      >
        {user.phone.replace(/^(\d{4})(\d{3})(\d{4})$/, "$1-$2…")}
      </button>
    </header>
  );
}

function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [isIOS, setIsIOS] = useState(false);
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    let dismissed = false;
    try { dismissed = localStorage.getItem("lala_install_dismissed") === "1"; } catch {}
    if (standalone || dismissed) return;

    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) && !/crios|fxios/i.test(navigator.userAgent);
    setIsIOS(ios);
    if (ios) setHidden(false);

    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
      setHidden(false);
    };
    const onInstalled = () => setHidden(true);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (hidden) return null;

  const dismiss = () => {
    try { localStorage.setItem("lala_install_dismissed", "1"); } catch {}
    setHidden(true);
  };

  return (
    <div className="mx-4 mb-3 flex items-center gap-3 rounded-2xl border border-haldi-400/60 bg-haldi-100 p-3">
      <img src="/icons/icon-192.png" alt="" className="h-11 w-11 rounded-xl" />
      <div className="flex-1 text-sm">
        <p className="font-bold">Home screen par lagayein</p>
        <p className="text-xs text-syahi/70">
          {isIOS && !deferred ? "Share ⬆️ dabayein, phir “Add to Home Screen”" : "App ki tarah ek tap mein khulega"}
        </p>
      </div>
      {deferred && (
        <button
          onClick={async () => {
            await deferred.prompt();
            await deferred.userChoice;
            setDeferred(null);
            setHidden(true);
          }}
          className="rounded-xl bg-khata-800 px-3 py-2 text-sm font-bold text-white"
        >
          Install
        </button>
      )}
      <button onClick={dismiss} className="px-1 text-lg text-syahi/40" aria-label="Band karein">×</button>
    </div>
  );
}

/* =====================================================================
   Dashboard
   ===================================================================== */

function SummaryCards({ ledger }: { ledger: Ledger | null }) {
  const t = ledger?.totals;
  const cards = [
    { label: "Naqad sale", value: t?.cash_sales, cls: "bg-khata-800 text-white" },
    { label: "Udhar diya", value: t?.udhar_given, cls: "bg-white text-rose-700 border border-rose-100" },
    { label: "Kharcha", value: t?.expenses, cls: "bg-white text-amber-800 border border-amber-100" },
    { label: "Galla (naqad − kharcha)", value: t?.cash_in_hand, cls: "bg-haldi-400 text-khata-950" },
  ];
  return (
    <section className="grid grid-cols-2 gap-3 px-4">
      {cards.map((c) => (
        <div key={c.label} className={`rounded-2xl p-3.5 shadow-sm ${c.cls}`}>
          <p className="text-[11px] font-semibold uppercase tracking-wide opacity-80">{c.label}</p>
          <p className="mt-1 text-xl font-extrabold tabular-nums">{t ? rupees(c.value) : "…"}</p>
        </div>
      ))}
    </section>
  );
}

function SearchBar({ busy, onSearch }: { busy: boolean; onSearch: (q: string) => void }) {
  const [q, setQ] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (q.trim()) onSearch(q.trim());
      }}
      className="mx-4 mt-4 flex items-center gap-2 rounded-2xl border-2 border-khata-100 bg-white px-3 focus-within:border-khata-700"
    >
      <span aria-hidden>🔎</span>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Falan cheez kahan rakhi hai?"
        className="min-w-0 flex-1 bg-transparent py-3.5 text-base outline-none"
        enterKeyHint="search"
      />
      <button disabled={busy || !q.trim()} className="rounded-xl bg-khata-800 px-3 py-2 text-sm font-bold text-white disabled:opacity-40">
        {busy ? "…" : "Dhoondo"}
      </button>
    </form>
  );
}

function LedgerList({ ledger, onUndo, onRefresh }: { ledger: Ledger | null; onUndo: (id: string) => void; onRefresh: () => void }) {
  return (
    <section className="mt-5 px-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-bold uppercase tracking-wider text-khata-800">Aaj ki entries {ledger ? `(${ledger.entries.length})` : ""}</h2>
        <button onClick={onRefresh} className="text-xs font-semibold text-khata-700">↻ Refresh</button>
      </div>
      <div className="ledger-lines overflow-hidden rounded-2xl border border-khata-100 bg-white">
        {!ledger && <p className="p-6 text-center text-sm text-syahi/50">Load ho raha hai…</p>}
        {ledger && ledger.entries.length === 0 && (
          <div className="p-6 text-center">
            <p className="text-3xl">🎙️</p>
            <p className="mt-2 font-bold">Abhi koi entry nahi</p>
            <p className="mt-1 text-sm text-syahi/60">Neeche mic dabayein aur bolein:</p>
            <p className="mt-2 text-sm italic text-khata-800">“Aslam ko 2 kilo cheeni udhar, 300 rupay”</p>
            <p className="text-sm italic text-khata-800">“50 kilo aata aaya, rack 2 mein rakha”</p>
          </div>
        )}
        {ledger?.entries.map((e) => {
          const s = ACTION_STYLE[e.action];
          const title = e.party_name || e.item_name || s.label;
          const sub = [e.party_name ? e.item_name : null, fmtQty(e.quantity, e.unit), e.shelf_location ? `📍 ${e.shelf_location}` : null]
            .filter(Boolean)
            .join(" · ");
          return (
            <div key={e.id} className="flex min-h-14 items-center gap-3 border-b border-khata-100/70 px-3 py-2 last:border-0">
              <span className={`w-16 shrink-0 rounded-lg px-1.5 py-1 text-center text-[11px] font-bold ${s.chip}`}>{s.label}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold capitalize">{title}</p>
                <p className="truncate text-xs text-syahi/60">
                  {fmtTime(e.created_at)}
                  {sub ? ` · ${sub}` : ""}
                  {e.source === "receipt" ? " · 🧾" : ""}
                </p>
              </div>
              <p className="shrink-0 font-bold tabular-nums">
                {e.amount !== null ? `${s.sign}${rupees(e.amount)}` : "—"}
              </p>
              <button
                onClick={() => { if (confirm("Ye entry hata dein?")) onUndo(e.id); }}
                className="shrink-0 rounded-lg px-1.5 py-1 text-syahi/30 active:text-rose-600"
                aria-label="Entry hatayein"
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* =====================================================================
   Floating mic + camera + typing fallback
   ===================================================================== */

function ActionDock({
  busy,
  onAudio,
  onImage,
  onText,
  onError,
}: {
  busy: null | "voice" | "scan" | "text" | "find";
  onAudio: (blob: Blob, mime: string) => void;
  onImage: (file: File) => void;
  onText: (text: string) => Promise<boolean>;
  onError: (msg: string) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState("");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const cleanup = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  useEffect(() => cleanup, []);

  const stop = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
  }, []);

  const start = async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      onError("Is browser mein recording nahi hoti. Chrome istemal karein.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      streamRef.current = stream;
      const mime = pickAudioMime();
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
      rec.onstop = () => {
        const type = rec.mimeType || mime || "audio/webm";
        const blob = new Blob(chunksRef.current, { type });
        cleanup();
        setRecording(false);
        if (blob.size > 1000) onAudio(blob, type);
        else onError("Awaaz record nahi hui, mic dabakar bolein.");
      };
      rec.start(250);
      recorderRef.current = rec;
      setSeconds(0);
      setRecording(true);
      navigator.vibrate?.(40);
      timerRef.current = setInterval(() => {
        setSeconds((s) => {
          if (s + 1 >= MAX_RECORD_SECONDS) stop();
          return s + 1;
        });
      }, 1000);
    } catch (err) {
      cleanup();
      const name = (err as DOMException)?.name;
      onError(name === "NotAllowedError" ? "Mic ki ijazat dein (browser settings mein Allow karein)." : "Mic shuru nahi hua.");
    }
  };

  const voiceBusy = busy === "voice";

  return (
    <>
      {typing && (
        <div className="fixed inset-x-0 bottom-0 z-40 mx-auto max-w-md rounded-t-3xl bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl slide-up">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (text.trim() && (await onText(text.trim()))) {
                setText("");
                setTyping(false);
              }
            }}
          >
            <p className="mb-2 text-sm font-bold">Likh kar entry</p>
            <textarea
              autoFocus
              rows={2}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Misal: Rashid ko 1 dalda ghee udhar 650"
              className="w-full rounded-xl border-2 border-khata-100 p-3 text-base outline-none focus:border-khata-700"
            />
            <div className="mt-3 flex gap-2">
              <button type="button" onClick={() => setTyping(false)} className="flex-1 rounded-xl border border-khata-100 py-3 font-semibold">
                Wapas
              </button>
              <button disabled={busy === "text" || !text.trim()} className="flex-[2] rounded-xl bg-khata-800 py-3 font-bold text-white disabled:opacity-50">
                {busy === "text" ? "Darj ho raha hai…" : "Darj karein"}
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 mx-auto max-w-md bg-gradient-to-t from-kaghaz via-kaghaz/95 to-transparent px-6 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-10">
        {recording && (
          <p className="mb-3 text-center text-sm font-bold text-rose-600">
            ● Bol rahe hain… {pad2(Math.floor(seconds / 60))}:{pad2(seconds % 60)} — rokne ke liye dabayein
          </p>
        )}
        {voiceBusy && <p className="mb-3 text-center text-sm font-bold text-khata-800">Sun kar likh raha hai…</p>}
        {busy === "scan" && <p className="mb-3 text-center text-sm font-bold text-khata-800">Bill parh raha hai…</p>}

        <div className="pointer-events-auto flex items-end justify-between">
          <button
            onClick={() => fileRef.current?.click()}
            disabled={!!busy || recording}
            className="flex h-14 w-14 flex-col items-center justify-center rounded-2xl bg-white text-2xl shadow-md ring-1 ring-khata-100 active:scale-95 disabled:opacity-40"
            aria-label="Bill scan karein"
          >
            📷
            <span className="text-[9px] font-bold text-khata-800">BILL</span>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) onImage(f);
            }}
          />

          <button
            onClick={recording ? stop : start}
            disabled={voiceBusy || busy === "scan"}
            className={`relative isolate grid h-24 w-24 place-items-center rounded-full text-white shadow-xl transition active:scale-95 disabled:opacity-70 ${
              recording ? "pulse-ring bg-rose-600" : "bg-khata-800 shadow-khata-900/40"
            }`}
            aria-label={recording ? "Recording rokein" : "Bol kar entry karein"}
          >
            {voiceBusy ? (
              <span className="h-9 w-9 animate-spin rounded-full border-4 border-white/30 border-t-white" />
            ) : recording ? (
              <span className="h-8 w-8 rounded-md bg-white" />
            ) : (
              <svg viewBox="0 0 24 24" className="h-11 w-11" fill="currentColor" aria-hidden>
                <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z" />
              </svg>
            )}
          </button>

          <button
            onClick={() => setTyping(true)}
            disabled={!!busy || recording}
            className="flex h-14 w-14 flex-col items-center justify-center rounded-2xl bg-white text-2xl shadow-md ring-1 ring-khata-100 active:scale-95 disabled:opacity-40"
            aria-label="Likh kar entry"
          >
            ⌨️
            <span className="text-[9px] font-bold text-khata-800">LIKHO</span>
          </button>
        </div>
      </div>
    </>
  );
}

/* =====================================================================
   Toast & location popup
   ===================================================================== */

function ToastView({ toast, onClose }: { toast: NonNullable<Toast>; onClose: () => void }) {
  const tone =
    toast.tone === "ok" ? "bg-khata-900 text-white" : toast.tone === "err" ? "bg-rose-600 text-white" : "bg-syahi text-white";
  return (
    <div className="fixed inset-x-0 bottom-36 z-40 mx-auto max-w-md px-4 slide-up" role="status">
      <button onClick={onClose} className={`w-full rounded-2xl px-4 py-3 text-left shadow-xl ${tone}`}>
        <p className="font-bold">{toast.tone === "ok" ? "✓ " : toast.tone === "err" ? "⚠ " : ""}{toast.title}</p>
        {toast.detail && <p className="mt-0.5 text-sm opacity-80">{toast.detail}</p>}
      </button>
    </div>
  );
}

function LocationSheet({ result, onClose }: { result: NonNullable<LocationResult>; onClose: () => void }) {
  const top = result.matches[0];
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-t-3xl bg-white p-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-4 h-1.5 w-12 rounded-full bg-syahi/15" />
        {top ? (
          <>
            <p className="text-sm font-semibold uppercase tracking-wide text-khata-700">📍 Yahan rakha hai</p>
            <p className="mt-1 text-2xl font-extrabold capitalize">{top.name}</p>
            <p className="mt-3 rounded-2xl bg-haldi-100 px-4 py-4 text-2xl font-extrabold text-khata-950">
              {top.shelf_location || "Jagah darj nahi — bolein “… rack 1 mein rakha hai”"}
            </p>
            <p className="mt-2 text-sm text-syahi/60">Stock: {fmtQty(top.quantity, top.unit) || "—"}</p>
            {result.matches.length > 1 && (
              <div className="mt-4 border-t border-khata-100 pt-3">
                <p className="mb-2 text-xs font-bold uppercase text-syahi/50">Milti julti cheezein</p>
                {result.matches.slice(1).map((m) => (
                  <p key={m.id} className="flex justify-between py-1 text-sm">
                    <span className="capitalize">{m.name}</span>
                    <span className="font-semibold">{m.shelf_location || "—"}</span>
                  </p>
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            <p className="text-xl font-extrabold">“{result.query}” nahi mila</p>
            <p className="mt-2 text-syahi/70">{result.reply}</p>
          </>
        )}
        <button onClick={onClose} className="mt-5 w-full rounded-2xl bg-khata-800 py-3.5 font-bold text-white">
          Theek hai
        </button>
      </div>
    </div>
  );
}

/* =====================================================================
   Paywall (unclosable)
   ===================================================================== */

function Paywall({
  config,
  user,
  api,
  onUser,
}: {
  config: AppConfig | null;
  user: UserState;
  api: <T>(path: string, init?: RequestInit) => Promise<T>;
  onUser: (u: UserState) => void;
}) {
  const p = config?.payment;
  const methods = useMemo(
    () =>
      [
        { key: "JazzCash", number: p?.jazzcash, color: "bg-red-600" },
        { key: "Easypaisa", number: p?.easypaisa, color: "bg-emerald-600" },
        { key: "SadaPay", number: p?.sadapay, color: "bg-orange-500" },
      ].filter((m) => !!m.number),
    [p]
  );
  const [method, setMethod] = useState<string>("");
  const [trx, setTrx] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [copied, setCopied] = useState("");
  const pending = user.payment_status === "pending";
  const rejected = user.payment_status === "rejected";

  useEffect(() => {
    if (!method && methods[0]) setMethod(methods[0].key);
  }, [methods, method]);

  // Block back-button escape
  useEffect(() => {
    const block = () => history.pushState(null, "", location.href);
    block();
    window.addEventListener("popstate", block);
    return () => window.removeEventListener("popstate", block);
  }, []);

  const copy = async (num: string) => {
    try {
      await navigator.clipboard.writeText(num);
      setCopied(num);
      setTimeout(() => setCopied(""), 1500);
    } catch {}
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = trx.replace(/\s+/g, "");
    if (clean.length < 6) {
      setError("Sahi TRX ID likhein (SMS mein milti hai)");
      return;
    }
    setSending(true);
    setError("");
    try {
      const res = await api<UserState & { status: string }>("/api/payment", {
        method: "POST",
        body: JSON.stringify({ method: method || "JazzCash", trx_id: clean, amount: config?.plan.price_pkr }),
      });
      onUser(res);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  const waText = encodeURIComponent(`Lala Hisab payment\nNumber: ${user.phone}\nTRX: ${trx || "-"}`);

  return (
    <div
      className="fixed inset-0 z-[9999] overflow-y-auto bg-khata-950 text-kaghaz"
      role="dialog"
      aria-modal="true"
      aria-labelledby="paywall-title"
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="mx-auto flex min-h-full max-w-md flex-col px-5 pb-[max(2rem,env(safe-area-inset-bottom))] pt-[max(2.5rem,env(safe-area-inset-top))]">
        <div className="text-5xl">🔒</div>
        <h2 id="paywall-title" className="mt-4 text-2xl font-extrabold leading-snug">
          {PAYWALL_TEXT}
        </h2>

        <div className="mt-5 rounded-2xl bg-haldi-400 p-4 text-khata-950">
          <p className="text-sm font-bold uppercase tracking-wide">{config?.plan.label || "Plan"}</p>
          <p className="text-3xl font-black">{rupees(config?.plan.price_pkr ?? 0)}</p>
          <p className="mt-1 text-sm font-medium">Aapka saara hisab mehfooz hai — unlock hote hi wapas mil jayega.</p>
        </div>

        {pending ? (
          <div className="mt-6 rounded-2xl bg-white/10 p-5 text-center">
            <div className="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-white/20 border-t-haldi-400" />
            <p className="mt-4 text-lg font-bold">Payment check ho rahi hai</p>
            <p className="mt-1 text-sm text-khata-100/80">TRX ID mil gayi. Tasdeeq hote hi app khud khul jayegi.</p>
          </div>
        ) : (
          <>
            {rejected && (
              <p className="mt-4 rounded-xl bg-rose-600 px-4 py-3 text-sm font-semibold">
                Pichli TRX ID tasdeeq nahi hui. Dobara sahi TRX ID bhejein.
              </p>
            )}

            <p className="mt-6 text-sm font-bold uppercase tracking-wide text-khata-100/70">1. In mein se kisi par bhejein</p>
            {p?.account_title && <p className="mt-1 text-sm">Account title: <b>{p.account_title}</b></p>}
            <div className="mt-2 space-y-2">
              {methods.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  onClick={() => { setMethod(m.key); copy(m.number!); }}
                  className={`flex w-full items-center justify-between rounded-2xl border-2 bg-white/5 px-4 py-3 text-left ${
                    method === m.key ? "border-haldi-400" : "border-white/10"
                  }`}
                >
                  <span className="flex items-center gap-3">
                    <span className={`h-3 w-3 rounded-full ${m.color}`} />
                    <span>
                      <span className="block font-bold">{m.key}</span>
                      <span className="block font-mono text-lg tracking-wider">{m.number}</span>
                    </span>
                  </span>
                  <span className="text-xs font-bold text-haldi-400">{copied === m.number ? "Copied ✓" : "Copy"}</span>
                </button>
              ))}
            </div>

            {(p?.link_url || p?.qr_image_url) && (
              <div className="mt-3 flex items-center gap-3">
                {p?.qr_image_url && (
                  <img src={p.qr_image_url} alt="Payment QR" className="h-28 w-28 rounded-xl bg-white p-1.5" />
                )}
                {p?.link_url && (
                  <a
                    href={p.link_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 rounded-2xl bg-white py-3 text-center font-bold text-khata-950"
                  >
                    Payment link kholein ↗
                  </a>
                )}
              </div>
            )}

            <form onSubmit={submit} className="mt-6">
              <p className="text-sm font-bold uppercase tracking-wide text-khata-100/70">2. TRX ID likhein</p>
              <input
                value={trx}
                onChange={(e) => setTrx(e.target.value.toUpperCase())}
                placeholder="Misal: 012345678901"
                autoComplete="off"
                inputMode="text"
                className="mt-2 w-full rounded-2xl border-2 border-white/15 bg-white px-4 py-4 font-mono text-xl font-bold tracking-wider text-syahi outline-none focus:border-haldi-400"
              />
              {error && <p className="mt-2 text-sm font-semibold text-rose-300">{error}</p>}
              <button
                disabled={sending}
                className="mt-4 w-full rounded-2xl bg-haldi-500 py-4 text-lg font-extrabold text-khata-950 disabled:opacity-60"
              >
                {sending ? "Bhej rahe hain…" : "Unlock karein"}
              </button>
            </form>
          </>
        )}

        {config?.support_whatsapp && (
          <a
            href={`https://wa.me/${config.support_whatsapp}?text=${waText}`}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-5 block text-center text-sm font-semibold text-khata-100/80 underline"
          >
            Madad chahiye? WhatsApp par screenshot bhejein
          </a>
        )}
      </div>
    </div>
  );
}
