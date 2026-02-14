from pathlib import Path

from database import init_db
from models import import_teachers


if __name__ == "__main__":
    init_db()
    result = import_teachers(Path(__file__).resolve().parent / "data")
    print(
        f"imported_teachers={result.teachers} availability_rows={result.availability_rows}"
    )
