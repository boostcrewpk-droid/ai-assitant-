"""
Lala Hisab — FastAPI backend
Voice (Groq Whisper) + Gemini Flash structured extraction + Supabase ledger.

Run locally:   uvicorn main:app --reload --port 8000
Required env:  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GROQ_API_KEY, GEMINI_API_KEY
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
import secrets
from datetime import datetime, time, timedelta, timezone
from enum import Enum
from typing import Any, Optional
from zoneinfo import ZoneInfo

from fastapi import Depends, FastAPI, File, Header, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator

# =====================================================================
# Settings
# =====================================================================

def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


class Settings:
    supabase_url = _env("SUPABASE_URL")
    supabase_key = _env("SUPABASE_SERVICE_ROLE_KEY")
    groq_api_key = _env("GROQ_API_KEY")
    gemini_api_key = _env("GEMINI_API_KEY")

    whisper_model = _env("WHISPER_MODEL", "whisper-large-v3")
    gemini_model = _env("GEMINI_MODEL", "gemini-3.6-flash")
    gemini_thinking_level = _env("GEMINI_THINKING_LEVEL", "low")  # minimal|low|medium|high|"" (off)

    trial_minutes = int(_env("TRIAL_MINUTES", "60"))
    allowed_origins = [o.strip() for o in _env("ALLOWED_ORIGINS", "*").split(",") if o.strip()]
    timezone = ZoneInfo(_env("SHOP_TIMEZONE", "Asia/Karachi"))

    # Paywall details shown in the app (your own receiving accounts)
    plan_price_pkr = int(_env("PLAN_PRICE_PKR", "1000"))
    plan_label = _env("PLAN_LABEL", "Mahana plan")
    pay_account_title = _env("PAY_ACCOUNT_TITLE")
    pay_jazzcash_number = _env("PAY_JAZZCASH_NUMBER")
    pay_easypaisa_number = _env("PAY_EASYPAISA_NUMBER")
    pay_sadapay_number = _env("PAY_SADAPAY_NUMBER")
    pay_link_url = _env("PAY_LINK_URL")
    pay_qr_image_url = _env("PAY_QR_IMAGE_URL")
    support_whatsapp = _env("SUPPORT_WHATSAPP")

    max_audio_bytes = 25 * 1024 * 1024
    max_image_bytes = 10 * 1024 * 1024


settings = Settings()
log = logging.getLogger("lala-hisab")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

CATEGORIES = ("Kiryana", "Auto Parts", "Garments", "Medical", "Workshop")
PHONE_RE = re.compile(r"^03\d{9}$")

# =====================================================================
# AI schemas (Gemini structured output)
# =====================================================================

class Action(str, Enum):
    ADD_STOCK = "ADD_STOCK"
    UDHAR_ENTRY = "UDHAR_ENTRY"
    CASH_SALE = "CASH_SALE"
    FIND_LOCATION = "FIND_LOCATION"
    EXPENSE = "EXPENSE"
    UNCLEAR = "UNCLEAR"


class VoiceExtraction(BaseModel):
    action: Action = Field(description="The single action the shopkeeper wants.")
    customer_name: Optional[str] = Field(None, description="Customer name for UDHAR_ENTRY / CASH_SALE.")
    supplier_name: Optional[str] = Field(None, description="Supplier/distributor name for ADD_STOCK.")
    item_name: Optional[str] = Field(None, description="Product name, Roman Urdu/English, lowercase, include size/brand (e.g. 'surf excel 1kg').")
    quantity: Optional[float] = Field(None, description="Numeric quantity.")
    unit: Optional[str] = Field(None, description="Unit: kg, gram, litre, packet, piece, dozen, carton, bori, meter, etc.")
    amount: Optional[float] = Field(None, description="TOTAL rupees for the whole entry.")
    unit_price: Optional[float] = Field(None, description="Rupees per ONE unit, only if spoken as per-unit rate.")
    shelf_location: Optional[str] = Field(None, description="Where the item is kept, in Roman Urdu (e.g. 'rack 2, upar wala khana').")
    expense_note: Optional[str] = Field(None, description="For EXPENSE: what the money was spent on.")
    clean_text: str = Field(description="The shopkeeper's sentence rewritten in clear Roman Urdu.")


class ReceiptItem(BaseModel):
    item_name: str = Field(description="Product name in Roman Urdu/English, lowercase, include brand and pack size.")
    quantity: float = Field(description="Quantity received.")
    unit: Optional[str] = Field(None, description="Unit (carton, packet, piece, kg, litre, dozen...).")
    unit_price: Optional[float] = Field(None, description="Rate per unit in rupees.")
    line_total: Optional[float] = Field(None, description="Line total in rupees.")


class ReceiptExtraction(BaseModel):
    supplier_name: Optional[str] = Field(None, description="Distributor / company on the bill.")
    bill_number: Optional[str] = None
    bill_total: Optional[float] = Field(None, description="Grand total on the bill in rupees.")
    items: list[ReceiptItem] = Field(default_factory=list)


VOICE_SYSTEM_PROMPT = """You are the bookkeeper inside "Lala Hisab", a voice ledger for small shops in Pakistan.
The input is a speech-to-text transcript. It may be Urdu (Urdu or Roman script), Punjabi, Pashto, Sindhi,
Saraiki, English, or a mix. Transcription errors are common: infer the intended meaning.

