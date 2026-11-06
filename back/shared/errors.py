"""The services' refusals: an HTTP error with a code in the error envelope, and a request body read as a model."""
from __future__ import annotations

from fastapi import HTTPException
from pydantic import BaseModel, ValidationError


def refused(status: int, code: str, message: str, details: dict | None = None) -> HTTPException:
    return HTTPException(status, {"code": code, "message": message, **({"details": details} if details else {})})


def parse(model: type[BaseModel], body, what: str = "prompt") -> BaseModel:
    """A request body as `model`, or 422 in the error envelope (not FastAPI's default validation shape)."""
    try:
        return model.model_validate(body)
    except ValidationError as e:
        fields = sorted({".".join(str(p) for p in err["loc"]) for err in e.errors()})
        raise refused(422, "invalid_value", f"Invalid {what} fields", {"fields": fields}) from None
