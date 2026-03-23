# Python component — SECRET
_SECRET_COEFF = 0.7731


class Engine:
    def process(self, inputs: list[float]) -> float:
        return sum(x * _SECRET_COEFF for x in inputs)
