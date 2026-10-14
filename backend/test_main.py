"""Offline tests: in-memory DB + fake AI. Run: pytest -q"""
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

import main
from main import Action, ReceiptExtraction, ReceiptItem, VoiceExtraction


class FakeRepo:
    def __init__(self):
        self.users, self.products, self.txs, self.payments = {}, {}, {}, {}

    def get_user_by_phone(self, phone):
        return next((u for u in self.users.values() if u["phone"] == phone), None)

    def get_user_by_token_hash(self, h):
        return next((u for u in self.users.values() if u["session_token_hash"] == h), None)

    def create_user(self, phone, category, h):
        u = {"id": str(uuid.uuid4()), "phone": phone, "business_category": category,
             "first_login_at": datetime.now(timezone.utc).isoformat(), "is_paid": False,
             "session_token_hash": h}
        self.users[u["id"]] = u
        return u

    def update_user(self, uid, fields):
        self.users[uid].update(fields)
        return self.users[uid]

    def apply_stock_delta(self, uid, name, delta, unit, price, shelf):
        key = (uid, " ".join(name.lower().split()))
        p = self.products.setdefault(key, {"id": str(uuid.uuid4()), "name": name, "quantity": 0.0,
                                           "unit": None, "unit_price": None, "shelf_location": None})
        p["quantity"] += delta
        p["unit"] = unit or p["unit"]
        p["unit_price"] = price if price is not None else p["unit_price"]
        p["shelf_location"] = shelf or p["shelf_location"]
        return {"product_id": p["id"], "new_quantity": p["quantity"]}

    def find_products(self, uid, q, limit=5):
        q = q.lower()
        out = [dict(p, score=1.0) for (u, n), p in self.products.items()
               if u == uid and (q in n or n in q or any(w in n for w in q.split()))]
        return out[:limit]

    def insert_transaction(self, row):
        row = dict(row, id=str(uuid.uuid4()), created_at=datetime.now(timezone.utc).isoformat())
        self.txs[row["id"]] = row
        return row

    def get_transaction(self, uid, tid):
        t = self.txs.get(tid)
        return t if t and t["user_id"] == uid else None

    def delete_transaction(self, uid, tid):
        self.txs.pop(tid, None)

    def transactions_between(self, uid, start, end):
        return sorted([t for t in self.txs.values() if t["user_id"] == uid
                       and start <= main.parse_ts(t["created_at"]) < end],
                      key=lambda t: t["created_at"], reverse=True)

    def payment_by_trx(self, trx):
        return next((p for p in self.payments.values() if p["trx_id"] == trx), None)

    def latest_payment(self, uid):
        ps = [p for p in self.payments.values() if p["user_id"] == uid]
        return ps[-1] if ps else None

    def insert_payment(self, row):
        row = dict(row, id=str(uuid.uuid4()), status="pending")
        self.payments[row["id"]] = row
        return row


class FakeAI:
    def __init__(self):
        self.next_voice = None
        self.next_transcript = "test"

    def transcribe(self, audio, filename):
        return self.next_transcript

    def extract_voice(self, text, category):
        return self.next_voice

    def extract_receipt(self, image, mime, category):
        return ReceiptExtraction(supplier_name="Unilever Distributor", bill_total=4200, items=[
            ReceiptItem(item_name="surf excel 1kg", quantity=10, unit="packet", unit_price=350, line_total=3500),
            ReceiptItem(item_name="lux soap", quantity=7, unit="piece", line_total=700),
        ])


@pytest.fixture
def env():
    repo, ai = FakeRepo(), FakeAI()
    main.app.dependency_overrides[main.get_repo] = lambda: repo
    main.app.dependency_overrides[main.get_ai] = lambda: ai
    client = TestClient(main.app)
    r = client.post("/api/register", json={"phone": "0300-1234567", "business_category": "Kiryana"})
    assert r.status_code == 200, r.text
    client.headers["Authorization"] = f"Bearer {r.json()['token']}"
    yield client, repo, ai, r.json()
    main.app.dependency_overrides.clear()


AUDIO = ("v.webm", b"\x1a\x45\xdf\xa3" + b"0" * 2000, "audio/webm")


def voice(client, ai, **kw):
    ai.next_voice = VoiceExtraction(clean_text="x", **kw)
    return client.post("/api/voice-entry", files={"audio": AUDIO})


