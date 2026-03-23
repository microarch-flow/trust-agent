# Public utilities — no secrets here

from datetime import date
import re


def format_date(d: date) -> str:
    """Return ISO-8601 date string."""
    return d.isoformat()


def slugify(text: str) -> str:
    """Convert text to URL-friendly slug."""
    text = text.lower().strip()
    text = re.sub(r"[^\w\s-]", "", text)
    text = re.sub(r"\s+", "-", text)
    return text


def clamp(value: float, lo: float, hi: float) -> float:
    """Clamp value to [lo, hi]."""
    return max(lo, min(hi, value))


def chunk_list(lst: list, size: int) -> list:
    """Split a list into chunks of given size."""
    return [lst[i : i + size] for i in range(0, len(lst), size)]


def truncate(text: str, max_len: int = 80, suffix: str = "...") -> str:
    """Truncate text to max_len characters."""
    if len(text) <= max_len:
        return text
    return text[: max_len - len(suffix)] + suffix
