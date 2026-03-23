# Public utilities

from datetime import date
import re


def slugify(text: str) -> str:
    text = text.lower().strip()
    text = re.sub(r"[^\w\s-]", "", text)
    return re.sub(r"\s+", "-", text)


def clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def format_date(d: date) -> str:
    return d.isoformat()
