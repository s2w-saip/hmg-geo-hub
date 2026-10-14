#!/bin/bash
# EC2 에서 실행(QA 검수 기록 이관 입력 적재): S3 snap/qa/ → mig_src.qa_* 스테이지 6표. 원장·보고 표(qa_carry_*)는 건드리지 않는다.
# 입력 = export.py --qa 산출(snap/qa/<표>/00000.csv.gz + snap/qa/_qa_manifest.json)을 s3://$B/snap/qa/ 에, mig_src_qa.sql 을 s3://$B/ddl/ 에 둔다.
# 한 트랜잭션: mig_src_qa.sql(멱등) → TRUNCATE 6표 → \copy 6개(FROM PROGRAM gzip -dc) → 표별 행 수 = 매니페스트 단언 → COMMIT. 다르면 전부 롤백.
# done 마커 없음: 실행할 때마다 스테이지를 통째로 바꾼다(리허설 반복). s9-load 와 같은 비밀 처리(비밀번호는 셸 변수로만).
# snap/qa 는 s9-load 의 snap/*/*.csv.gz 글롭 밖이라(한 단계 더 깊다) s9 재실행이 QA 스냅샷을 섞지 않는다.
# 진행은 /opt/hmg/qa/load.log, 끝나면 QA_LOAD_COMPLETE 또는 QA_LOAD_FAILED. 다음 단계 = migrate-qa.sql 드라이런.
set -uo pipefail
B=__BUCKET__; SECRET_ARN='__SECRET_ARN__'; EP=__ENDPOINT__
W=/opt/hmg/qa; mkdir -p "$W"; cd "$W"
exec >> "$W/load.log" 2>&1
echo "== start $(date -u +%FT%TZ)"
_SEC=$(aws secretsmanager get-secret-value --secret-id "$SECRET_ARN" --region ap-northeast-2 --query SecretString --output text)
export PGPASSWORD="$(printf '%s' "$_SEC" | jq -r .password)"; unset _SEC
export PGHOST="$EP" PGUSER=hmgadmin PGSSLMODE=require PGCONNECT_TIMEOUT=10
# core 9 D-5: 백엔드 배포(DB_TLS=verify-full)가 둔 RDS CA 번들이 있으면 libpq 도 verify-full(체인 + 호스트 이름). 없으면 현행 require
if [ -s /opt/hmg-geo-hub/certs/rds-ca-bundle.pem ]; then export PGSSLMODE=verify-full PGSSLROOTCERT=/opt/hmg-geo-hub/certs/rds-ca-bundle.pem; fi

aws s3 cp "s3://$B/ddl/mig_src_qa.sql" "$W/mig_src_qa.sql" --quiet --region ap-northeast-2 || { echo QA_LOAD_FAILED ddl_fetch; exit 1; }
rm -rf "$W/snap"; mkdir -p "$W/snap"
aws s3 sync "s3://$B/snap/qa/" "$W/snap/qa/" --quiet --region ap-northeast-2 || { echo QA_LOAD_FAILED snap_fetch; exit 1; }
M="$W/snap/qa/_qa_manifest.json"
[ -s "$M" ] || { echo QA_LOAD_FAILED manifest_missing; exit 1; }
jq -r '"manifest snapshot_at=\(.snapshot_at) rows=\(.rows)"' "$M"

T="qa_answer_reviews qa_review_notes qa_ref_job qa_ref_citation qa_ref_mention qa_ref_acr"
{
  echo "\\set ON_ERROR_STOP on"
  echo "BEGIN;"
  echo "SET LOCAL client_min_messages = warning;"
  echo "\\i $W/mig_src_qa.sql"
  echo "TRUNCATE mig_src.qa_answer_reviews, mig_src.qa_review_notes, mig_src.qa_ref_job, mig_src.qa_ref_citation, mig_src.qa_ref_mention, mig_src.qa_ref_acr;"
  for t in $T; do
    f="$W/snap/qa/$t/00000.csv.gz"
    [ -s "$f" ] || { echo "QA_LOAD_FAILED file_missing $t" >&2; exit 1; }
    # 추출기(export.py --qa)가 매니페스트에 적은 sha256 과 같은 파일만(부분 동기화·다른 회차 파일 섞임 방지)
    got=$(sha256sum "$f" | cut -d' ' -f1); want=$(jq -r --arg t "$t" '.sha256[$t]' "$M")
    [ "$got" = "$want" ] || { echo "QA_LOAD_FAILED sha256 $t" >&2; exit 1; }
    echo "\\copy mig_src.$t FROM PROGRAM 'gzip -dc $f' WITH (FORMAT csv)"
  done
  echo "DO \$a\$ DECLARE n bigint; BEGIN"
  for t in $T; do
    want=$(jq -r --arg t "$t" '.rows[$t]' "$M")
    [[ "$want" =~ ^[0-9]+$ ]] || { echo "QA_LOAD_FAILED manifest_rows $t=$want" >&2; exit 1; }
    echo "  SELECT count(*) INTO n FROM mig_src.$t; IF n <> $want THEN RAISE EXCEPTION '$t 적재 % <> 매니페스트 $want', n; END IF;"
  done
  echo "END \$a\$;"
  echo "COMMIT;"
} > "$W/load.sql" || { echo QA_LOAD_FAILED script; exit 1; }

psql -d hmg -X -q -v ON_ERROR_STOP=1 -f "$W/load.sql" || { echo QA_LOAD_FAILED copy; exit 1; }
psql -d hmg -X -q -c "ANALYZE mig_src.qa_answer_reviews, mig_src.qa_review_notes, mig_src.qa_ref_job, mig_src.qa_ref_citation, mig_src.qa_ref_mention, mig_src.qa_ref_acr"
psql -d hmg -XAt -F ' ' -c "SELECT 'qa_answer_reviews', count(*) FROM mig_src.qa_answer_reviews UNION ALL SELECT 'qa_review_notes', count(*) FROM mig_src.qa_review_notes UNION ALL SELECT 'qa_ref_job', count(*) FROM mig_src.qa_ref_job UNION ALL SELECT 'qa_ref_citation', count(*) FROM mig_src.qa_ref_citation UNION ALL SELECT 'qa_ref_mention', count(*) FROM mig_src.qa_ref_mention UNION ALL SELECT 'qa_ref_acr', count(*) FROM mig_src.qa_ref_acr"
unset PGPASSWORD
echo "QA_LOAD_COMPLETE $(date -u +%FT%TZ)"
