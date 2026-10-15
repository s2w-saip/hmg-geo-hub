import { readFileSync, type PathOrFileDescriptor } from "node:fs";

// 소스·SQL·픽스처를 **텍스트로 읽어 단언하는** 테스트의 공용 읽기. 줄바꿈을 LF 로 맞춘다.
//
// 왜 필요한가: 그런 테스트는 `\n` 을 전제로 맞춘다(여러 줄 조각 `toContain`, `^…$` 줄 단위
// 정규식, `split("\n")`, 위치 비교). 리포에 저장된 줄바꿈이 LF 이고 CI 체크아웃도 LF 라서다.
// 그런데 Windows 체크아웃은 `core.autocrlf=true` 이고 `eol=lf` 속성이 없으면 작업본이 CRLF 가
// 되고, 코드가 같아도 그 단언이 깨진다(반대로 `not.toMatch` 는 아무것도 못 보고 통과할 수 있다).
// 읽는 순간 `\r\n` → `\n` 으로 되돌리면 테스트는 git 이 저장한 텍스트를 본다. LF 체크아웃에서는
// 아무것도 바꾸지 않는다(바이트 동일).
//
// 바꾸는 것은 `\r\n` 한 가지뿐이다. 홀로 선 `\r` 은 그대로 둔다(내용일 수 있다).
export function readSourceText(file: PathOrFileDescriptor): string {
  return readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}
