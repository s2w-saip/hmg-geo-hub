// Hardcoded fixture for the Purchase Context Map node view.
//
// Korean copy lives here on purpose: this is a `.ts` data module, not JSX, so
// `npm run check:strings` (which only scans `.tsx`) does not flag it — same
// convention as components/social-scraping/sample-data.ts. UI *chrome* strings
// in the ported view are the source's English labels; only this demo *content*
// is Korean. Replace with a live scope read when the enrichment pipeline lands.
//
// One coherent scenario — keyword "패밀리 SUV" — matching the table view, so
// the two tabs are the same data drawn two ways. Context names referenced in
// `driven_conditions` / combination `attributes` match condition `name`s
// exactly, which is what makes the cross-links (drives / combo) render.

import type { EnrichedContextMatrix } from "./types";

export const MOCK_KEYWORD = "패밀리 SUV";

export const MOCK_MATRIX: EnrichedContextMatrix = {
  context_themes: [
    {
      theme_name: "가구 구성",
      description: "동거 구성·가족 규모에서 비롯되는 구매 맥락",
      contexts: [
        {
          name: "다자녀 가구",
          mention_count: 47,
          total_workers: 120,
          mention_rate: 0.39,
          unique_source_count: 31,
          source_urls: [
            "https://www.bobaedream.co.kr/view?code=national&No=1",
            "https://www.clien.net/service/board/cm_car/2",
          ],
          source_domains: { "bobaedream.co.kr": 14, "clien.net": 9, "82cook.com": 8 },
          perspective_breakdown: { buyer: 38, seller: 3, neutral: 6 },
          evidence_quotes: [
            {
              quote: "애 셋이라 7인승은 기본이고 3열에 어른이 타도 안 좁아야 해요.",
              source_title: "보배드림 - 패밀리 SUV 고민",
              source_url: "https://www.bobaedream.co.kr/view?code=national&No=1",
              perspective: "buyer",
            },
            {
              quote: "카시트 두 개 깔면 트렁크가 진짜 중요하더라고요.",
              source_title: "82cook - 다둥이맘 차 추천",
              source_url: "https://www.82cook.com/entiz/read.php?num=1",
              perspective: "buyer",
            },
          ],
          driven_conditions: [
            { name: "3열 풀사이즈 시트", strength: 8 },
            { name: "넓은 트렁크", strength: 6 },
          ],
        },
        {
          name: "영유아 동반",
          mention_count: 33,
          total_workers: 120,
          mention_rate: 0.28,
          unique_source_count: 22,
          source_urls: ["https://www.82cook.com/entiz/read.php?num=2"],
          source_domains: { "82cook.com": 11, "blog.naver.com": 7, "clien.net": 4 },
          perspective_breakdown: { buyer: 27, seller: 2, neutral: 4 },
          evidence_quotes: [
            {
              quote: "신생아 카시트 ISOFIX 체결 잘 되는지가 1순위였어요.",
              source_title: "네이버 블로그 - 아기 있는 집 SUV",
              source_url: "https://blog.naver.com/post/1",
              perspective: "buyer",
            },
          ],
          driven_conditions: [
            { name: "ISOFIX 카시트", strength: 7 },
            { name: "후측방 경고", strength: 4 },
          ],
        },
      ],
    },
    {
      theme_name: "라이프스타일",
      description: "여가·취미 활동 중심의 구매 맥락",
      contexts: [
        {
          name: "캠핑·차박족",
          mention_count: 41,
          total_workers: 120,
          mention_rate: 0.34,
          unique_source_count: 28,
          source_urls: ["https://www.fmkorea.com/best/1"],
          source_domains: {
            "fmkorea.com": 10,
            "youtube.com": 9,
            "dcinside.com": 6,
            "clien.net": 3,
          },
          perspective_breakdown: { buyer: 30, seller: 5, neutral: 6 },
          evidence_quotes: [
            {
              quote: "2열 풀플랫 되는 차라야 매트 깔고 둘이 누워요.",
              source_title: "에펨코리아 - 차박 입문 SUV",
              source_url: "https://www.fmkorea.com/best/1",
              perspective: "buyer",
            },
            {
              quote: "V2L 1500W면 전기장판에 인덕션까지 돌립니다.",
              source_title: "유튜브 - 전기 SUV 차박 후기",
              source_url: "https://www.youtube.com/watch?v=demo1",
              perspective: "neutral",
            },
          ],
          driven_conditions: [
            { name: "2열 풀플랫", strength: 7 },
            { name: "1500W 인버터", strength: 5 },
            { name: "AWD 4륜구동", strength: 3 },
          ],
        },
        {
          name: "장거리 출퇴근",
          mention_count: 36,
          total_workers: 120,
          mention_rate: 0.3,
          unique_source_count: 24,
          source_urls: ["https://www.bobaedream.co.kr/view?code=national&No=2"],
          source_domains: { "bobaedream.co.kr": 12, "ppomppu.co.kr": 7, "clien.net": 5 },
          perspective_breakdown: { buyer: 28, seller: 4, neutral: 4 },
          evidence_quotes: [
            {
              quote: "왕복 90km라 하이브리드 연비 아니면 기름값 감당이 안 돼요.",
              source_title: "보배드림 - 장거리 통근 SUV",
              source_url: "https://www.bobaedream.co.kr/view?code=national&No=2",
              perspective: "buyer",
            },
          ],
          driven_conditions: [
            { name: "하이브리드 연비", strength: 9 },
            { name: "어댑티브 크루즈", strength: 6 },
          ],
        },
      ],
    },
    {
      theme_name: "거주·주행 환경",
      description: "주차·도로 환경에서 비롯되는 구매 맥락",
      contexts: [
        {
          name: "아파트 지하주차",
          mention_count: 24,
          total_workers: 120,
          mention_rate: 0.2,
          unique_source_count: 17,
          source_urls: ["https://www.ppomppu.co.kr/zboard/view.php?id=car&no=1"],
          source_domains: { "ppomppu.co.kr": 8, "clien.net": 5, "dcinside.com": 4 },
          perspective_breakdown: { buyer: 18, seller: 2, neutral: 4 },
          evidence_quotes: [
            {
              quote: "기계식은 아니어도 기둥 사이가 좁아서 후방 경고 없으면 불안해요.",
              source_title: "뽐뿌 - 지하주차 SUV 폭",
              source_url: "https://www.ppomppu.co.kr/zboard/view.php?id=car&no=1",
              perspective: "buyer",
            },
          ],
          driven_conditions: [
            { name: "전동 트렁크", strength: 4 },
            { name: "후측방 경고", strength: 5 },
          ],
        },
        {
          name: "겨울철 산간 주행",
          mention_count: 19,
          total_workers: 120,
          mention_rate: 0.16,
          unique_source_count: 13,
          source_urls: ["https://www.dcinside.com/board/car/1"],
          source_domains: { "dcinside.com": 6, "youtube.com": 4, "bobaedream.co.kr": 3 },
          perspective_breakdown: { buyer: 14, seller: 1, neutral: 4 },
          evidence_quotes: [
            {
              quote: "스키장 자주 가면 AWD는 옵션이 아니라 필수입니다.",
              source_title: "디시 자동차 - 겨울 산간 SUV",
              source_url: "https://www.dcinside.com/board/car/1",
              perspective: "buyer",
            },
          ],
          driven_conditions: [{ name: "AWD 4륜구동", strength: 6 }],
        },
      ],
    },
  ],
  condition_categories: [
    {
      category_name: "시트·공간",
      description: "탑승 인원·적재와 직결되는 실내 공간 조건",
      conditions: [
        {
          name: "3열 풀사이즈 시트",
          mention_count: 52,
          total_workers: 120,
          mention_rate: 0.43,
          unique_source_count: 34,
          branch_labels: ["다자녀 가구", "7인승 수요"],
          related_conditions: ["넓은 트렁크", "2열 풀플랫"],
          source_urls: ["https://www.bobaedream.co.kr/view?code=national&No=1"],
          source_domains: { "bobaedream.co.kr": 15, "clien.net": 11, "82cook.com": 8 },
          perspective_breakdown: { buyer: 41, seller: 4, neutral: 7 },
          driven_by_contexts: [{ name: "다자녀 가구", strength: 8 }],
          evidence_quotes: [
            {
              quote: "3열에 성인이 30분 이상 타도 무릎이 안 닿는 차를 찾았어요.",
              source_title: "클리앙 - 7인승 3열 비교",
              source_url: "https://www.clien.net/service/board/cm_car/3",
              perspective: "buyer",
            },
          ],
          deep_evidence: {
            claim: "3열 레그룸은 풀사이즈 SUV에서 실제 구매 결정에 가장 큰 영향을 준다",
            supporting: 28,
            contradicting: 5,
            neutral: 9,
            total_scanned: 42,
            confidence: "high",
            sample_quotes: [
              {
                quote: "3열 좁은 차 샀다가 둘째 생기고 바로 후회했습니다.",
                source: "bobaedream.co.kr",
                stance: "supporting",
              },
              {
                quote: "어차피 3열은 비상용이라 크게 신경 안 썼어요.",
                source: "dcinside.com",
                stance: "contradicting",
              },
            ],
          },
        },
        {
          name: "2열 풀플랫",
          mention_count: 29,
          total_workers: 120,
          mention_rate: 0.24,
          unique_source_count: 21,
          branch_labels: ["차박", "캠핑"],
          related_conditions: ["1500W 인버터", "3열 풀사이즈 시트"],
          source_urls: ["https://www.fmkorea.com/best/1"],
          source_domains: { "fmkorea.com": 9, "youtube.com": 8, "dcinside.com": 4 },
          perspective_breakdown: { buyer: 22, seller: 3, neutral: 4 },
          driven_by_contexts: [{ name: "캠핑·차박족", strength: 7 }],
          evidence_quotes: [
            {
              quote: "시트 접었을 때 단차 없는 게 차박 핵심이에요.",
              source_title: "에펨코리아 - 차박 평탄화",
              source_url: "https://www.fmkorea.com/best/2",
              perspective: "buyer",
            },
          ],
        },
        {
          name: "넓은 트렁크",
          mention_count: 38,
          total_workers: 120,
          mention_rate: 0.32,
          unique_source_count: 26,
          branch_labels: ["다자녀 가구", "유모차"],
          related_conditions: ["3열 풀사이즈 시트"],
          source_urls: ["https://www.82cook.com/entiz/read.php?num=1"],
          source_domains: { "82cook.com": 10, "bobaedream.co.kr": 9, "clien.net": 7 },
          perspective_breakdown: { buyer: 31, seller: 2, neutral: 5 },
          driven_by_contexts: [{ name: "다자녀 가구", strength: 6 }],
          evidence_quotes: [
            {
              quote: "디럭스 유모차 싣고도 캐리어 두 개는 들어가야죠.",
              source_title: "82cook - 트렁크 적재량",
              source_url: "https://www.82cook.com/entiz/read.php?num=3",
              perspective: "buyer",
            },
          ],
        },
        {
          name: "ISOFIX 카시트",
          mention_count: 21,
          total_workers: 120,
          mention_rate: 0.18,
          unique_source_count: 15,
          branch_labels: ["영유아"],
          related_conditions: ["후측방 경고"],
          source_urls: ["https://blog.naver.com/post/1"],
          source_domains: { "blog.naver.com": 7, "82cook.com": 5, "clien.net": 3 },
          perspective_breakdown: { buyer: 17, seller: 1, neutral: 3 },
          driven_by_contexts: [{ name: "영유아 동반", strength: 7 }],
          evidence_quotes: [
            {
              quote: "2열 양쪽 ISOFIX 다 있는지 카탈로그부터 확인했어요.",
              source_title: "네이버 블로그 - 카시트 체결",
              source_url: "https://blog.naver.com/post/2",
              perspective: "buyer",
            },
          ],
        },
      ],
    },
    {
      category_name: "파워트레인·연비",
      description: "주행 비용·구동 방식과 관련된 조건",
      conditions: [
        {
          name: "하이브리드 연비",
          mention_count: 44,
          total_workers: 120,
          mention_rate: 0.37,
          unique_source_count: 30,
          branch_labels: ["장거리", "유지비"],
          related_conditions: ["어댑티브 크루즈"],
          source_urls: ["https://www.bobaedream.co.kr/view?code=national&No=2"],
          source_domains: { "bobaedream.co.kr": 13, "ppomppu.co.kr": 9, "clien.net": 6 },
          perspective_breakdown: { buyer: 35, seller: 5, neutral: 4 },
          driven_by_contexts: [{ name: "장거리 출퇴근", strength: 9 }],
          evidence_quotes: [
            {
              quote: "복합 14km/L만 나와도 1년 유지비 차이가 어마어마해요.",
              source_title: "보배드림 - HEV 실연비",
              source_url: "https://www.bobaedream.co.kr/view?code=national&No=3",
              perspective: "buyer",
            },
          ],
          deep_evidence: {
            claim: "하이브리드 실연비가 패밀리 SUV 구매에서 디젤 대비 결정적 우위를 만든다",
            supporting: 24,
            contradicting: 7,
            neutral: 6,
            total_scanned: 37,
            confidence: "medium",
            sample_quotes: [
              {
                quote: "디젤에서 하이브리드로 갈아타고 주유 횟수가 반으로 줄었어요.",
                source: "ppomppu.co.kr",
                stance: "supporting",
              },
              {
                quote: "고속 위주면 디젤이 아직 낫다는 의견도 많더라고요.",
                source: "bobaedream.co.kr",
                stance: "contradicting",
              },
            ],
          },
        },
        {
          name: "AWD 4륜구동",
          mention_count: 27,
          total_workers: 120,
          mention_rate: 0.22,
          unique_source_count: 19,
          branch_labels: ["겨울", "차박", "산간"],
          related_conditions: ["하이브리드 연비"],
          source_urls: ["https://www.dcinside.com/board/car/1"],
          source_domains: { "dcinside.com": 7, "youtube.com": 6, "bobaedream.co.kr": 4 },
          perspective_breakdown: { buyer: 20, seller: 3, neutral: 4 },
          driven_by_contexts: [
            { name: "캠핑·차박족", strength: 3 },
            { name: "겨울철 산간 주행", strength: 6 },
          ],
          evidence_quotes: [
            {
              quote: "눈길에서 2륜이랑 4륜은 안정감 자체가 다릅니다.",
              source_title: "디시 - AWD 체감",
              source_url: "https://www.dcinside.com/board/car/2",
              perspective: "buyer",
            },
          ],
        },
        {
          name: "1500W 인버터",
          mention_count: 18,
          total_workers: 120,
          mention_rate: 0.15,
          unique_source_count: 12,
          branch_labels: ["차박", "V2L"],
          related_conditions: ["2열 풀플랫"],
          source_urls: ["https://www.youtube.com/watch?v=demo1"],
          source_domains: { "youtube.com": 6, "fmkorea.com": 4, "clien.net": 2 },
          perspective_breakdown: { buyer: 13, seller: 2, neutral: 3 },
          driven_by_contexts: [{ name: "캠핑·차박족", strength: 5 }],
          evidence_quotes: [
            {
              quote: "캠핑장에서 전기 걱정 없는 게 V2L의 진짜 매력이죠.",
              source_title: "유튜브 - V2L 활용",
              source_url: "https://www.youtube.com/watch?v=demo2",
              perspective: "neutral",
            },
          ],
        },
      ],
    },
    {
      category_name: "안전·주행보조",
      description: "가족 탑승 안전과 운전 편의 관련 조건",
      conditions: [
        {
          name: "어댑티브 크루즈",
          mention_count: 31,
          total_workers: 120,
          mention_rate: 0.26,
          unique_source_count: 22,
          branch_labels: ["장거리", "고속"],
          related_conditions: ["하이브리드 연비"],
          source_urls: ["https://www.clien.net/service/board/cm_car/4"],
          source_domains: { "clien.net": 9, "bobaedream.co.kr": 8, "ppomppu.co.kr": 5 },
          perspective_breakdown: { buyer: 24, seller: 3, neutral: 4 },
          driven_by_contexts: [{ name: "장거리 출퇴근", strength: 6 }],
          evidence_quotes: [
            {
              quote: "정체 구간에서 stop&go 되는 ACC 한 번 쓰면 못 돌아가요.",
              source_title: "클리앙 - ACC 후기",
              source_url: "https://www.clien.net/service/board/cm_car/5",
              perspective: "buyer",
            },
          ],
        },
        {
          name: "후측방 경고",
          mention_count: 23,
          total_workers: 120,
          mention_rate: 0.19,
          unique_source_count: 16,
          branch_labels: ["주차", "영유아"],
          related_conditions: ["ISOFIX 카시트", "전동 트렁크"],
          source_urls: ["https://www.ppomppu.co.kr/zboard/view.php?id=car&no=1"],
          source_domains: { "ppomppu.co.kr": 6, "clien.net": 5, "dcinside.com": 3 },
          perspective_breakdown: { buyer: 18, seller: 2, neutral: 3 },
          driven_by_contexts: [
            { name: "영유아 동반", strength: 4 },
            { name: "아파트 지하주차", strength: 5 },
          ],
          evidence_quotes: [
            {
              quote: "주차장에서 자전거 타는 애들 튀어나올 때 경고가 진짜 도움돼요.",
              source_title: "뽐뿌 - 후측방 경고",
              source_url: "https://www.ppomppu.co.kr/zboard/view.php?id=car&no=2",
              perspective: "buyer",
            },
          ],
        },
      ],
    },
    {
      category_name: "편의 사양",
      description: "일상 사용성을 높이는 편의 조건",
      conditions: [
        {
          name: "전동 트렁크",
          mention_count: 17,
          total_workers: 120,
          mention_rate: 0.14,
          unique_source_count: 11,
          branch_labels: ["주차", "유모차"],
          related_conditions: ["후측방 경고", "넓은 트렁크"],
          source_urls: ["https://www.clien.net/service/board/cm_car/6"],
          source_domains: { "clien.net": 5, "82cook.com": 4, "bobaedream.co.kr": 2 },
          perspective_breakdown: { buyer: 12, seller: 2, neutral: 3 },
          driven_by_contexts: [{ name: "아파트 지하주차", strength: 4 }],
          evidence_quotes: [
            {
              quote: "애 안고 짐 들고 있을 때 발로 여는 스마트 트렁크 필수예요.",
              source_title: "클리앙 - 스마트 트렁크",
              source_url: "https://www.clien.net/service/board/cm_car/7",
              perspective: "buyer",
            },
          ],
        },
      ],
    },
  ],
  combinations: [
    {
      attributes: ["3열 풀사이즈 시트", "넓은 트렁크"],
      frequency: "high",
      description:
        "다자녀 가구가 가장 자주 함께 요구하는 조건. 3열에 사람을 태우면서도 적재 공간을 포기하지 않으려는 패턴.",
      co_occurrence_count: 14,
      total_speakers: 120,
      co_occurrence_rate: 0.12,
      unique_source_count: 19,
      frequency_justification: "120명 중 14명 (12%)",
      evidence_quotes: [
        {
          quote: "3열 펴도 트렁크 남는 차 아니면 캠핑 짐을 못 실어요.",
          source_title: "보배드림 - 풀사이즈 패키지",
          source_url: "https://www.bobaedream.co.kr/view?code=national&No=4",
          perspective: "buyer",
        },
      ],
      source_urls: [
        "https://www.bobaedream.co.kr/view?code=national&No=4",
        "https://www.clien.net/service/board/cm_car/8",
        "https://www.82cook.com/entiz/read.php?num=4",
      ],
    },
    {
      attributes: ["하이브리드 연비", "어댑티브 크루즈"],
      frequency: "high",
      description:
        "장거리 통근층의 효율+편의 조합. 유지비를 줄이면서 고속 주행 피로도까지 낮추려는 의도.",
      co_occurrence_count: 11,
      total_speakers: 120,
      co_occurrence_rate: 0.09,
      unique_source_count: 16,
      frequency_justification: "120명 중 11명 (9%)",
      evidence_quotes: [
        {
          quote: "하이브리드에 ACC까지 있으니 장거리 운전이 완전 달라졌어요.",
          source_title: "클리앙 - 통근 만족도",
          source_url: "https://www.clien.net/service/board/cm_car/9",
          perspective: "buyer",
        },
      ],
      source_urls: [
        "https://www.clien.net/service/board/cm_car/9",
        "https://www.bobaedream.co.kr/view?code=national&No=5",
      ],
    },
    {
      attributes: ["2열 풀플랫", "1500W 인버터", "AWD 4륜구동"],
      frequency: "medium",
      description:
        "차박·캠핑족의 풀패키지. 평탄화·전력·험로 주행을 한 차로 해결하려는 조합으로 전기 SUV에서 특히 강하게 나타남.",
      co_occurrence_count: 7,
      total_speakers: 120,
      co_occurrence_rate: 0.06,
      unique_source_count: 12,
      frequency_justification: "120명 중 7명 (6%)",
      evidence_quotes: [
        {
          quote: "풀플랫에 V2L에 4륜이면 어디든 캠핑 가능하죠.",
          source_title: "에펨코리아 - 차박 끝판왕",
          source_url: "https://www.fmkorea.com/best/3",
          perspective: "buyer",
        },
      ],
      source_urls: [
        "https://www.fmkorea.com/best/3",
        "https://www.youtube.com/watch?v=demo3",
        "https://www.dcinside.com/board/car/3",
      ],
    },
    {
      attributes: ["ISOFIX 카시트", "후측방 경고"],
      frequency: "medium",
      description: "영유아 동반 가구의 안전 조합. 체결 편의와 주차장 사고 예방을 함께 고려.",
      co_occurrence_count: 6,
      total_speakers: 120,
      co_occurrence_rate: 0.05,
      unique_source_count: 9,
      frequency_justification: "120명 중 6명 (5%)",
      evidence_quotes: [
        {
          quote: "애 타는 차라 카시트랑 안전 경고는 묶어서 봤어요.",
          source_title: "82cook - 안전 옵션",
          source_url: "https://www.82cook.com/entiz/read.php?num=5",
          perspective: "buyer",
        },
      ],
      source_urls: [
        "https://www.82cook.com/entiz/read.php?num=5",
        "https://blog.naver.com/post/3",
      ],
    },
  ],
  total_context_themes: 3,
  total_contexts_found: 6,
  total_condition_categories: 4,
  total_conditions_found: 10,
  enrichment_stats: {
    total_workers: 120,
    total_speakers: 340,
    total_sources: 85,
    perspective_breakdown: { buyer: 268, seller: 31, neutral: 41 },
    total_relationships: 18,
    deep_evidence_linked: 2,
  },
};