Shop category: {category}

Choose exactly one action:
- ADD_STOCK: goods came IN to the shop (maal aaya, stock aaya, khareeda, supplier ne diya), or the shopkeeper
  is telling where an item is kept (e.g. "cheeni rack 3 mein rakhi hai" -> ADD_STOCK with quantity null and shelf_location).
- CASH_SALE: goods sold for cash now (becha, naqad, cash mein diya).
- UDHAR_ENTRY: goods/money given on credit to a customer (udhar, khata, baad mein dega, likh lo X ke naam).
- EXPENSE: shop spending that is not stock (bijli ka bill, kiraya, chai, mazdoor, transport, salary).
- FIND_LOCATION: asking where an item is kept (kahan hai, kahan rakha, kidhar, kithay, cherta, kithe).
- UNCLEAR: anything else or empty/noise.

Rules:
- Convert spoken numbers to digits: "dhai sau"=250, "sawa sau"=125, "dairh hazar"=1500, "paune do sau"=175,
  "saadhe teen"=3.5, "ek darjan"=12 pieces, "aadha kilo"=0.5 kg, "pao"=0.25 kg, "lakh"=100000.
- amount is ALWAYS the total rupees. If the speaker gives a per-unit rate ("200 rupay kilo"), put it in
  unit_price and compute amount = quantity * unit_price.
