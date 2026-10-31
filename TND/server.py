from __future__ import annotations

import asyncio
import secrets
import string
import time
import uuid
import os
from pathlib import Path
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(title="TheNotDivision", version="0.1.1")

# Set FRONTEND_ORIGINS on Render after deploying the Netlify site.
# Example: https://your-tnd-site.netlify.app,https://www.example.com
_raw_origins = os.getenv("FRONTEND_ORIGINS", "*").strip()
ALLOWED_ORIGINS = [origin.strip().rstrip("/") for origin in _raw_origins.split(",") if origin.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS if ALLOWED_ORIGINS != ["*"] else ["*"],
    allow_credentials=False,
    allow_methods=["GET", "OPTIONS"],
    allow_headers=["*"],
)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

# MVP storage: rooms live in memory and are cleared when the server restarts.
rooms: dict[str, dict[str, Any]] = {}
connections: dict[str, WebSocket] = {}
ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def make_code() -> str:
    while True:
        code = "".join(secrets.choice(ALPHABET) for _ in range(6))
        if code not in rooms:
            return code


def projected_time(current: dict[str, Any] | None) -> float:
    if not current:
        return 0.0
    value = float(current.get("time", 0.0))
    if current.get("playing"):
        value += max(0.0, time.time() - float(current.get("updated_at", time.time())))
    return max(0.0, value)


def public_state(room: dict[str, Any]) -> dict[str, Any]:
    proposal = room.get("proposal")
    if proposal and proposal["expires_at"] <= time.time():
        room["proposal"] = None
    current = room.get("current")
    current_copy = None
    if current:
        current_copy = {
            "url": current["url"],
            "title": current["title"],
            "kind": current["kind"],
            "time": projected_time(current),
            "playing": bool(current.get("playing")),
        }

    queue = []
    for item in room["queue"]:
        queue.append({
            "id": item["id"],
            "url": item["url"],
            "title": item["title"],
            "kind": item["kind"],
            "added_by": item["added_by"],
            "votes": len(item["voters"]),
            "voter_ids": list(item["voters"]),
        })
    queue.sort(key=lambda item: (-item["votes"], item["id"]))

    proposal = room.get("proposal")
    proposal_copy = None
    if proposal:
        proposal_copy = {
            "id": proposal["id"],
            "action": proposal["action"],
            "value": proposal.get("value"),
            "proposer": proposal["proposer"],
            "yes": len(proposal["yes"]),
            "no": len(proposal["no"]),
            "yes_ids": list(proposal["yes"]),
            "no_ids": list(proposal["no"]),
            "expires_at": proposal["expires_at"],
        }

    return {
        "code": room["code"],
        "host": room["host"],
        "participants": list(room["participants"].values()),
        "current": current_copy,
        "queue": queue,
        "proposal": proposal_copy,
        "chat": room["chat"][-80:],
    }


async def send_to(client_id: str, payload: dict[str, Any]) -> None:
    websocket = connections.get(client_id)
    if not websocket:
        return
    try:
        await websocket.send_json(payload)
    except Exception:
        pass


async def broadcast(room: dict[str, Any], payload: dict[str, Any] | None = None) -> None:
    state_message = {"type": "state", "state": public_state(room)}
    if payload:
        state_message.update(payload)
    await asyncio.gather(
        *(send_to(client_id, state_message) for client_id in list(room["participants"])),
        return_exceptions=True,
    )


def create_room(code: str) -> dict[str, Any]:
    room = {
        "code": code,
        "host": None,
        "participants": {},
        "current": None,
        "queue": [],
        "proposal": None,
        "chat": [],
    }
    rooms[code] = room
    return room


def majority(room: dict[str, Any]) -> int:
    return len(room["participants"]) // 2 + 1


def clean_text(value: Any, limit: int = 120) -> str:
    if not isinstance(value, str):
        return ""
    return " ".join(value.strip().split())[:limit]


def classify_video(url: str) -> str:
    lower = url.lower()
    if "youtu.be/" in lower or "youtube.com/" in lower:
        return "youtube"
    return "file"


