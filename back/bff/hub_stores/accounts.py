"""HUB accounts on the renewal Admin › 사용자 관리 screen (2026-10-29).

The top-level administrator lists, creates and changes the HUB's accounts: login ID, name, email, role (admin ·
hq · region · country) and data scope (brands, RHQ regions, countries; front lib/auth/scope-policy), disables and
enables them, and issues a temporary password (a new account, a reset) that the account replaces at its next
sign-in (must_change; hub_auth.change_password). Reads use the read-only operations role; writes use
hmg_account_editor (HGH_ACCOUNT_EDITOR_DB_URL), which can touch the account tables only. Every change is an
audit_event row (account.*, details.user_id = the account), shown as the account's history.

An account is never deleted: disabling it ends its sessions and keeps its history and saved filters. An account
manages only accounts below its own role and hands out only such roles (`below`): an administrator changes no
administrator, itself included, so administrators are named and revoked on the server (manage.py set-admin /
revoke-admin) and the screen cannot lock them out. Writes run one at a time (advisory lock), so a login ID is checked
and taken in turn."""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import secrets
from contextlib import asynccontextmanager
from uuid import UUID, uuid4

import asyncpg
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field

from bff.hub_stores import hub_auth, operations_db
from bff.hub_stores.catalog_editor import refused
from bff.hub_stores.hub_auth import Principal
from bff.hub_stores.passwords import hash_password
from bff.screens._query import RHQ_REGION_COUNTRIES

log = logging.getLogger("hgh.accounts")

ROLES = ("admin", "hq", "region", "country")
RANK = {role: len(ROLES) - i for i, role in enumerate(ROLES)}   # admin 4 … country 1; no role 0
BRANDS = ("Hyundai", "Kia", "Genesis")
ACCOUNT_LOCK = 617427416
LOGIN = re.compile(r"[A-Za-z0-9._@-]{3,200}")
EMAIL = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")
CONTROL = re.compile(r"[\x00-\x1f\x7f]")
NAME_MAX, EMAIL_MAX = 100, 254
PASSWORD_MIN, PASSWORD_MAX = 12, 1024
# Temporary passwords: four groups of four from letters and digits that do not look alike (about 92 bits).
TEMP_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789"

ACCOUNT_COLUMNS = """a.user_id,a.subject,a.display_name,a.email,a.status,a.created_at,a.last_sign_in_at,
    c.user_id IS NOT NULL AS has_password,c.must_change,c.changed_at,g.role,g.brands,g.regions,g.countries,g.updated_at
    FROM system.user_account a LEFT JOIN system.user_credential c USING(user_id) LEFT JOIN system.global_role g USING(user_id)"""
LIST_SQL = f"SELECT {ACCOUNT_COLUMNS} ORDER BY a.created_at,a.subject"
ONE_SQL = f"SELECT {ACCOUNT_COLUMNS} WHERE a.user_id=$1"
# The account's own events, and the management command's for its login ID (set-admin, revoke-admin).
HISTORY_SQL = """SELECT e.event_id,e.action,e.details,e.occurred_at,x.subject AS actor_login,x.display_name AS actor_name
    FROM system.audit_event e LEFT JOIN system.user_account x ON x.user_id=e.actor_id
    WHERE (e.action LIKE 'account.%' AND e.details->>'user_id'=$1) OR (e.action LIKE 'hub_login.%' AND e.details->>'login'=$2)
    ORDER BY e.occurred_at DESC,e.event_id DESC LIMIT 100"""
LOCK_SQL = "SELECT pg_advisory_xact_lock($1)"
TAKEN_SQL = "SELECT 1 FROM system.user_account WHERE lower(subject)=lower($1)"
INSERT_ACCOUNT_SQL = "INSERT INTO system.user_account(user_id,subject,display_name,email) VALUES($1,$2,$3,$4)"
UPDATE_ACCOUNT_SQL = "UPDATE system.user_account SET display_name=$2,email=$3 WHERE user_id=$1"
STATUS_SQL = "UPDATE system.user_account SET status=$2 WHERE user_id=$1"
SIGNED_IN_SQL = "UPDATE system.user_account SET last_sign_in_at=now() WHERE user_id=$1"
ROLE_SQL = """INSERT INTO system.global_role(user_id,role,brands,regions,countries) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(user_id) DO UPDATE SET role=EXCLUDED.role,brands=EXCLUDED.brands,regions=EXCLUDED.regions,
    countries=EXCLUDED.countries,updated_at=now()"""
