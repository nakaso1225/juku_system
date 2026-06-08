from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any
from urllib import error, parse, request


DEFAULT_BASE_URL = "https://api.comiru.com"


class ComiruApiError(Exception):
    pass


class ComiruClient:
    def __init__(self, *, base_url: str, school_id: str, token: str) -> None:
        if not school_id:
            raise ValueError("school_id is required")
        if not token:
            raise ValueError("token is required")
        self.base_url = base_url.rstrip("/")
        self.school_id = school_id
        self.token = token

    def _build_url(self, endpoint: str, query: dict[str, Any] | None = None) -> str:
        endpoint = endpoint.lstrip("/")
        url = f"{self.base_url}/{endpoint}"
        if query:
            filtered = {k: v for k, v in query.items() if v is not None}
            if filtered:
                url = f"{url}?{parse.urlencode(filtered)}"
        return url

    def request(
        self,
        method: str,
        endpoint: str,
        *,
        query: dict[str, Any] | None = None,
        payload: dict[str, Any] | None = None,
    ) -> tuple[Any, int]:
        url = self._build_url(endpoint, query)
        body = None
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/json",
        }
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"

        req = request.Request(url, data=body, method=method.upper(), headers=headers)
        try:
            with request.urlopen(req) as res:
                status = res.getcode()
                text = res.read().decode("utf-8")
        except error.HTTPError as exc:
            status = exc.code
            text = exc.read().decode("utf-8", errors="replace")
            raise ComiruApiError(f"HTTP {status}: {text}") from exc
        except error.URLError as exc:
            raise ComiruApiError(f"Connection error: {exc.reason}") from exc

        try:
            data = json.loads(text) if text else None
        except json.JSONDecodeError:
            data = {"raw": text}
        return data, status

    def get(self, endpoint: str, *, query: dict[str, Any] | None = None) -> tuple[Any, int]:
        return self.request("GET", endpoint, query=query)

    def post(self, endpoint: str, *, payload: dict[str, Any]) -> tuple[Any, int]:
        return self.request("POST", endpoint, payload=payload)

    def delete(self, endpoint: str) -> tuple[Any, int]:
        return self.request("DELETE", endpoint)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Minimal Comiru API smoke test client."
    )
    parser.add_argument(
        "--base-url",
        default=os.environ.get("COMIRU_API_BASE_URL", DEFAULT_BASE_URL),
        help=f"Comiru API base URL (default: {DEFAULT_BASE_URL})",
    )
    parser.add_argument(
        "--school-id",
        default=os.environ.get("COMIRU_SCHOOL_ID", ""),
        help="Comiru school id. Can also come from COMIRU_SCHOOL_ID.",
    )
    parser.add_argument(
        "--token",
        default=os.environ.get("COMIRU_TOKEN", ""),
        help="Comiru bearer token. Can also come from COMIRU_TOKEN.",
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("get-comas", help="List coma master data")
    subparsers.add_parser("get-teachers", help="List teachers")
    subparsers.add_parser("get-students", help="List students")

    seats_parser = subparsers.add_parser("get-seats", help="List seats")
    seats_parser.add_argument("--teacher-id", type=int)
    seats_parser.add_argument("--student-id", type=int)
    seats_parser.add_argument("--start-date", required=True, help="YYYY-MM-DD")
    seats_parser.add_argument("--end-date", required=True, help="YYYY-MM-DD")
    seats_parser.add_argument("--page", type=int, default=1)
    seats_parser.add_argument("--type", dest="seat_type", type=int, default=0)

    create_parser = subparsers.add_parser(
        "create-seat", help="Create a seat from a JSON payload file"
    )
    create_parser.add_argument(
        "--payload-file",
        required=True,
        help="Path to JSON file for POST /{school_id}/seats",
    )

    delete_parser = subparsers.add_parser("delete-seat", help="Delete a seat by id")
    delete_parser.add_argument("--seat-id", required=True)

    return parser


def load_json_file(path_str: str) -> dict[str, Any]:
    path = Path(path_str)
    if not path.exists():
        raise FileNotFoundError(f"payload file not found: {path}")
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise ValueError("payload JSON must be an object")
    return data


def print_json(data: Any) -> None:
    print(json.dumps(data, ensure_ascii=False, indent=2))


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    try:
        client = ComiruClient(
            base_url=args.base_url,
            school_id=args.school_id,
            token=args.token,
        )

        if args.command == "get-comas":
            data, status = client.get(f"/{client.school_id}/comas", query={"type": 0})
        elif args.command == "get-teachers":
            data, status = client.get(f"/{client.school_id}/teachers")
        elif args.command == "get-students":
            data, status = client.get(f"/{client.school_id}/students")
        elif args.command == "get-seats":
            data, status = client.get(
                f"/{client.school_id}/seats",
                query={
                    "teacher_id": args.teacher_id,
                    "student_id": args.student_id,
                    "type": args.seat_type,
                    "start_date": args.start_date,
                    "end_date": args.end_date,
                    "page": args.page,
                },
            )
        elif args.command == "create-seat":
            payload = load_json_file(args.payload_file)
            data, status = client.post(f"/{client.school_id}/seats", payload=payload)
        elif args.command == "delete-seat":
            data, status = client.delete(f"/{client.school_id}/seats/{args.seat_id}")
        else:
            parser.error(f"unsupported command: {args.command}")
            return 2

        print(f"HTTP {status}")
        print_json(data)
        return 0
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
