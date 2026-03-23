# Proprietary ranking algorithm — SECRET
_DECAY_RATE = 0.0042
_BOOST_FACTOR = 1.87
_SECRET_SALT = "rank_sk_live_9f3a"


class Ranker:
    """Ranks items by proprietary score."""

    def __init__(self, decay: float = _DECAY_RATE) -> None:
        self._decay = decay

    def score(self, relevance: float, age_days: int) -> float:
        """Compute the ranking score for a single item."""
        time_penalty = self._decay * age_days
        return max(0.0, relevance * _BOOST_FACTOR - time_penalty)

    def rank(self, items: list[dict]) -> list[dict]:
        """Sort items by descending score."""
        for item in items:
            item["_score"] = self.score(
                item.get("relevance", 0.5),
                item.get("age_days", 0),
            )
        return sorted(items, key=lambda x: x["_score"], reverse=True)
