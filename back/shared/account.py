"""The signed-in account as both servers see it. The hub server reads it from the operations DB; the data server receives it in the internal token."""
from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID


@dataclass(frozen=True)
class Principal:
    user_id: UUID
    login: str
    email: str | None
    display_name: str | None
    role: str
    brands: tuple[str, ...] = ()
    regions: tuple[str, ...] = ()
    countries: tuple[str, ...] = ()
    must_change: bool = False

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"

    def scope(self) -> dict:
        """front AllowedScope: the administrator every scope, the others their brands, regions and countries."""
        if self.is_admin:
            return {"all": True}
        return {"all": False, "brands": list(self.brands), "regions": list(self.regions), "countries": list(self.countries)}

    def view(self) -> dict:
        return {"id": str(self.user_id), "login": self.login, "email": self.email, "displayName": self.display_name,
                "role": self.role, "scope": self.scope(), "mustChangePassword": self.must_change}
