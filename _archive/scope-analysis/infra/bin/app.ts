#!/usr/bin/env node
// scope-analysis CDK 앱. 스테이지별 스택 1개: ScopeAnalysis-<stage>.
//
//   pnpm cdk:synth                      # 자격증명 불필요 (VPC 는 fromVpcAttributes)
//   AWS_PROFILE=scope npx cdk diff      # 실배포 전 대조
//
// ⚠️ `cdk deploy` 는 **반드시 `--exclusively`** 로 한다 — 워크스페이스 흉터(ScopeData DbSecret
//    재생성 사고). 배포 자체는 이 커밋의 작업 경계 밖이다(G3-1 은 synth 까지).
import { App, Tags, type Environment } from "aws-cdk-lib";

import { AnalysisStack } from "../lib/analysis-stack.ts";

const app = new App();
const stage = (app.node.tryGetContext("stage") as string | undefined) ?? "stage";
const env: Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? "us-west-2",
};

new AnalysisStack(app, `ScopeAnalysis-${stage}`, {
  stage,
  env,
  description: `scope-analysis ${stage}: Fargate analysis-api(1) + analysis-worker(0..16) + lane RDS + ECR + NLB(mTLS ingress)`,
});

Tags.of(app).add("app", "scope-analysis");
Tags.of(app).add("stage", stage);
app.synth();
