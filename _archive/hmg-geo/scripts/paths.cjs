// 리포트 파이프라인 경로 정본 (노드 쪽 로더) — 값은 scripts/paths.json 이 정본.
const path = require("path");
const P = require("./paths.json");
const REPO = path.dirname(__dirname);
const abs = (k) => path.join(REPO, P[k]);
module.exports = {
  REPO,
  rel: (k) => P[k],
  abs,
  MANIFEST: abs("manifest"),
  PUBLISH: abs("publish"),
  DATA: abs("data"),
};
