"""pytest 설정: timetable_server/ 와 tests/ 를 import 경로에 넣는다 (Colab 서버 코드는 고치지 않고 그대로 시험)."""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
for folder in (ROOT / "timetable_server", ROOT / "tests"):
    if str(folder) not in sys.path:
        sys.path.insert(0, str(folder))
