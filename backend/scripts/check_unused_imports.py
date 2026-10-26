"""Report Python imports that have no name reference in their module.

This small stdlib-only check covers the backend's F401-style cleanup rule. It
intentionally skips package __init__.py files, where imports commonly define
the public re-export surface. String-based dynamic references are outside the
check's scope and should be documented next to their imports if introduced.
"""

import ast
import sys
from pathlib import Path


BACKEND_ROOT = Path(__file__).resolve().parents[1]
SKIPPED_DIRECTORIES = {".venv", "venv", "__pycache__"}


def unused_imports(path: Path) -> list[tuple[int, str]]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    referenced = {
        node.id
        for node in ast.walk(tree)
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load)
    }
    unused: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            aliases = ((alias, alias.asname or alias.name.split(".")[0]) for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module != "__future__":
            aliases = ((alias, alias.asname or alias.name) for alias in node.names)
        else:
            continue
        for alias, bound_name in aliases:
            if alias.name != "*" and bound_name not in referenced:
                unused.append((node.lineno, bound_name))
    return unused


def main() -> int:
    failures = 0
    for path in sorted(BACKEND_ROOT.rglob("*.py")):
        if path.name == "__init__.py" or any(part in SKIPPED_DIRECTORIES for part in path.parts):
            continue
        for line, name in unused_imports(path):
            print(f"{path.relative_to(BACKEND_ROOT)}:{line}: unused import '{name}'")
            failures += 1
    if failures:
        return 1
    print("No unused imports found in backend Python modules.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