async def play_next(room: dict[str, Any]) -> bool:
    if not room["queue"]:
        room["current"] = None
        room["proposal"] = None
        return False
    # Highest vote count wins; ties go to the earliest suggestion.
    best_index = max(range(len(room["queue"])), key=lambda i: (len(room["queue"][i]["voters"]), -i))
    item = room["queue"].pop(best_index)
    room["current"] = {
        "url": item["url"],
        "title": item["title"],
        "kind": item["kind"],
        "time": 0.0,
        "playing": True,
        "updated_at": time.time(),
    }
    room["proposal"] = None
    return True


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "app": "TheNotDivision"}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    origin = websocket.headers.get("origin", "").rstrip("/")
    if ALLOWED_ORIGINS != ["*"] and origin and origin not in ALLOWED_ORIGINS:
        await websocket.close(code=1008, reason="Origin is not allowed")
        return
    await websocket.accept()
    client_id = str(uuid.uuid4())
    joined_room: dict[str, Any] | None = None
    try:
        first = await websocket.receive_json()
        if first.get("type") != "join":
            await websocket.send_json({"type": "error", "message": "Сначала нужно подключиться к комнате."})
            await websocket.close()
            return

        name = clean_text(first.get("name"), 24) or "Гость"
        requested_code = clean_text(first.get("code"), 12).upper().replace("-", "")
        if requested_code:
            if requested_code not in rooms:
                await websocket.send_json({"type": "error", "message": "Комната не найдена. Проверь код или создай новую."})
                await websocket.close()
                return
            joined_room = rooms[requested_code]
        else:
            code = make_code()
            joined_room = create_room(code)
            joined_room["host"] = client_id

        if len(joined_room["participants"]) >= 12:
            await websocket.send_json({"type": "error", "message": "В комнате уже 12 участников — это лимит MVP."})
            await websocket.close()
            return

        connections[client_id] = websocket
        joined_room["participants"][client_id] = {
            "id": client_id,
            "name": name,
            "voice": False,
        }
        if joined_room["host"] is None:
            joined_room["host"] = client_id

        await websocket.send_json({
            "type": "joined",
            "id": client_id,
            "code": joined_room["code"],
            "state": public_state(joined_room),
        })
        await broadcast(joined_room)

        while True:
            message = await websocket.receive_json()
            msg_type = message.get("type")

            if msg_type == "chat":
                body = clean_text(message.get("text"), 500)
                if body:
                    entry = {
                        "id": str(uuid.uuid4()),
                        "user_id": client_id,
                        "name": joined_room["participants"][client_id]["name"],
                        "text": body,
                        "created_at": time.time(),
                    }
                    joined_room["chat"].append(entry)
                    joined_room["chat"] = joined_room["chat"][-100:]
                    await broadcast(joined_room, {"event": "chat", "message": entry})

            elif msg_type == "reaction":
                emoji = str(message.get("emoji", ""))
                if emoji in {"❤️", "😂", "🔥", "👏", "😮", "🍿", "💀"}:
                    await broadcast(joined_room, {
                        "event": "reaction",
                        "reaction": {
                            "emoji": emoji,
                            "name": joined_room["participants"][client_id]["name"],
                            "user_id": client_id,
                        },
                    })

            elif msg_type == "add_video":
                url = clean_text(message.get("url"), 1000)
                title = clean_text(message.get("title"), 100) or "Видео без названия"
                if not url.startswith(("https://", "http://")):
                    await send_to(client_id, {"type": "notice", "message": "Укажи ссылку, начинающуюся с https:// или http://"})
                    continue
                item = {
                    "id": str(uuid.uuid4()),
                    "url": url,
                    "title": title,
                    "kind": classify_video(url),
                    "added_by": joined_room["participants"][client_id]["name"],
                    "voters": {client_id},
                }
                if joined_room["current"] is None:
                    joined_room["current"] = {
                        "url": item["url"],
                        "title": item["title"],
                        "kind": item["kind"],
                        "time": 0.0,
                        "playing": True,
                        "updated_at": time.time(),
                    }
                    await broadcast(joined_room, {"event": "media_changed"})
                else:
                    if len(joined_room["queue"]) >= 50:
                        await send_to(client_id, {"type": "notice", "message": "Очередь заполнена (50 видео). Сначала посмотрите часть роликов."})
                        continue
                    joined_room["queue"].append(item)
                    await broadcast(joined_room, {"event": "queue_changed"})

            elif msg_type == "vote_video":
                item_id = clean_text(message.get("item_id"), 64)
                for item in joined_room["queue"]:
                    if item["id"] == item_id:
                        if client_id in item["voters"]:
                            item["voters"].remove(client_id)
                        else:
                            item["voters"].add(client_id)
                        break
                await broadcast(joined_room, {"event": "queue_changed"})

            elif msg_type == "propose_control":
                action = message.get("action")
                allowed = {"play", "pause", "seek"}
                if action not in allowed or not joined_room["current"]:
                    continue
                if joined_room["proposal"] and joined_room["proposal"]["expires_at"] > time.time():
                    await send_to(client_id, {"type": "notice", "message": "Сначала завершите текущее голосование."})
                    continue
                value = None
                if action == "seek":
                    try:
                        value = max(0.0, min(float(message.get("value", 0)), 24 * 60 * 60))
                    except (TypeError, ValueError):
                        continue
                joined_room["proposal"] = {
                    "id": str(uuid.uuid4()),
                    "action": action,
                    "value": value,
                    "proposer": client_id,
                    "yes": {client_id},
                    "no": set(),
                    "expires_at": time.time() + 45,
                }
                if len(joined_room["proposal"]["yes"]) >= majority(joined_room):
                    proposal = joined_room["proposal"]
                    current = joined_room["current"]
                    now = time.time()
                    if proposal["action"] == "pause":
                        current["time"] = projected_time(current)
                        current["playing"] = False
                    elif proposal["action"] == "play":
                        current["playing"] = True
                    elif proposal["action"] == "seek":
                        current["time"] = proposal["value"]
                    current["updated_at"] = now
                    joined_room["proposal"] = None
                    await broadcast(joined_room, {"event": "playback_approved"})
                else:
                    await broadcast(joined_room, {"event": "proposal_changed"})

            elif msg_type == "vote_control":
                proposal = joined_room.get("proposal")
                if not proposal or proposal["id"] != message.get("proposal_id"):
                    continue
                if proposal["expires_at"] <= time.time():
                    joined_room["proposal"] = None
                    await broadcast(joined_room, {"event": "proposal_changed"})
                    continue
                vote = message.get("vote")
                if vote not in {"yes", "no"}:
                    continue
                proposal["yes"].discard(client_id)
                proposal["no"].discard(client_id)
                proposal[vote].add(client_id)
                if len(proposal["yes"]) >= majority(joined_room):
                    current = joined_room.get("current")
                    if current:
                        if proposal["action"] == "pause":
                            current["time"] = projected_time(current)
                            current["playing"] = False
                        elif proposal["action"] == "play":
                            current["playing"] = True
                        elif proposal["action"] == "seek":
                            current["time"] = proposal["value"]
                        current["updated_at"] = time.time()
                    joined_room["proposal"] = None
                    await broadcast(joined_room, {"event": "playback_approved"})
                elif len(proposal["no"]) >= majority(joined_room):
                    joined_room["proposal"] = None
                    await broadcast(joined_room, {"event": "proposal_rejected"})
                else:
                    await broadcast(joined_room, {"event": "proposal_changed"})

            elif msg_type == "next_video":
                # Only one client (preferably the room creator) advances the queue.
                if client_id == joined_room["host"]:
                    changed = await play_next(joined_room)
                    if changed:
                        await broadcast(joined_room, {"event": "media_changed"})

            elif msg_type == "voice_status":
                joined_room["participants"][client_id]["voice"] = bool(message.get("enabled"))
                await broadcast(joined_room, {"event": "participants_changed"})

            elif msg_type == "voice_signal":
                target = clean_text(message.get("target"), 64)
                signal = message.get("signal")
                if target in joined_room["participants"] and isinstance(signal, dict):
                    await send_to(target, {
                        "type": "voice_signal",
                        "from": client_id,
                        "signal": signal,
                    })

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        try:
            await websocket.send_json({"type": "error", "message": f"Ошибка соединения: {str(exc)[:160]}"})
        except Exception:
            pass
    finally:
        connections.pop(client_id, None)
        if joined_room and client_id in joined_room["participants"]:
            joined_room["participants"].pop(client_id, None)
            for item in joined_room["queue"]:
                item["voters"].discard(client_id)
            proposal = joined_room.get("proposal")
            if proposal:
                proposal["yes"].discard(client_id)
                proposal["no"].discard(client_id)
            if joined_room["host"] == client_id:
                joined_room["host"] = next(iter(joined_room["participants"]), None)
            if not joined_room["participants"]:
                rooms.pop(joined_room["code"], None)
            else:
                await broadcast(joined_room, {"event": "participants_changed"})
