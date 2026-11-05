"""Write the prompt and reference API's OpenAPI document where the other teams read it: `cd back && python -m ext.export_openapi`.
The running API serves the same document at GET /ext/openapi.json; ext/tests/test_app.py fails when the file falls behind the code."""
import json
from pathlib import Path

from ext.app import app

TARGET = Path(__file__).resolve().parents[2] / "docs" / "ssot-staging" / "service" / "openapi.json"


def rendered() -> str:
    return json.dumps(app.openapi(), ensure_ascii=False, indent=2, sort_keys=True) + "\n"


if __name__ == "__main__":
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_text(rendered(), encoding="utf8")
    print(TARGET)
