#!/bin/sh
# mTLS 인그레스 기동 — 인증서를 **기동 시점에** Secrets Manager 에서 받아 파일로 쓴 뒤 nginx 실행.
#
# ── 왜 이미지에 인증서를 굽지 않는가
#
#   ECR 이미지는 리포지토리 읽기 권한만 있으면 누구나 레이어를 꺼낼 수 있다. 서버 **비밀키**를
#   레이어에 넣으면 로테이션이 "이미지 재빌드 + 배포"가 되고, 과거 태그 전부가 유효한 키를 들고
#   영구 보관된다. 그래서 이미지는 **설정(nginx.conf)만** 갖고, 자격증명은 태스크 롤이 런타임에
#   받는다(워크스페이스 룰 secrets-handling 1·5 — 값은 리포·툴출력·세션에 들어가지 않는다).
#
# ── 왜 태스크 롤인가 (ECS `secrets:` 주입이 아니라)
#
#   ECS `secrets:` 는 값을 **컨테이너 환경변수**로 넣는다. 서버 비밀키가 `/proc/1/environ` 과
#   자식 프로세스 전체의 env 에 상주하게 되는데, 이 컨테이너의 자식은 nginx 워커들이다.
#
#   ⚠️ 정확히 말하면 태스크 롤 + 0600 파일이 좁히는 것은 **"nginx 하나"가 아니다.** 이 컨테이너의
#      PID 1 은 root 이고 nginx 마스터도 root 라, 컨테이너 안에서 root 로 도는 무엇이든 키 파일을
#      읽을 수 있다(0600 은 nginx **워커**(비특권 user)와 exec 후의 비root 프로세스를 막는다).
#      이 방식이 실제로 지우는 것은 **노출면 두 개**다: ① 키가 `/proc/*/environ` 과 env 를 상속한
#      모든 자식에 상주하지 않는다 ② 키가 ECR 레이어에 영구 보관되지 않는다(로테이션이 재빌드가
#      아니라 시크릿 갱신 + 태스크 교체다). 컨테이너 안 root 를 막는 층은 이 파일이 아니다.
#
# ── 실패 방향
#
#   **기동을 중단한다.** 인증서 없이 올라오면 nginx 가 8443 을 못 열고 NLB 타깃이 영구
#   unhealthy 가 되는데, 그 실패는 "설정 실패"가 아니라 "네트워크 문제"처럼 보인다 —
#   30분을 태운다. 여기서 죽으면 ECS 이벤트와 이 컨테이너 로그에 이유가 한 줄로 남는다.
#
# ⚠️ 값은 **어떤 경로로도 출력하지 않는다.** set -x 를 켜지 말 것. jq·printf 는 ash 빌트인이거나
#    stdin 으로 받으므로 비밀값이 argv 에 오르지 않는다(룰 secrets-handling 6 — `ps` 는
#    출력 마스킹을 지나간다).
set -eu

CERT_DIR="${ANALYSIS_INGRESS_CERT_DIR:-/etc/nginx/certs}"
SECRET_ID="${ANALYSIS_INGRESS_CERT_SECRET_ID:-}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"

log() { echo "ingress: $*" >&2; }
die() { log "FATAL $*"; exit 1; }

mkdir -p "$CERT_DIR"

