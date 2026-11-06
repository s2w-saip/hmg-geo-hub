// Type-only snapshot; no database or server implementation is included.
export type Role = "hq" | "region" | "country" | "admin" | "vendor" | "website" | "local_reader";
export interface AllowedScope {
    all: boolean;
    brands?: string[];
    regions?: string[];
    countries?: string[];
}
export type OperatorScope = "none" | "assigned" | "global";
export type MenuGroup = "standard" | "website" | "project" | "admin";
export interface User {
    id: string;
    email: string;
    role: Role;
    scope: AllowedScope;
    operator: OperatorScope;
    menuGroups: MenuGroup[] | null;
    mustChangePassword?: boolean;
}
export interface Session {
    user: User;
}
