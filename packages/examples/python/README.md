# trust-agent example: Python

Demonstrates Trust Agent on a Python project.

## Run

```bash
cd packages/examples/python
trust-agent run "Add a normalize() method to the Ranker that maps scores to [0, 1]"
```

## Structure

```
src/
  core/ranker.py     ← SECRET (projection only)
  utils/helpers.py   ← PUBLIC (raw content)
```