PASSWORD_SQL = """INSERT INTO system.user_credential(user_id,password_hash,must_change) VALUES($1,$2,$3)
    ON CONFLICT(user_id) DO UPDATE SET password_hash=EXCLUDED.password_hash,must_change=EXCLUDED.must_change,changed_at=now()"""
AUDIT_SQL = "INSERT INTO system.audit_event(actor_id,action,details) VALUES($1,$2,$3::jsonb)"


# ═══ input ═══════════════════════════════════════════════════════════════════════════════════════════════

class AccountFields(BaseModel):
    model_config = ConfigDict(extra="forbid")
    displayName: str | None = Field(None, max_length=4 * NAME_MAX)
    email: str | None = Field(None, max_length=4 * EMAIL_MAX)
    role: str = Field(max_length=20)
    brands: list[str] = Field(default_factory=list, max_length=len(BRANDS))
    regions: list[str] = Field(default_factory=list, max_length=len(RHQ_REGION_COUNTRIES))
    countries: list[str] = Field(default_factory=list, max_length=300)


class AccountCreate(AccountFields):
    login: str = Field(max_length=4 * 200)


class AccountUpdate(AccountFields):
    expectedVersion: str = Field(max_length=64)


class PasswordChange(BaseModel):
    model_config = ConfigDict(extra="forbid")
    current: str = Field(max_length=PASSWORD_MAX)
    new: str = Field(max_length=PASSWORD_MAX)


def invalid(message: str, *fields: str) -> HTTPException:
    return refused(422, "invalid_value", message, {"fields": list(fields)})


def login_of(value: str) -> str:
    login = value.strip()
    if not LOGIN.fullmatch(login):
        raise invalid("A login ID is 3-200 letters, digits and . _ @ -", "login")
    return login


def text_of(value: str | None, field: str, maximum: int) -> str | None:
    text = (value or "").strip()
    if len(text) > maximum or CONTROL.search(text):
        raise invalid(f"{field}: at most {maximum} characters on one line", field)
    return text or None


def email_of(value: str | None) -> str | None:
    email = text_of(value, "email", EMAIL_MAX)
    if email is not None and not EMAIL.fullmatch(email):
        raise invalid("Not an email address", "email")
    return email


def region_brand(region: str) -> str:
    return region.split("-", 1)[0].capitalize()


def scope_of(body: AccountFields) -> tuple[str, list[str], list[str], list[str]]:
    """role, brands, regions, countries as stored: a role keeps the axes it uses (admin none, hq brands, region
    brands and regions, country all three) and needs each of them; regions belong to the chosen brands and
    countries to the chosen regions (the screen's brand > region > country cascade)."""
    role = body.role
    if role not in ROLES:
        raise invalid("Unknown role", "role")
    if role == "admin":
        return role, [], [], []
    names = {b.lower(): b for b in BRANDS}
    brands = list(dict.fromkeys(names.get(b.lower(), b) for b in body.brands))
    if not brands or any(b not in BRANDS for b in brands):
        raise invalid("Choose the account's brands", "brands")
    if role == "hq":
        return role, brands, [], []
    regions = list(dict.fromkeys(body.regions))
    if not regions or any(r not in RHQ_REGION_COUNTRIES or region_brand(r) not in brands for r in regions):
        raise invalid("Choose regions of the account's brands", "regions")
    if role == "region":
        return role, brands, regions, []
    inside = {c for r in regions for c in RHQ_REGION_COUNTRIES[r]}
    countries = list(dict.fromkeys(c.upper() for c in body.countries))
    if not countries or any(c not in inside for c in countries):
        raise invalid("Choose countries of the account's regions", "countries")
    return role, brands, regions, countries


def below(role: str | None, over: str | None) -> bool:
    """Whether an account of role `over` manages an account of `role`, or hands that role out: below it only."""
    return RANK.get(role, 0) < RANK.get(over, 0)


def check_rank(role: str | None, actor: Principal, fields: list[str] | None = None) -> None:
    if not below(role, actor.role):
        raise refused(403, "rank", "Only accounts and roles below your own are managed here", {"fields": fields} if fields else None)


def check_new_password(new: str, current: str | None = None) -> None:
    if not PASSWORD_MIN <= len(new) <= PASSWORD_MAX:
        raise invalid(f"A password has at least {PASSWORD_MIN} characters", "new")
    if current is not None and new == current:
        raise invalid("Choose a password other than the current one", "new")