- item_name: lowercase Roman Urdu/English common name, keep brand and size ("dalda ghee 5 litre", "brake shoe 70cc").
- Names of people: keep as spoken, Title Case in Roman script.
- shelf_location in short Roman Urdu.
- Never invent values that were not said; use null.
"""

RECEIPT_SYSTEM_PROMPT = """You read Pakistani distributor bills / invoices / kachi parchi (printed or handwritten,
Urdu or English) for a {category} shop. Extract every purchased line item.
- item_name lowercase, include brand and pack size.
- quantity as number of units received; unit as written (carton, ctn, pcs, dozen, kg...).
- unit_price is the rate; line_total is the amount column. Use null when not legible.
- Ignore discounts, taxes, previous balance and totals rows as items (but report bill_total).
Return an empty items list if the image is not a bill.
"""

WHISPER_PROMPT = (
    "Dukaan ka hisab. Udhar, naqad, cash, becha, maal aaya, stock, kharcha, kiraya, bijli ka bill, "
    "kahan rakha hai, rack, khana, shelf. cheeni, aata, ghee, chawal, daal, surf, sabun, "
    "brake shoe, chain, mobil oil, kapra, suit, panadol, sau, hazar, dhai sau, sawa, dairh, darjan, kilo, packet."
)

# =====================================================================
# AI clients
# =====================================================================

class AIService:
    """Thin wrapper so tests can replace it with a fake."""

    def __init__(self) -> None:
        self._groq = None
        self._gemini = None

    @property
    def groq(self):
        if self._groq is None:
            if not settings.groq_api_key:
                raise HTTPException(503, "GROQ_API_KEY set nahi hai")
            from groq import Groq
            self._groq = Groq(api_key=settings.groq_api_key, timeout=60, max_retries=2)
        return self._groq

    @property
    def gemini(self):
        if self._gemini is None:
            if not settings.gemini_api_key:
                raise HTTPException(503, "GEMINI_API_KEY set nahi hai")
            from google import genai
            self._gemini = genai.Client(api_key=settings.gemini_api_key)
        return self._gemini

    def transcribe(self, audio: bytes, filename: str) -> str:
        result = self.groq.audio.transcriptions.create(
            file=(filename, audio),
            model=settings.whisper_model,
            prompt=WHISPER_PROMPT,
            response_format="text",
            temperature=0.0,
        )
        text = result if isinstance(result, str) else getattr(result, "text", "")
        return (text or "").strip()

    def _config(self, system_prompt: str, schema: type[BaseModel]):
        from google.genai import types
        kwargs: dict[str, Any] = dict(
            system_instruction=system_prompt,
            response_mime_type="application/json",
            response_schema=schema,
            temperature=0.1,
        )
        if settings.gemini_thinking_level:
            kwargs["thinking_config"] = types.ThinkingConfig(
                thinking_level=settings.gemini_thinking_level.upper()
            )
        return types.GenerateContentConfig(**kwargs)

    def extract_voice(self, transcript: str, category: str) -> VoiceExtraction:
        response = self.gemini.models.generate_content(
            model=settings.gemini_model,
            contents=f"Transcript: {transcript}",
            config=self._config(VOICE_SYSTEM_PROMPT.format(category=category), VoiceExtraction),
        )
        return VoiceExtraction.model_validate_json(response.text)

    def extract_receipt(self, image: bytes, mime_type: str, category: str) -> ReceiptExtraction:
        from google.genai import types
        response = self.gemini.models.generate_content(
            model=settings.gemini_model,
            contents=[
                types.Part.from_bytes(data=image, mime_type=mime_type),
                "Is bill ke saare items nikaalo.",
            ],
            config=self._config(RECEIPT_SYSTEM_PROMPT.format(category=category), ReceiptExtraction),
        )
        return ReceiptExtraction.model_validate_json(response.text)


# =====================================================================
# Data access (Supabase)
# =====================================================================

class Repo:
    def __init__(self) -> None:
        self._client = None

    @property
    def db(self):
        if self._client is None:
            if not (settings.supabase_url and settings.supabase_key):
                raise HTTPException(503, "Supabase env vars set nahi hain")
            from supabase import create_client
            self._client = create_client(settings.supabase_url, settings.supabase_key)
        return self._client

    # ---- users
    def get_user_by_phone(self, phone: str) -> Optional[dict]:
        rows = self.db.table("users").select("*").eq("phone", phone).limit(1).execute().data
        return rows[0] if rows else None

    def get_user_by_token_hash(self, token_hash: str) -> Optional[dict]:
        rows = (self.db.table("users").select("*")
                .eq("session_token_hash", token_hash).limit(1).execute().data)
        return rows[0] if rows else None

    def create_user(self, phone: str, category: str, token_hash: str) -> dict:
        return self.db.table("users").insert({
            "phone": phone, "business_category": category, "session_token_hash": token_hash,
        }).execute().data[0]

    def update_user(self, user_id: str, fields: dict) -> dict:
        return self.db.table("users").update(fields).eq("id", user_id).execute().data[0]

    # ---- products
    def apply_stock_delta(self, user_id: str, name: str, delta: float, unit: Optional[str],
                          unit_price: Optional[float], shelf: Optional[str]) -> dict:
        rows = self.db.rpc("apply_stock_delta", {
            "p_user_id": user_id, "p_name": name, "p_delta": delta,
            "p_unit": unit, "p_price": unit_price, "p_shelf": shelf,
        }).execute().data
        return rows[0]

    def find_products(self, user_id: str, query: str, limit: int = 5) -> list[dict]:
        return self.db.rpc("find_products", {
            "p_user_id": user_id, "p_query": query, "p_limit": limit,
        }).execute().data or []

    # ---- transactions
    def insert_transaction(self, row: dict) -> dict:
        return self.db.table("transactions").insert(row).execute().data[0]

    def get_transaction(self, user_id: str, tx_id: str) -> Optional[dict]:
        rows = (self.db.table("transactions").select("*")
                .eq("user_id", user_id).eq("id", tx_id).limit(1).execute().data)
        return rows[0] if rows else None

    def delete_transaction(self, user_id: str, tx_id: str) -> None:
        self.db.table("transactions").delete().eq("user_id", user_id).eq("id", tx_id).execute()

    def transactions_between(self, user_id: str, start: datetime, end: datetime) -> list[dict]:
        return (self.db.table("transactions").select("*")
                .eq("user_id", user_id)
                .gte("created_at", start.isoformat()).lt("created_at", end.isoformat())
                .order("created_at", desc=True).limit(500).execute().data) or []

    # ---- payments
    def payment_by_trx(self, trx_id: str) -> Optional[dict]:
        rows = self.db.table("payments").select("*").eq("trx_id", trx_id).limit(1).execute().data
        return rows[0] if rows else None

    def latest_payment(self, user_id: str) -> Optional[dict]:
        rows = (self.db.table("payments").select("*").eq("user_id", user_id)
                .order("created_at", desc=True).limit(1).execute().data)
        return rows[0] if rows else None

    def insert_payment(self, row: dict) -> dict:
        return self.db.table("payments").insert(row).execute().data[0]


ai = AIService()
repo = Repo()


def get_ai() -> AIService:
    return ai


def get_repo() -> Repo:
    return repo


# =====================================================================
# Helpers
# =====================================================================

def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def parse_ts(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def trial_ends_at(user: dict) -> datetime:
    return parse_ts(user["first_login_at"]) + timedelta(minutes=settings.trial_minutes)


def is_locked(user: dict) -> bool:
    return (not user.get("is_paid")) and now_utc() >= trial_ends_at(user)


def num(value: Any) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def clean(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    value = re.sub(r"\s+", " ", str(value)).strip()
    return value or None


def rs(value: Optional[float]) -> str:
    if value is None:
        return ""
    return f"Rs {value:,.0f}" if float(value).is_integer() else f"Rs {value:,.2f}"


def qty_text(q: Optional[float], unit: Optional[str]) -> str:
    if q is None:
        return ""
    q_str = f"{q:g}"
    return f"{q_str} {unit}" if unit else q_str


def user_state(user: dict, repo: Repo) -> dict:
    latest = repo.latest_payment(user["id"])
    return {
        "user_id": user["id"],
        "phone": user["phone"],
        "business_category": user["business_category"],
        "first_login_at": parse_ts(user["first_login_at"]).isoformat(),
        "trial_ends_at": trial_ends_at(user).isoformat(),
        "server_now": now_utc().isoformat(),
        "is_paid": bool(user.get("is_paid")),
        "locked": is_locked(user),
        "payment_status": latest["status"] if latest else None,
    }


# =====================================================================
# Auth dependencies
# =====================================================================

def current_user(
    authorization: str = Header(default=""),
    repo: Repo = Depends(get_repo),
) -> dict:
    token = authorization.removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(401, "Login zaroori hai")
    user = repo.get_user_by_token_hash(hash_token(token))
    if not user:
        raise HTTPException(401, "Session khatam. Dobara number darj karein.")
    return user


def active_user(user: dict = Depends(current_user)) -> dict:
    """Server-side trial lock: no writes or reads of the ledger after trial unless paid."""
    if is_locked(user):
        raise HTTPException(402, "TRIAL_EXPIRED")
    return user


# =====================================================================
# Request models
# =====================================================================

class RegisterIn(BaseModel):
    phone: str
    business_category: str

    @field_validator("phone")
    @classmethod
    def _phone(cls, v: str) -> str:
        digits = re.sub(r"\D", "", v)
        if digits.startswith("92") and len(digits) == 12:
            digits = "0" + digits[2:]
        if not PHONE_RE.match(digits):
            raise ValueError("Mobile number 03XXXXXXXXX format mein likhein")
        return digits

    @field_validator("business_category")
    @classmethod
    def _cat(cls, v: str) -> str:
        if v not in CATEGORIES:
            raise ValueError(f"Category in mein se honi chahiye: {', '.join(CATEGORIES)}")
        return v


class PaymentIn(BaseModel):
    method: str
    trx_id: str
    amount: Optional[float] = None

    @field_validator("method")
    @classmethod
    def _method(cls, v: str) -> str:
        if v not in ("JazzCash", "Easypaisa", "SadaPay", "Bank"):
            raise ValueError("Ghalat payment method")
        return v

    @field_validator("trx_id")
    @classmethod
    def _trx(cls, v: str) -> str:
        v = re.sub(r"\s+", "", v).upper()
        if not re.fullmatch(r"[A-Z0-9\-]{6,40}", v):
            raise ValueError("TRX ID sahi nahi lag rahi (6-40 huroof/number)")
        return v


class ManualEntryIn(BaseModel):
    text: str = Field(min_length=2, max_length=500)


# =====================================================================
# Core: apply an extraction to the ledger
# =====================================================================

def apply_extraction(user: dict, ex: VoiceExtraction, transcript: str, source: str, repo: Repo) -> dict:
    uid = user["id"]
    action = ex.action
    item = clean(ex.item_name)
    qty = num(ex.quantity)
    unit = clean(ex.unit)
    amount = num(ex.amount)
    unit_price = num(ex.unit_price)
    shelf = clean(ex.shelf_location)

    if amount is None and unit_price is not None and qty:
        amount = round(unit_price * qty, 2)
    if unit_price is None and amount is not None and qty:
        unit_price = round(amount / qty, 2)

    if action == Action.UNCLEAR:
        raise HTTPException(422, {"message": "Baat samajh nahi aayi, dobara bolein.", "transcript": transcript})

    if action == Action.FIND_LOCATION:
        if not item:
            raise HTTPException(422, {"message": "Kis cheez ka poocha? Naam ke saath dobara bolein.", "transcript": transcript})
        matches = repo.find_products(uid, item)
        return {"kind": "location", "query": item, "matches": matches, "transcript": transcript,
                "reply": location_reply(item, matches)}

    stock_delta = 0.0
    product_id = None
    party = clean(ex.supplier_name) if action == Action.ADD_STOCK else clean(ex.customer_name)

    if action == Action.ADD_STOCK:
        if not item:
            raise HTTPException(422, {"message": "Kaunsa maal aaya? Naam ke saath bolein.", "transcript": transcript})
        stock_delta = qty or 0.0
        prod = repo.apply_stock_delta(uid, item, stock_delta, unit, unit_price, shelf)
        product_id = prod["product_id"]

    elif action in (Action.CASH_SALE, Action.UDHAR_ENTRY):
        if action == Action.UDHAR_ENTRY and not party:
            raise HTTPException(422, {"message": "Udhar kis ke naam likhna hai? Gahak ka naam bolein.", "transcript": transcript})
        if item:
            if amount is None and qty:
                known = repo.find_products(uid, item, 1)
                if known and known[0].get("unit_price") is not None and (known[0].get("score") or 0) >= 0.6:
                    amount = round(float(known[0]["unit_price"]) * qty, 2)
            if qty:
                stock_delta = -qty
                prod = repo.apply_stock_delta(uid, item, stock_delta, unit, None, shelf)
                product_id = prod["product_id"]
        if amount is None:
            raise HTTPException(422, {"message": "Raqam samajh nahi aayi. Kitne rupay? Dobara bolein.", "transcript": transcript})

    elif action == Action.EXPENSE:
        if amount is None:
            raise HTTPException(422, {"message": "Kharche ki raqam bolein.", "transcript": transcript})
        item = clean(ex.expense_note) or item or "kharcha"

    tx = repo.insert_transaction({
        "user_id": uid, "action": action.value, "party_name": party, "item_name": item,
        "quantity": qty, "unit": unit, "amount": amount, "shelf_location": shelf,
        "product_id": product_id, "stock_delta": stock_delta, "source": source,
        "transcript": transcript[:2000] if transcript else None,
    })
    return {"kind": "entry", "entry": tx, "transcript": transcript, "reply": entry_reply(tx)}


def entry_reply(tx: dict) -> str:
    a, party, item = tx["action"], tx.get("party_name"), tx.get("item_name")
    q = qty_text(num(tx.get("quantity")), tx.get("unit"))
    amt = rs(num(tx.get("amount")))
    if a == "ADD_STOCK":
        parts = [f"{q} {item}".strip() + " stock mein add"]
        if tx.get("shelf_location"):
            parts.append(f"jagah: {tx['shelf_location']}")
        if party:
            parts.append(f"supplier: {party}")
        return " • ".join(parts)
    if a == "UDHAR_ENTRY":
        return f"{party} ke khaate mein {amt} udhar" + (f" ({q} {item})".rstrip() if item else "")
    if a == "CASH_SALE":
        return f"Naqad sale {amt}" + (f" — {q} {item}".rstrip() if item else "")
    return f"Kharcha {amt} — {item}"


def location_reply(query: str, matches: list[dict]) -> str:
    if not matches:
        return f"'{query}' abhi register nahi. Bolein: \"{query} rack 1 mein rakha hai\""
    top = matches[0]
    where = top.get("shelf_location") or "jagah darj nahi"
    stock = qty_text(num(top.get("quantity")), top.get("unit"))
    return f"{top['name']}: {where}" + (f" (stock: {stock})" if stock else "")


# =====================================================================
# App
# =====================================================================

app = FastAPI(title="Lala Hisab API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
    max_age=86400,
)


@app.get("/health")
def health() -> dict:
    return {"ok": True, "time": now_utc().isoformat()}


@app.get("/api/config")
def config() -> dict:
    return {
        "trial_minutes": settings.trial_minutes,
        "categories": list(CATEGORIES),
        "plan": {"price_pkr": settings.plan_price_pkr, "label": settings.plan_label},
        "payment": {
            "account_title": settings.pay_account_title,
            "jazzcash": settings.pay_jazzcash_number,
            "easypaisa": settings.pay_easypaisa_number,
            "sadapay": settings.pay_sadapay_number,
            "link_url": settings.pay_link_url,
            "qr_image_url": settings.pay_qr_image_url,
        },
        "support_whatsapp": settings.support_whatsapp,
    }


@app.post("/api/register")
def register(body: RegisterIn, repo: Repo = Depends(get_repo)) -> dict:
    """Phone-only login. Existing numbers keep their original first_login_at (no trial reset)."""
    token = secrets.token_urlsafe(32)
    token_hash = hash_token(token)
    user = repo.get_user_by_phone(body.phone)
    if user:
        user = repo.update_user(user["id"], {
            "session_token_hash": token_hash, "last_seen_at": now_utc().isoformat(),
        })
    else:
        try:
            user = repo.create_user(body.phone, body.business_category, token_hash)
        except Exception:  # unique race: another device registered same number at the same moment
            user = repo.get_user_by_phone(body.phone)
            if not user:
                raise
            user = repo.update_user(user["id"], {"session_token_hash": token_hash})
    return {"token": token, **user_state(user, repo)}


@app.get("/api/me")
def me(user: dict = Depends(current_user), repo: Repo = Depends(get_repo)) -> dict:
    return user_state(user, repo)


@app.post("/api/voice-entry")
def voice_entry(
    audio: UploadFile = File(...),
    user: dict = Depends(active_user),
    ai: AIService = Depends(get_ai),
    repo: Repo = Depends(get_repo),
) -> dict:
    data = audio.file.read(settings.max_audio_bytes + 1)
    if len(data) > settings.max_audio_bytes:
        raise HTTPException(413, "Recording bohat lambi hai")
    if len(data) < 1000:
        raise HTTPException(422, {"message": "Awaaz record nahi hui, dobara bolein.", "transcript": ""})

    filename = audio.filename or "voice.webm"
    if "." not in filename:
        ext = {"audio/mp4": "m4a", "audio/aac": "m4a", "audio/ogg": "ogg", "audio/wav": "wav",
               "audio/mpeg": "mp3"}.get((audio.content_type or "").split(";")[0], "webm")
        filename = f"voice.{ext}"

    try:
        transcript = ai.transcribe(data, filename)
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("transcription failed")
        raise HTTPException(502, f"Awaaz se text nahi bana: {exc.__class__.__name__}")

    if not transcript:
        raise HTTPException(422, {"message": "Kuch sunai nahi diya, mic ke qareeb bolein.", "transcript": ""})

    return _process_text(transcript, "voice", user, ai, repo)


@app.post("/api/text-entry")
def text_entry(
    body: ManualEntryIn,
    user: dict = Depends(active_user),
    ai: AIService = Depends(get_ai),
    repo: Repo = Depends(get_repo),
) -> dict:
    """Same pipeline as voice, for typed fallback."""
    return _process_text(body.text.strip(), "manual", user, ai, repo)


def _process_text(text: str, source: str, user: dict, ai: AIService, repo: Repo) -> dict:
    try:
        ex = ai.extract_voice(text, user["business_category"])
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("gemini extraction failed")
        raise HTTPException(502, {"message": "AI abhi jawab nahi de raha, dobara koshish karein.",
                                  "transcript": text, "error": exc.__class__.__name__})
    result = apply_extraction(user, ex, text, source, repo)
    result["extraction"] = ex.model_dump(mode="json")
    return result


@app.post("/api/scan-receipt")
def scan_receipt(
    image: UploadFile = File(...),
    user: dict = Depends(active_user),
    ai: AIService = Depends(get_ai),
    repo: Repo = Depends(get_repo),
) -> dict:
    data = image.file.read(settings.max_image_bytes + 1)
    if len(data) > settings.max_image_bytes:
        raise HTTPException(413, "Tasveer 10MB se bari hai")
    mime = (image.content_type or "image/jpeg").split(";")[0]
    if mime not in ("image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"):
        raise HTTPException(415, "Sirf JPG/PNG/WEBP/HEIC tasveer bhejein")

    try:
        receipt = ai.extract_receipt(data, mime, user["business_category"])
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("receipt extraction failed")
        raise HTTPException(502, f"Bill parha nahi gaya: {exc.__class__.__name__}")

    if not receipt.items:
        raise HTTPException(422, {"message": "Is tasveer mein bill ke items nahi mile. Saaf tasveer lein."})

    supplier = clean(receipt.supplier_name)
    entries = []
    for it in receipt.items:
        name = clean(it.item_name)
        qty = num(it.quantity)
        if not name or qty is None:
            continue
        line_total = num(it.line_total)
        unit_price = num(it.unit_price)
        if line_total is None and unit_price is not None:
            line_total = round(unit_price * qty, 2)
        if unit_price is None and line_total is not None and qty:
            unit_price = round(line_total / qty, 2)
        prod = repo.apply_stock_delta(user["id"], name, qty, clean(it.unit), unit_price, None)
        entries.append(repo.insert_transaction({
            "user_id": user["id"], "action": "ADD_STOCK", "party_name": supplier, "item_name": name,
            "quantity": qty, "unit": clean(it.unit), "amount": line_total, "shelf_location": None,
            "product_id": prod["product_id"], "stock_delta": qty, "source": "receipt",
            "transcript": f"Bill {receipt.bill_number}" if receipt.bill_number else None,
        }))

    return {
        "kind": "receipt",
        "supplier_name": supplier,
        "bill_number": receipt.bill_number,
        "bill_total": receipt.bill_total,
        "entries": entries,
        "reply": f"{len(entries)} items stock mein add" + (f" — {supplier}" if supplier else ""),
    }


@app.get("/api/ledger/today")
def ledger_today(user: dict = Depends(active_user), repo: Repo = Depends(get_repo)) -> dict:
    local_today = now_utc().astimezone(settings.timezone).date()
    start = datetime.combine(local_today, time.min, tzinfo=settings.timezone).astimezone(timezone.utc)
    end = start + timedelta(days=1)
    rows = repo.transactions_between(user["id"], start, end)

    totals = {"CASH_SALE": 0.0, "UDHAR_ENTRY": 0.0, "EXPENSE": 0.0, "ADD_STOCK": 0.0}
    for r in rows:
        totals[r["action"]] = totals.get(r["action"], 0.0) + (num(r.get("amount")) or 0.0)

    return {
        "date": local_today.isoformat(),
        "entries": rows,
        "totals": {
            "cash_sales": round(totals["CASH_SALE"], 2),
            "udhar_given": round(totals["UDHAR_ENTRY"], 2),
            "expenses": round(totals["EXPENSE"], 2),
            "stock_purchases": round(totals["ADD_STOCK"], 2),
            "cash_in_hand": round(totals["CASH_SALE"] - totals["EXPENSE"], 2),
        },
    }


@app.get("/api/find")
def find(q: str = Query(min_length=1, max_length=100), user: dict = Depends(active_user),
         repo: Repo = Depends(get_repo)) -> dict:
    query = re.sub(r"\b(kahan|kahaan|kidhar|kithay|kithe|hai|he|rakha|rakhi|rakhe|para|pari|ka|ki|ke)\b",
                   " ", q.lower())
    query = clean(query) or q.strip()
    matches = repo.find_products(user["id"], query)
    return {"query": query, "matches": matches, "reply": location_reply(query, matches)}


@app.delete("/api/transactions/{tx_id}")
def undo_transaction(tx_id: str, user: dict = Depends(active_user), repo: Repo = Depends(get_repo)) -> dict:
    """Undo a mistaken entry and reverse its stock effect."""
    tx = repo.get_transaction(user["id"], tx_id)
    if not tx:
        raise HTTPException(404, "Entry nahi mili")
    delta = num(tx.get("stock_delta")) or 0.0
    if delta and tx.get("item_name"):
        repo.apply_stock_delta(user["id"], tx["item_name"], -delta, None, None, None)
    repo.delete_transaction(user["id"], tx_id)
    return {"ok": True, "deleted_id": tx_id}


@app.post("/api/payment")
def submit_payment(body: PaymentIn, user: dict = Depends(current_user), repo: Repo = Depends(get_repo)) -> dict:
    """Paywall: store TRX ID as pending. Approve it in Supabase (payments.status='approved') to unlock."""
    if user.get("is_paid"):
        return {"ok": True, "status": "approved", **user_state(user, repo)}
    existing = repo.payment_by_trx(body.trx_id)
    if existing:
        if existing["user_id"] != user["id"]:
            raise HTTPException(409, "Ye TRX ID pehle hi istemal ho chuki hai")
        return {"ok": True, "status": existing["status"], **user_state(user, repo)}
    pay = repo.insert_payment({
        "user_id": user["id"], "method": body.method, "trx_id": body.trx_id,
        "amount": body.amount if body.amount is not None else settings.plan_price_pkr,
    })
    log.info("payment submitted user=%s phone=%s trx=%s", user["id"], user["phone"], body.trx_id)
    return {"ok": True, "status": pay["status"], **user_state(user, repo)}
