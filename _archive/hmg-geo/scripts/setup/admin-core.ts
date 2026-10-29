import { SetupError } from "./config";

export type AuthAccount = { id: string; email: string };
export type AdminProfile = {
  id: string;
  email: string | null;
  role: string;
  scopeAll: boolean;
  operator: string;
  menuGroups: string[] | null;
};
export interface AdminAdapter {
  findAuthByEmail(email: string): Promise<AuthAccount | null>;
  findProfile(id: string): Promise<AdminProfile | null>;
  findProfilesByEmail(email: string): Promise<AdminProfile[]>;
  createAuth(email: string, password: string): Promise<AuthAccount>;
  authExistsInDatabase(id: string): Promise<boolean>;
  deleteCreatedAuth(id: string): Promise<void>;
  insertAdmin(id: string, email: string): Promise<void>;
  promoteAdmin(id: string, email: string): Promise<void>;
}
export type ProvisionResult = { status: "would-create" | "would-promote" | "created" | "promoted" | "unchanged"; email: string; id?: string };

export async function provisionAdmin(
  adapter: AdminAdapter,
  input: { email: string; password: string; write: boolean; promoteExisting: boolean },
): Promise<ProvisionResult> {
  const email = input.email.toLowerCase();
  const account = await adapter.findAuthByEmail(email);
  const matchingProfiles = await adapter.findProfilesByEmail(email);
  if (matchingProfiles.some((profile) => profile.id !== account?.id)) {
    throw new SetupError("동일 이메일의 profiles 행이 Auth 계정과 일치하지 않습니다. 기존 행은 변경하지 않았습니다. DB/Auth 프로젝트와 기존 계정을 점검하세요.");
  }
  if (account) {
    if (!await adapter.authExistsInDatabase(account.id)) {
      throw new SetupError("Auth 계정이 연결된 DB의 auth.users에 없습니다. DB/Auth 프로젝트가 다릅니다. 기존 계정과 프로필은 변경하지 않았습니다.");
    }
    const profile = await adapter.findProfile(account.id);
    if (profile?.email?.toLowerCase() === email && profile.role === "admin" && profile.scopeAll && profile.operator === "global" && !profile.menuGroups?.length) {
      return { status: "unchanged", email, id: account.id };
    }
    if (!input.promoteExisting) {
      throw new SetupError("Auth 계정이 이미 존재하며 초기 관리자 상태가 아닙니다. 기존 비밀번호·권한은 변경하지 않았습니다. 계정 소유권을 확인한 뒤 --promote-existing --yes로 명시적으로 승격하세요.");
    }
    if (input.write) await adapter.promoteAdmin(account.id, email);
    return { status: input.write ? "promoted" : "would-promote", email, id: account.id };
  }
  if (!input.write) return { status: "would-create", email };
  const created = await adapter.createAuth(email, input.password);
  let sameDatabase: boolean;
  try {
    sameDatabase = await adapter.authExistsInDatabase(created.id);
  } catch {
    throw new SetupError(`Auth 생성 후 DB 동일성 조회 실패 (email=${email}, id=${created.id}). 불일치가 확인되지 않아 계정은 삭제하지 않았고 프로필도 쓰지 않았습니다. DB 연결을 복구한 뒤 --promote-existing --yes로 재시도하세요.`);
  }
  if (!sameDatabase) {
    try {
      await adapter.deleteCreatedAuth(created.id);
    } catch {
      throw new SetupError(`DB/Auth 프로젝트 불일치, 방금 만든 Auth 계정 정리 실패 (email=${email}, id=${created.id}). 프로필은 쓰지 않았습니다. Supabase에서 해당 새 계정을 확인하세요.`);
    }
    throw new SetupError("DB/Auth 프로젝트가 달라 방금 만든 Auth 계정만 정리했습니다. 프로필은 쓰지 않았습니다. 같은 Supabase 프로젝트의 연결정보를 사용하세요.");
  }
  try {
    await adapter.insertAdmin(created.id, email);
  } catch {
    // Auth and Postgres cannot share a transaction. Keep the account so retry is
    // reviewable; deleting it could remove an account another request has adopted.
    throw new SetupError(`Auth 생성 후 profiles 저장 실패 (email=${email}, id=${created.id}). 계정은 삭제하지 않았습니다. DB 스키마/권한을 수정한 후 --promote-existing --yes로 재시도하세요. 비밀번호는 변경되지 않습니다.`);
  }
  return { status: "created", email, id: created.id };
}