def temporary_password() -> str:
    return "-".join("".join(secrets.choice(TEMP_ALPHABET) for _ in range(4)) for _ in range(4))


# ═══ view ════════════════════════════════════════════════════════════════════════════════════════════════

def version_of(row) -> str:
    """The fields the edit form changes, as it saw them. A sign-in, a password change or a status change in the
    meantime does not make an edit conflict; another edit of these fields does."""
    parts = [row["subject"], row["display_name"], row["email"], row["role"], row["brands"], row["regions"], row["countries"]]
    return hashlib.sha256(json.dumps(parts, default=str).encode()).hexdigest()[:16]


def view(row, actor: Principal) -> dict:
    return {"id": str(row["user_id"]), "login": row["subject"], "displayName": row["display_name"], "email": row["email"],
            "role": row["role"], "brands": list(row["brands"] or []), "regions": list(row["regions"] or []),
            "countries": list(row["countries"] or []), "status": row["status"], "hasPassword": row["has_password"],
            "mustChangePassword": bool(row["must_change"]), "passwordChangedAt": row["changed_at"],
            "createdAt": row["created_at"], "lastSignInAt": row["last_sign_in_at"], "version": version_of(row),
            "self": row["user_id"] == actor.user_id, "manageable": below(row["role"], actor.role)}


def event_view(row) -> dict:
    details = row["details"] if isinstance(row["details"], dict) else json.loads(row["details"] or "{}")
    return {"id": row["event_id"], "action": row["action"], "at": row["occurred_at"],
            "actor": {"login": row["actor_login"], "displayName": row["actor_name"]} if row["actor_login"] else None,
            "changes": details.get("changes") or {}}


# ═══ connections ═════════════════════════════════════════════════════════════════════════════════════════

_pool = None


async def open_pool():
    global _pool
    dsn = os.environ.get("HGH_ACCOUNT_EDITOR_DB_URL")
    if dsn:
        _pool = await asyncpg.create_pool(
            dsn, min_size=0, max_size=2, timeout=5, command_timeout=20, statement_cache_size=0,
            server_settings={"application_name": "hmg-geo-hub-accounts", "statement_timeout": "15000"},
        )


async def close_pool():
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


@asynccontextmanager
async def writing():
    if _pool is None:
        raise HTTPException(503, "Account editing is not configured (HGH_ACCOUNT_EDITOR_DB_URL)")
    async with _pool.acquire() as conn, conn.transaction():
        await conn.execute(LOCK_SQL, ACCOUNT_LOCK)
        yield conn


@asynccontextmanager
async def reading():
    try:
        async with operations_db.connection() as conn:
            yield conn
    except ConnectionError:
        raise HTTPException(503, "HUB operations store is not configured") from None


async def audit(conn, actor: Principal | None, action: str, user_id: UUID, **details) -> None:
    await conn.execute(AUDIT_SQL, actor.user_id if actor else None, action,
                       json.dumps({"user_id": str(user_id), **details}, ensure_ascii=False, default=str))


async def current(conn, user_id: UUID):
    row = await conn.fetchrow(ONE_SQL, user_id)
    if row is None:
        raise HTTPException(404, "No such account")
    return row


# ═══ reads ═══════════════════════════════════════════════════════════════════════════════════════════════

async def listing(actor: Principal) -> dict:
    async with reading() as conn:
        items = [view(r, actor) for r in await conn.fetch(LIST_SQL)]
    return {"items": items, "roles": [r for r in ROLES if below(r, actor.role)]}


async def detail(user_id: UUID, actor: Principal) -> dict:
    async with reading() as conn:
        row = await current(conn, user_id)
        history = await conn.fetch(HISTORY_SQL, str(user_id), row["subject"])
    return {"item": view(row, actor), "history": [event_view(e) for e in history]}


# ═══ writes ══════════════════════════════════════════════════════════════════════════════════════════════