def test_register_validation_and_no_trial_reset(env):
    client, repo, _, first = env
    assert first["phone"] == "03001234567" and first["locked"] is False
    assert client.post("/api/register", json={"phone": "12345", "business_category": "Kiryana"}).status_code == 422
    assert client.post("/api/register", json={"phone": "03001234567", "business_category": "Bakery"}).status_code == 422
    again = client.post("/api/register", json={"phone": "+92 300 1234567", "business_category": "Kiryana"}).json()
    assert again["first_login_at"] == first["first_login_at"] and len(repo.users) == 1


def test_stock_sale_udhar_expense_find_and_ledger(env):
    client, repo, ai, _ = env
    r = voice(client, ai, action=Action.ADD_STOCK, item_name="Cheeni", quantity=50, unit="kg",
              unit_price=150, shelf_location="rack 3 neeche", supplier_name="Haji Sahib")
    assert r.status_code == 200, r.text
    assert r.json()["entry"]["amount"] == 7500

    r = voice(client, ai, action=Action.CASH_SALE, item_name="cheeni", quantity=2, unit="kg")
    assert r.status_code == 200 and r.json()["entry"]["amount"] == 300  # price from stock

    r = voice(client, ai, action=Action.UDHAR_ENTRY, customer_name="Aslam", item_name="cheeni",
              quantity=5, unit="kg", amount=800)
    assert r.json()["entry"]["party_name"] == "Aslam"

    r = voice(client, ai, action=Action.UDHAR_ENTRY, amount=500)
    assert r.status_code == 422  # no customer name

    r = voice(client, ai, action=Action.EXPENSE, amount=2500, expense_note="bijli ka bill")
    assert r.json()["entry"]["item_name"] == "bijli ka bill"

    r = voice(client, ai, action=Action.FIND_LOCATION, item_name="cheeni")
    assert r.json()["kind"] == "location" and "rack 3 neeche" in r.json()["reply"]

    assert "rack 3 neeche" in client.get("/api/find", params={"q": "cheeni kahan hai"}).json()["reply"]

    product = next(iter(repo.products.values()))
    assert product["quantity"] == 43

    led = client.get("/api/ledger/today").json()
    assert len(led["entries"]) == 4
    assert led["totals"] == {"cash_sales": 300, "udhar_given": 800, "expenses": 2500,
                             "stock_purchases": 7500, "cash_in_hand": -2200}


def test_undo_reverses_stock(env):
    client, repo, ai, _ = env
    tx = voice(client, ai, action=Action.ADD_STOCK, item_name="ghee", quantity=10, unit="packet").json()["entry"]
    voice(client, ai, action=Action.CASH_SALE, item_name="ghee", quantity=3, amount=1500)
    assert client.delete(f"/api/transactions/{tx['id']}").json()["ok"]
    assert next(iter(repo.products.values()))["quantity"] == -3


def test_receipt_scan(env):
    client, repo, _, _ = env
    r = client.post("/api/scan-receipt", files={"image": ("b.jpg", b"\xff\xd8" + b"0" * 500, "image/jpeg")})
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["entries"]) == 2 and body["entries"][1]["amount"] == 700
    assert body["entries"][0]["party_name"] == "Unilever Distributor"


def test_trial_lock_and_payment(env):
    client, repo, ai, _ = env
    user = next(iter(repo.users.values()))
    user["first_login_at"] = (datetime.now(timezone.utc) - timedelta(minutes=61)).isoformat()

    assert client.get("/api/me").json()["locked"] is True
    assert client.get("/api/ledger/today").status_code == 402
    assert voice(client, ai, action=Action.EXPENSE, amount=5).status_code == 402

    assert client.post("/api/payment", json={"method": "JazzCash", "trx_id": "ab"}).status_code == 422
    r = client.post("/api/payment", json={"method": "JazzCash", "trx_id": "0123 456 789"})
    assert r.json()["status"] == "pending" and r.json()["payment_status"] == "pending"

    user["is_paid"] = True  # admin approved in Supabase
    assert client.get("/api/me").json()["locked"] is False
    assert client.get("/api/ledger/today").status_code == 200


def test_unauthorized(env):
    client, *_ = env
    assert client.get("/api/me", headers={"Authorization": "Bearer nope"}).status_code == 401


def test_cors_preflight(env):
    client, *_ = env
    r = client.options("/api/voice-entry", headers={"Origin": "https://x.vercel.app",
                                                    "Access-Control-Request-Method": "POST"})
    assert r.status_code == 200 and "access-control-allow-origin" in r.headers