if [ -n "$SECRET_ID" ]; then
  # ── 라이브 경로: 태스크 롤로 시크릿 1개를 읽는다 ─────────────────────────────────
  #
  # ECS 는 태스크에 AWS_REGION 을 자동으로 넣어주지 않는다(Lambda 와 다르다) — CDK 가
  # 컨테이너 env 로 준다. 없으면 aws cli 가 "You must specify a region" 으로 죽는데,
  # 그 메시지만 보면 권한 문제로 오진하기 쉬우므로 먼저 단언한다.
  [ -n "$REGION" ] || die "AWS_REGION 이 비어 있다 (태스크 정의가 주지 않았다). 시크릿을 읽을 수 없다."

  log "fetching ingress certs from Secrets Manager (id=$SECRET_ID region=$REGION)"
  # --secret-id 는 비밀이 아니다(리소스 식별자). 자격증명은 컨테이너 자격증명 엔드포인트에서
  # 오므로 argv 에 오르지 않는다.
  #
  # ⚠️ **stderr 를 stdout 에 합치지 않는다.** `2>&1` 로 한 변수에 받으면 실패 경로에서 그
  #    변수를 로그로 내게 되고, 그 변수는 성공 경로에서 **비밀키를 담는 변수**다. 한 변수가
  #    두 역할을 하는 순간 "에러만 찍는다"는 보장이 사라진다(tests/ingress.test.ts 가 이 형태를
  #    금지한다 — 이 주석은 그 테스트가 실제로 잡아낸 결과다).
  ERR_FILE=$(mktemp)
  if ! SECRET_JSON=$(aws secretsmanager get-secret-value \
        --secret-id "$SECRET_ID" --query SecretString --output text 2>"$ERR_FILE"); then
    AWS_ERR=$(head -c 200 "$ERR_FILE")
    rm -f "$ERR_FILE"
    die "GetSecretValue 실패: $AWS_ERR"
  fi
  rm -f "$ERR_FILE"
  [ -n "$SECRET_JSON" ] && [ "$SECRET_JSON" != "None" ] || die "시크릿이 비어 있다: $SECRET_ID"

  # 필드 계약 — README '시크릿 주입 절차' 와 같은 이름을 쓴다. 하나라도 없으면 기동 중단.
  #   server_cert_pem · server_key_pem · client_ca_pem
  extract() {
    # jq 는 stdin 으로 받는다(값이 argv 에 오르지 않게). 필드가 없으면 빈 문자열.
    echo "$SECRET_JSON" | jq -er --arg k "$1" '.[$k] // empty' 2>/dev/null || true
  }
  SERVER_CERT=$(extract server_cert_pem)
  SERVER_KEY=$(extract server_key_pem)
  CLIENT_CA=$(extract client_ca_pem)
  unset SECRET_JSON

  # PEM 모양만 본다(내용은 nginx -t 가 판정한다). 필드명만 로그에 남는다.
  # ⚠️ 값을 `for` 루프에 태우지 않는다 — PEM 은 여러 줄이고 IFS 가 줄바꿈에서 쪼갠다.
  #    셋을 각각 검사하는 편이 길지만 정확하다.
  assert_pem() {
    # $1 = 필드명, $2 = 값. **값을 출력하는 분기는 없다.**
    [ -n "$2" ] || die "시크릿에 $1 이 없거나 비어 있다 (필드 계약: server_cert_pem·server_key_pem·client_ca_pem)"
    case "$2" in
      "-----BEGIN"*) ;;
      *) die "$1 이 PEM 으로 시작하지 않는다 (값은 출력하지 않는다 — README '시크릿 주입 절차' 를 확인할 것)" ;;
    esac
  }
  assert_pem server_cert_pem "$SERVER_CERT"
  assert_pem server_key_pem "$SERVER_KEY"
  assert_pem client_ca_pem "$CLIENT_CA"

  # 키는 0600. umask 를 먼저 좁혀 **생성 순간부터** 좁게 만든다 — 만들고 chmod 하면
  # 그 사이의 창에서 다른 프로세스가 읽을 수 있다.
  umask 077
  printf '%s\n' "$SERVER_KEY" > "$CERT_DIR/server.key"
  printf '%s\n' "$SERVER_CERT" > "$CERT_DIR/server.crt"
  printf '%s\n' "$CLIENT_CA" > "$CERT_DIR/ca.crt"
  unset SERVER_CERT SERVER_KEY CLIENT_CA
  chmod 644 "$CERT_DIR/server.crt" "$CERT_DIR/ca.crt"
  log "wrote server.crt · server.key(0600) · ca.crt to $CERT_DIR"
else
  # ── 로컬 경로: compose 가 ./certs 를 마운트한다(make-dev-certs.sh) ────────────────
  # **조용한 폴백이 아니다** — 파일이 없으면 아래 단언이 죽인다. 시크릿 ID 를 주지 않은 것
  # 자체가 "파일은 내가 배치했다"는 선언이다.
  log "ANALYSIS_INGRESS_CERT_SECRET_ID 미설정 — 이미 배치된 인증서를 쓴다(로컬 compose 경로)"
fi

for f in server.crt server.key ca.crt; do
  [ -s "$CERT_DIR/$f" ] || die "$CERT_DIR/$f 가 없거나 비어 있다"
done

# 설정·인증서 정합을 **exec 전에** 판정한다. nginx 가 기동 후 죽으면 ECS 는 그것을 태스크
# 크래시로만 보고하고 이유는 로그를 파야 나온다.
nginx -t

exec nginx -g 'daemon off;'
