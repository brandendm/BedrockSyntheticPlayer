"""Jev (TypeSafe AI System One model) client with hard cost controls.

Design rules:
  * No API key, budget exhausted, or any error -> returns None. Callers always have a
    rule-based fallback, so the bot keeps working with zero spend.
  * Hard caps: calls per hour and dollars per day, persisted across restarts.
  * Identical (state, questions) within the cache TTL are answered from cache for free.

Wire format: https://docs.typesafe.ai/api (verified with a live call, jev-1.13.0, Sept 2026).
  request:  {model, state, questions: {id: {type, instructions, criteria}}}
  response: {model, answers: {id: {type, choice|score|noul, confidence?, probabilities?}}, usage}
"""
from __future__ import annotations

import hashlib
import json
import logging
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any, Callable, Optional

log = logging.getLogger("brain.jev")


# ---------- typed questions ----------

@dataclass
class Choice:
    name: str
    prompt: str
    options: list[str] | dict[str, str | None]  # option -> optional description of when it applies

    @property
    def keys(self) -> list[str]:
        return list(self.options)


@dataclass
class Score:
    name: str
    prompt: str
    levels: list[str] = field(default_factory=lambda: ["low", "medium", "high"])  # ordered, 2-10


@dataclass
class Noul:  # yes/no probability
    name: str
    prompt: str


Question = Choice | Score | Noul


@dataclass
class Answer:
    value: Any
    confidence: float


# ---------- budget ----------

@dataclass
class Budget:
    max_calls_per_hour: int = 120
    max_usd_per_day: float = 0.25
    path: Optional[Path] = None
    _day: str = ""
    _usd_today: float = 0.0
    _calls: list[float] = field(default_factory=list)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def __post_init__(self):
        if self.path and self.path.exists():
            try:
                d = json.loads(self.path.read_text())
                self._day, self._usd_today = d.get("day", ""), float(d.get("usd_today", 0))
            except (ValueError, OSError):
                pass

    def _roll(self, now: float):
        today = date.fromtimestamp(now).isoformat()
        if today != self._day:
            self._day, self._usd_today = today, 0.0
        self._calls = [t for t in self._calls if now - t < 3600]

    def allow(self, est_usd: float, now: float | None = None) -> bool:
        now = time.time() if now is None else now
        with self._lock:
            self._roll(now)
            if len(self._calls) >= self.max_calls_per_hour:
                return False
            return self._usd_today + est_usd <= self.max_usd_per_day

    def charge(self, usd: float, now: float | None = None):
        now = time.time() if now is None else now
        with self._lock:
            self._roll(now)
            self._calls.append(now)
            self._usd_today += usd
            if self.path:
                try:
                    self.path.write_text(json.dumps({"day": self._day, "usd_today": round(self._usd_today, 8)}))
                except OSError:
                    pass

    @property
    def usd_today(self) -> float:
        return self._usd_today

    @property
    def calls_last_hour(self) -> int:
        return len(self._calls)


# ---------- client ----------

Transport = Callable[[str, dict, dict, float], dict]


def _http_transport(url: str, headers: dict, payload: dict, timeout: float) -> dict:
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


class JevClient:
    def __init__(
        self,
        api_key: str | None,
        endpoint: str = "https://api.typesafe.ai/v1/systemone",
        model: str = "jev-latest",
        usd_per_mtok_input: float = 0.042,
        budget: Budget | None = None,
        cache_ttl_s: float = 30.0,
        timeout_s: float = 2.0,
        transport: Transport = _http_transport,
    ):
        self.api_key = api_key
        self.endpoint = endpoint
        self.model = model
        self.price = usd_per_mtok_input
        self.budget = budget or Budget()
        self.cache_ttl = cache_ttl_s
        self.timeout = timeout_s
        self.transport = transport
        self._cache: dict[str, tuple[float, dict[str, Answer]]] = {}
        self.stats = {"calls": 0, "cache_hits": 0, "blocked": 0, "errors": 0}

    @property
    def available(self) -> bool:
        return bool(self.api_key)

    @staticmethod
    def estimate_tokens(payload: dict) -> int:
        return max(1, len(json.dumps(payload, separators=(",", ":"))) // 4)

    def decide(self, state: dict, questions: list[Question]) -> dict[str, Answer] | None:
        if not self.available:
            return None
        payload = self._build_payload(state, questions)
        key = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
        now = time.time()
        hit = self._cache.get(key)
        if hit and now - hit[0] < self.cache_ttl:
            self.stats["cache_hits"] += 1
            return hit[1]

        est = self.estimate_tokens(payload) * self.price / 1e6
        if not self.budget.allow(est, now):
            self.stats["blocked"] += 1
            log.info("Jev call skipped: budget cap reached (%.4f USD today)", self.budget.usd_today)
            return None
        try:
            raw = self.transport(
                self.endpoint,
                {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
                payload,
                self.timeout,
            )
            answers = self._parse_response(raw, questions)
        except (urllib.error.URLError, TimeoutError, ValueError, KeyError, OSError) as e:
            self.stats["errors"] += 1
            log.warning("Jev call failed, falling back: %s", e)
            return None
        usd = raw.get("usage", {}).get("input_tokens", self.estimate_tokens(payload)) * self.price / 1e6
        self.budget.charge(usd, now)
        self.stats["calls"] += 1
        self._cache[key] = (now, answers)
        if len(self._cache) > 512:
            self._cache = {k: v for k, v in self._cache.items() if now - v[0] < self.cache_ttl}
        return answers

    # ----- wire format: verify against TypeSafe's API reference -----

    def _build_payload(self, state: dict, questions: list[Question]) -> dict:
        qs = {}
        for q in questions:
            if isinstance(q, Choice):
                crit = q.options if isinstance(q.options, dict) else {o: None for o in q.options}
                qs[q.name] = {"type": "choice", "instructions": q.prompt, "criteria": crit}
            elif isinstance(q, Score):
                qs[q.name] = {"type": "score", "instructions": q.prompt, "criteria": q.levels}
            else:
                qs[q.name] = {"type": "noul", "instructions": q.prompt}
        return {"model": self.model, "state": state, "questions": qs}

    def _parse_response(self, raw: dict, questions: list[Question]) -> dict[str, Answer]:
        out: dict[str, Answer] = {}
        answers = raw["answers"]
        for q in questions:
            a = answers[q.name]
            if isinstance(q, Choice):
                if a["choice"] not in q.keys:
                    raise ValueError(f"{q.name}: {a['choice']!r} not in options")
                out[q.name] = Answer(a["choice"], float(a["confidence"]))
            elif isinstance(q, Score):
                out[q.name] = Answer(float(a["score"]), float(a["confidence"]))
            else:
                p = float(a["noul"])  # probability of yes; confidence = distance from a coin flip
                out[q.name] = Answer(p, max(p, 1 - p))
        return out