async def create(body: AccountCreate, actor: Principal) -> dict:
    login = login_of(body.login)
    name, email = text_of(body.displayName, "displayName", NAME_MAX), email_of(body.email)
    role, brands, regions, countries = scope_of(body)
    check_rank(role, actor, ["role"])
    password, user_id = temporary_password(), uuid4()
    digest = await asyncio.to_thread(hash_password, password)   # scrypt: off the event loop
    async with writing() as conn:
        if await conn.fetchval(TAKEN_SQL, login):
            raise refused(409, "login_taken", "The login ID is taken", {"fields": ["login"]})
        await conn.execute(INSERT_ACCOUNT_SQL, user_id, login, name, email)
        await conn.execute(PASSWORD_SQL, user_id, digest, True)
        await conn.execute(ROLE_SQL, user_id, role, brands, regions, countries)
        await audit(conn, actor, "account.create", user_id, login=login,
                    changes={"role": [None, role], "brands": [[], brands], "regions": [[], regions], "countries": [[], countries],
                             **({"displayName": [None, name]} if name else {}), **({"email": [None, email]} if email else {})})
        row = await current(conn, user_id)
    return {"item": view(row, actor), "temporaryPassword": password}


async def update(user_id: UUID, body: AccountUpdate, actor: Principal) -> dict:
    name, email = text_of(body.displayName, "displayName", NAME_MAX), email_of(body.email)
    role, brands, regions, countries = scope_of(body)
    async with writing() as conn:
        row = await current(conn, user_id)
        check_rank(row["role"], actor)
        check_rank(role, actor, ["role"])
        if version_of(row) != body.expectedVersion:
            raise refused(409, "version_conflict", "The account changed since it was opened")
        before = {"displayName": row["display_name"], "email": row["email"], "role": row["role"], "brands": list(row["brands"] or []),
                  "regions": list(row["regions"] or []), "countries": list(row["countries"] or [])}
        after = {"displayName": name, "email": email, "role": role, "brands": brands, "regions": regions, "countries": countries}
        changes = {k: [before[k], after[k]] for k in after if before[k] != after[k]}
        if changes:
            if "displayName" in changes or "email" in changes:
                await conn.execute(UPDATE_ACCOUNT_SQL, user_id, name, email)
            if changes.keys() & {"role", "brands", "regions", "countries"}:
                await conn.execute(ROLE_SQL, user_id, role, brands, regions, countries)
            await audit(conn, actor, "account.update", user_id, changes=changes)
            row = await current(conn, user_id)
    return {"item": view(row, actor)}


async def set_status(user_id: UUID, status: str, actor: Principal) -> dict:
    async with writing() as conn:
        row = await current(conn, user_id)
        check_rank(row["role"], actor)
        if row["status"] != status:
            await conn.execute(STATUS_SQL, user_id, status)
            await audit(conn, actor, "account.enable" if status == "active" else "account.disable", user_id,
                        changes={"status": [row["status"], status]})
            row = await current(conn, user_id)
    return {"item": view(row, actor)}


async def reset_password(user_id: UUID, actor: Principal) -> dict:
    """A new temporary password: the account's sessions end and its next sign-in asks for its own password. Your
    own password changes on the password page (change_password)."""
    password = temporary_password()
    digest = await asyncio.to_thread(hash_password, password)   # scrypt: off the event loop
    async with writing() as conn:
        check_rank((await current(conn, user_id))["role"], actor)
        await conn.execute(PASSWORD_SQL, user_id, digest, True)
        await audit(conn, actor, "account.reset_password", user_id)
        row = await current(conn, user_id)
    return {"item": view(row, actor), "temporaryPassword": password}


async def change_password(authorization: str | None, body: PasswordChange) -> dict:
    """The signed-in account replaces its password (an issued one, or its own). Every session of the account ends;
    this one continues with the new token the answer carries."""
    who = await hub_auth.principal(authorization, password_change=True)
    if not await hub_auth.password_matches(who.user_id, body.current):
        raise refused(422, "wrong_password", "The current password is incorrect", {"fields": ["current"]})
    check_new_password(body.new, body.current)
    digest = await asyncio.to_thread(hash_password, body.new)
    async with writing() as conn:
        await conn.execute(PASSWORD_SQL, who.user_id, digest, False)
        await audit(conn, who, "account.password_change", who.user_id)
    return await hub_auth.reissue(who.user_id)


async def signed_in(user_id: UUID) -> None:
    """Notes the sign-in for the Admin list. Best effort: a sign-in never fails on it."""
    if _pool is None:
        return
    try:
        async with _pool.acquire() as conn:
            await conn.execute(SIGNED_IN_SQL, user_id)
    except (OSError, asyncpg.PostgresError, TimeoutError) as e:
        log.warning("last sign-in not recorded: %s", type(e).__name__)
