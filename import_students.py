from pathlib import Path

from database import init_db
from models import import_students


if __name__ == "__main__":
    init_db()
    result = import_students(Path(__file__).resolve().parent / "data")
    print(
        f"imported_students={result.students} availability_rows={result.availability_rows}"
    )
