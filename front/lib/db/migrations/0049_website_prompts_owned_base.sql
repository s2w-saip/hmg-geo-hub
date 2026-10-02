-- website_prompts.owned_base_url — KPI ⑤ 자사 판정 base 를 측정 유닛이 직접 선언한다.
--
-- 왜 여기인가: 종전에는 geo-catalog(브랜드×국가)에서 base 를 찾았는데, 그 단위로는
-- 실제 측정 유닛을 표현할 수 없다. 2026-09-01 전수 확인:
--   · 카탈로그가 base 를 특정하지 못하는 사이트 19곳 — MIDDLEEAST·worldwide·CN-BJ·CPO 같은
--     의사 국가코드, EXCLUDED_OWNED_DOMAINS 로 뺀 도메인(hyundaiksa.com·kiaphilippines.com),
--     카탈로그에 없는 사이트(hyundai-me.com 등). 이 곳들은 국가 좁히기가 무력화돼
--     **브랜드 전 세계 사이트를 자사로 세고 있었다**(현대 중동 ⑤ 31.94% → 실제 0.73%).
--   · 언어별로 base 가 다른 사이트 13곳 — 현대/기아/제네시스 캐나다, Kia US en/es,
--     Kia BE fr/nl, 현대 ID·TH, 중동·SA·worldwide 계열.
--   · 언어가 같은데 base 가 셋인 Genesis/SA — sa-dammam·sa-jeddah·sa-riyadh.
-- website_prompts 는 (site_id, file_seq) 가 리포트의 측정 유닛과 1:1 이라 셋 다 표현된다.
--
-- 값의 출처: 리포트 파이프라인(scripts/statusboard/export_citation_units.mts)의 base 도출과
-- 같은 규칙 — ① 타겟 URL 을 전부 덮는 가장 긴 카탈로그 접두 ② 없으면 호스트(공용 호스트는
-- 경로 1단계 보장) ③ 형제 유닛 타겟이 들어오면 분리될 때까지 연장. 그래서 이 백필이
-- 적용되면 대시보드 값이 리포트와 같아진다(리포트는 변하지 않는다).
-- NULL 이면 종전대로 카탈로그 폴백.

ALTER TABLE "website_prompts" ADD COLUMN IF NOT EXISTS "owned_base_url" text;

-- 백필 — 109 측정 유닛 (2026-08-28 회차 스펙 기준). 재실행 안전(멱등).
UPDATE website_prompts SET owned_base_url = 'hyundai.com.mx'
  WHERE site_id = '3afb8f7e-2381-4aab-b72d-916080eb99ba' AND file_seq IN (1);
UPDATE website_prompts SET owned_base_url = 'hyundaiusa.com/us/en'
  WHERE site_id = '20abdb5c-9b60-4922-80f3-b7a5e66326a5' AND file_seq IN (2);
UPDATE website_prompts SET owned_base_url = 'hyundaicanada.com/en'
  WHERE site_id = 'e1c6748a-c755-475b-80a1-533644f4a798' AND file_seq IN (3);
UPDATE website_prompts SET owned_base_url = 'hyundaicanada.com/fr'
  WHERE site_id = 'e1c6748a-c755-475b-80a1-533644f4a798' AND file_seq IN (4);
UPDATE website_prompts SET owned_base_url = 'hyundai.com/kr/ko'
  WHERE site_id = '68202ad5-08e7-4076-8512-977e0dc8b1af' AND file_seq IN (5);
UPDATE website_prompts SET owned_base_url = 'hyundai.com/in/en'
  WHERE site_id = '2dd57e90-7080-4ea6-b383-6f5e6064c1c3' AND file_seq IN (6);
UPDATE website_prompts SET owned_base_url = 'hyundai.com/jp'
  WHERE site_id = '452f7d99-b90d-4a1e-a34c-851901a5c901' AND file_seq IN (7);
UPDATE website_prompts SET owned_base_url = 'hyundai.com.cn'
  WHERE site_id = '7fa1303e-c7b0-4fb1-a84e-72e02e3a30b4' AND file_seq IN (8);
UPDATE website_prompts SET owned_base_url = 'hyundai.com/au/en'
  WHERE site_id = '2051d136-f639-4802-b767-14e22fd28aaf' AND file_seq IN (9);
UPDATE website_prompts SET owned_base_url = 'hyundai.com/nl/nl'
  WHERE site_id = '21503fb7-a55b-475d-a27f-f84c231d845a' AND file_seq IN (11);
UPDATE website_prompts SET owned_base_url = 'hyundai.com/no/no'
  WHERE site_id = 'de34a651-ada0-406d-9a9b-8cf72a29a32e' AND file_seq IN (12);
UPDATE website_prompts SET owned_base_url = 'hyundai.com/eu/en'
  WHERE site_id = '1b9aca0f-e9fb-493e-a74d-47bdcf73e659' AND file_seq IN (14);
UPDATE website_prompts SET owned_base_url = 'hyundai.com/de/de'
  WHERE site_id = '306591f7-de38-4316-af0c-d517c5131114' AND file_seq IN (15);
UPDATE website_prompts SET owned_base_url = 'hyundai.com/se/sv'
  WHERE site_id = 'b1fd189a-bcbd-4dca-b55c-d6ee9f58fb9f' AND file_seq IN (22);
UPDATE website_prompts SET owned_base_url = 'hyundai.com/es/es'
  WHERE site_id = '9b3a4b50-1abe-4487-aafa-69341ff7ad9a' AND file_seq IN (23);
UPDATE website_prompts SET owned_base_url = 'hyundai.com/sk/sk'
  WHERE site_id = '43b12ce9-4187-47f0-b9a7-ee472154bc14' AND file_seq IN (24);
UPDATE website_prompts SET owned_base_url = 'hyundai.com/uk/en'
  WHERE site_id = 'eae135e5-369d-43ef-bbc8-9f89b20f31c7' AND file_seq IN (27);
UPDATE website_prompts SET owned_base_url = 'hyundai.com/it/it'
  WHERE site_id = '5c7c5cf5-6d06-4df4-a217-e2ed29271b46' AND file_seq IN (29);
UPDATE website_prompts SET owned_base_url = 'hyundai.com/cz'
  WHERE site_id = 'a6e101e5-eaa6-4680-8892-f0023efb3be4' AND file_seq IN (30);
UPDATE website_prompts SET owned_base_url = 'hyundai.com/tr/tr'
  WHERE site_id = '69a3f6d9-386d-47bb-9ff9-0de81cf20788' AND file_seq IN (32);
UPDATE website_prompts SET owned_base_url = 'hyundai.com/pl/pl'
  WHERE site_id = '0494c306-3f68-4f03-a95f-bfbcdc870cf3' AND file_seq IN (34);
UPDATE website_prompts SET owned_base_url = 'hyundai.com/fr/fr'
  WHERE site_id = '5395036a-7ae3-4425-8909-865eea82e4e7' AND file_seq IN (35);
UPDATE website_prompts SET owned_base_url = 'hyundai.cl'
  WHERE site_id = '4e1a99c5-00cf-4080-bb7b-ca1117f45417' AND file_seq IN (38);
UPDATE website_prompts SET owned_base_url = 'hyundai.com.br'
  WHERE site_id = '5f51e58f-196c-4be4-8de6-a527d8d17356' AND file_seq IN (39);
UPDATE website_prompts SET owned_base_url = 'hyundai-n.com/ko'
  WHERE site_id = '8f4a5c84-c1fe-4889-a200-330d70710596' AND file_seq IN (40);
-- 2026-09-06 정정: 루트 타겟 1개 때문에 호스트로 접혔던 EN base 를 언어 경로로. KO(/ko) 인용
-- 39건이 EN 자사로 잡히던 누수(PR #210 본문) — 프로덕션은 같은 날 100행 UPDATE 로 반영됨.
UPDATE website_prompts SET owned_base_url = 'hyundai-n.com/en'
  WHERE site_id = '7b3b89df-7896-469c-88c1-f3442949cde7' AND file_seq IN (41);
UPDATE website_prompts SET owned_base_url = 'hyundai.com/worldwide/en'
  WHERE site_id = '0b795b24-1564-4976-b960-4f55aae57cd2' AND file_seq IN (43);
UPDATE website_prompts SET owned_base_url = 'hyundai.com/worldwide/ko'
  WHERE site_id = '0b795b24-1564-4976-b960-4f55aae57cd2' AND file_seq IN (42);
UPDATE website_prompts SET owned_base_url = 'genesis.com/ca/en'
  WHERE site_id = '350164a4-7276-4734-a167-b2b4b62ccb1f' AND file_seq IN (45);
UPDATE website_prompts SET owned_base_url = 'genesis.com/ca/fr'
  WHERE site_id = '350164a4-7276-4734-a167-b2b4b62ccb1f' AND file_seq IN (46);
UPDATE website_prompts SET owned_base_url = 'genesis.com/kr/ko'
  WHERE site_id = 'f529d9e2-fee2-4e93-b9b3-f5ba0d01e6af' AND file_seq IN (47);
UPDATE website_prompts SET owned_base_url = 'genesis.com/middleeast/ar'
  WHERE site_id = '423ae71e-906d-4046-9f3b-73768d1fce2f' AND file_seq IN (48);
UPDATE website_prompts SET owned_base_url = 'genesis.com.cn'
  WHERE site_id = '5b6e6033-bc2a-45f9-b06f-9de7b6598426' AND file_seq IN (49);
UPDATE website_prompts SET owned_base_url = 'genesis.com/au/en'
  WHERE site_id = '664ff1f5-fb8a-44cf-973d-4a410ac45b65' AND file_seq IN (50);
UPDATE website_prompts SET owned_base_url = 'genesis.com/de/de'
  WHERE site_id = '86679fcd-f6e1-492a-89f4-13913d0c8da3' AND file_seq IN (51);
UPDATE website_prompts SET owned_base_url = 'genesis.com/uk/en'
  WHERE site_id = 'bc66071a-d42c-4d96-9310-46efaebb6cbf' AND file_seq IN (52);
UPDATE website_prompts SET owned_base_url = 'genesis.com/it/it'
  WHERE site_id = 'b1d2280d-2464-4e1a-a976-79f892765b45' AND file_seq IN (53);
UPDATE website_prompts SET owned_base_url = 'genesis.com/ch/fr'
  WHERE site_id = 'fe50266b-72da-4a05-b4b1-85e97f4bc393' AND file_seq IN (54);
UPDATE website_prompts SET owned_base_url = 'genesis.com/worldwide/en'
  WHERE site_id = '0ac1d808-3b1f-40d1-a688-ad99785ceef4' AND file_seq IN (56);
UPDATE website_prompts SET owned_base_url = 'kia.com/mx'
  WHERE site_id = 'c53aba22-0597-4416-9caf-a19afb0b85f1' AND file_seq IN (59);
UPDATE website_prompts SET owned_base_url = 'kia.com/us/en'
  WHERE site_id = 'ac67ad87-923b-4d83-bcaa-d0df736a8e98' AND file_seq IN (60);
UPDATE website_prompts SET owned_base_url = 'kia.com/us/es'
  WHERE site_id = 'ac67ad87-923b-4d83-bcaa-d0df736a8e98' AND file_seq IN (61);
UPDATE website_prompts SET owned_base_url = 'kia.ca/en'
  WHERE site_id = '2ecec085-fa7e-4cf0-b139-ff2b76d61361' AND file_seq IN (63);
UPDATE website_prompts SET owned_base_url = 'kia.ca/fr'
  WHERE site_id = '2ecec085-fa7e-4cf0-b139-ff2b76d61361' AND file_seq IN (64);
UPDATE website_prompts SET owned_base_url = 'kia.com/tw'
  WHERE site_id = 'a98c1d83-da4e-45f7-813b-ef9a0f052732' AND file_seq IN (65);
UPDATE website_prompts SET owned_base_url = 'kia.com/kr'
  WHERE site_id = 'ea4fd0df-5253-4f9b-bf72-92acbae40b4c' AND file_seq IN (66);
UPDATE website_prompts SET owned_base_url = 'kia.com/in'
  WHERE site_id = 'f235cbfa-fc06-4256-870d-68d059dede06' AND file_seq IN (69);
UPDATE website_prompts SET owned_base_url = 'kia.com/id/id'
  WHERE site_id = 'd2d4213c-22e6-4350-8b1e-3a49a05b9b47' AND file_seq IN (70);
UPDATE website_prompts SET owned_base_url = 'kia.cn'
  WHERE site_id = 'ad43323a-3099-4ad1-9186-2ce45886c054' AND file_seq IN (71);
UPDATE website_prompts SET owned_base_url = 'kia.com/th/th'
  WHERE site_id = 'db8f85fe-9258-4184-aa93-03d9011e3cd1' AND file_seq IN (72);
UPDATE website_prompts SET owned_base_url = 'kia.com/au'
  WHERE site_id = '167d9f27-6fb7-4fbf-ad8f-5e27ac03ec9b' AND file_seq IN (73);
UPDATE website_prompts SET owned_base_url = 'kia.com/gr'
  WHERE site_id = '26d7e0a1-d2f9-4965-b87d-f4b842cc57d5' AND file_seq IN (74);
UPDATE website_prompts SET owned_base_url = 'kia.com/nl'
  WHERE site_id = '4d588b6a-bad4-4b5f-affa-ac1453365f2c' AND file_seq IN (75);
UPDATE website_prompts SET owned_base_url = 'kia.com/no'
  WHERE site_id = 'b366ca1e-480f-4a50-9117-8745d4054726' AND file_seq IN (76);
UPDATE website_prompts SET owned_base_url = 'kia.com/dk'
  WHERE site_id = 'bc8a1684-d037-4c37-9491-c32eed24d3c2' AND file_seq IN (77);
UPDATE website_prompts SET owned_base_url = 'kia.com/de'
  WHERE site_id = '79f19862-3f16-438d-9c0c-9452b8ea125b' AND file_seq IN (78);
UPDATE website_prompts SET owned_base_url = 'kia.com/se'
  WHERE site_id = '284d8953-fae8-4b39-baef-8d32408139e9' AND file_seq IN (86);
UPDATE website_prompts SET owned_base_url = 'kia.com/es'
  WHERE site_id = 'df5999c2-b28f-49f4-b2a2-35f7bda25899' AND file_seq IN (87);
UPDATE website_prompts SET owned_base_url = 'kia.com/sk'
  WHERE site_id = '207d9231-93e9-42d2-9f24-0d12ef1e2336' AND file_seq IN (88);
UPDATE website_prompts SET owned_base_url = 'kia.ee'
  WHERE site_id = 'e8a7aee4-f6a6-40b9-b89e-3a411c2efaf4' AND file_seq IN (91);
UPDATE website_prompts SET owned_base_url = 'kia.com/uk'
  WHERE site_id = '96a1a983-44aa-4957-8a55-bd4b43682fe7' AND file_seq IN (92);
UPDATE website_prompts SET owned_base_url = 'kia.com/ua'
  WHERE site_id = '632e3dea-4c27-4e7d-a507-d86987efb065' AND file_seq IN (94);
UPDATE website_prompts SET owned_base_url = 'kia.com/it'
  WHERE site_id = 'd9ff3728-33fb-4b9f-9866-37366c67dff3' AND file_seq IN (95);
UPDATE website_prompts SET owned_base_url = 'kia.com/cz'
  WHERE site_id = 'ddc3c61c-37ec-4448-9edf-768247b86aec' AND file_seq IN (96);
UPDATE website_prompts SET owned_base_url = 'kia.com.kz'
  WHERE site_id = '699cd010-88f6-4b0b-a91a-c9589f6134cf' AND file_seq IN (97);
UPDATE website_prompts SET owned_base_url = 'kia.com/tr'
  WHERE site_id = '61085751-4bec-4d58-bc04-e0aae8e96557' AND file_seq IN (99);
UPDATE website_prompts SET owned_base_url = 'kia.com/pl'
  WHERE site_id = '7657f26b-f975-4a72-b4cb-e2de67a76f69' AND file_seq IN (101);
UPDATE website_prompts SET owned_base_url = 'kia.com/fr'
  WHERE site_id = '51b7a50e-7718-4398-b7d3-6e74996d9666' AND file_seq IN (102);
UPDATE website_prompts SET owned_base_url = 'kia.com/fi'
  WHERE site_id = 'b0cf8930-9b65-4adf-887f-744c3dc7231e' AND file_seq IN (103);
UPDATE website_prompts SET owned_base_url = 'kia.com/hu'
  WHERE site_id = 'ad0fe22c-2e5e-415a-9f84-3e8a9f6311e2' AND file_seq IN (104);
UPDATE website_prompts SET owned_base_url = 'kia-israel.co.il'
  WHERE site_id = '985713e3-8c51-4436-9364-17c740707ca9' AND file_seq IN (106);
UPDATE website_prompts SET owned_base_url = 'worldwide.kia.com/ko'
  WHERE site_id = '781d0229-f083-48f9-8b9d-8f4f448a30d4' AND file_seq IN (107);
UPDATE website_prompts SET owned_base_url = 'worldwide.kia.com/en'
  WHERE site_id = '781d0229-f083-48f9-8b9d-8f4f448a30d4' AND file_seq IN (108);
UPDATE website_prompts SET owned_base_url = 'certified.hyundai.com'
  WHERE site_id = '15585b25-3c1e-4018-8c77-20171f6b62fd' AND file_seq IN (109);
UPDATE website_prompts SET owned_base_url = 'genesis.com/bh/en'
  WHERE site_id = '375625c4-3eea-4013-bcd5-64064935e433' AND file_seq IN (110);
UPDATE website_prompts SET owned_base_url = 'genesis.com/kw/en'
  WHERE site_id = '304a32be-6f00-47e0-8678-7d4047b71be4' AND file_seq IN (111);
UPDATE website_prompts SET owned_base_url = 'genesis.com/om/en'
  WHERE site_id = 'f26f4e5e-4b1f-4f1a-8467-641a5177bb69' AND file_seq IN (112);
UPDATE website_prompts SET owned_base_url = 'genesis.com/qa/en'
  WHERE site_id = '1737927a-7534-46fd-ae3c-d27414873371' AND file_seq IN (113);
UPDATE website_prompts SET owned_base_url = 'genesis.com/sa-dammam'
  WHERE site_id = '79efdcc1-5582-45df-938d-e12f387adca4' AND file_seq IN (114);
UPDATE website_prompts SET owned_base_url = 'genesis.com/middleeast/en'
  WHERE site_id = '423ae71e-906d-4046-9f3b-73768d1fce2f' AND file_seq IN (115);
UPDATE website_prompts SET owned_base_url = 'genesis.com/sa-jeddah'
  WHERE site_id = '79efdcc1-5582-45df-938d-e12f387adca4' AND file_seq IN (116);
UPDATE website_prompts SET owned_base_url = 'genesis.com/sa-riyadh'
  WHERE site_id = '79efdcc1-5582-45df-938d-e12f387adca4' AND file_seq IN (117);
UPDATE website_prompts SET owned_base_url = 'genesis.com/ae/en'
  WHERE site_id = 'fea69e63-52a3-4316-8aaf-6fe899bcee5d' AND file_seq IN (118);
UPDATE website_prompts SET owned_base_url = 'hyundai.com/id/en'
  WHERE site_id = 'dbb7789d-e8b3-4392-aff7-b1f479cc3787' AND file_seq IN (119);
UPDATE website_prompts SET owned_base_url = 'hyundai.com/id/id'
  WHERE site_id = 'dbb7789d-e8b3-4392-aff7-b1f479cc3787' AND file_seq IN (120);
UPDATE website_prompts SET owned_base_url = 'hyundai.com/my/en'
  WHERE site_id = '9f07d56f-b682-4803-9094-739e1abb2543' AND file_seq IN (121);
UPDATE website_prompts SET owned_base_url = 'hyundai.com/th/en'
  WHERE site_id = '3e70d187-f6ed-4583-a14f-b83e1bd93017' AND file_seq IN (122);
UPDATE website_prompts SET owned_base_url = 'hyundai.com/th/th'
  WHERE site_id = '3e70d187-f6ed-4583-a14f-b83e1bd93017' AND file_seq IN (123);
UPDATE website_prompts SET owned_base_url = 'hyundai.com/ph/en'
  WHERE site_id = '0ffc8ec3-c754-4e79-b90f-fbddacd71862' AND file_seq IN (124);
UPDATE website_prompts SET owned_base_url = 'hyundai.pe'
  WHERE site_id = '43602058-0186-446a-932c-01b011f67c18' AND file_seq IN (125);
UPDATE website_prompts SET owned_base_url = 'hyundaipr.com'
  WHERE site_id = '092613ed-2143-47ce-bc91-b78e743fe21d' AND file_seq IN (126);
UPDATE website_prompts SET owned_base_url = 'hyundaicolombia.co'
  WHERE site_id = '0621bd7c-36af-4d7a-a387-b1c71fdb61b1' AND file_seq IN (127);
UPDATE website_prompts SET owned_base_url = 'hyundai-me.com/en'
  WHERE site_id = '0c26ecac-bad6-472f-8705-b55a81cdf9f3' AND file_seq IN (128);
UPDATE website_prompts SET owned_base_url = 'hyundai-me.com/ar'
  WHERE site_id = '0c26ecac-bad6-472f-8705-b55a81cdf9f3' AND file_seq IN (129);
UPDATE website_prompts SET owned_base_url = 'hyundaiksa.com/ar'
  WHERE site_id = '896cd4c4-9351-44ac-a417-80ad1a749bf0' AND file_seq IN (130);
UPDATE website_prompts SET owned_base_url = 'hyundaiksa.com/en'
  WHERE site_id = '896cd4c4-9351-44ac-a417-80ad1a749bf0' AND file_seq IN (131);
UPDATE website_prompts SET owned_base_url = 'kia.com/at'
  WHERE site_id = '8587912d-d781-4924-b8c6-1653381f01e7' AND file_seq IN (132);
UPDATE website_prompts SET owned_base_url = 'kia.com/be/fr'
  WHERE site_id = 'b5a51c75-ec77-45c0-a7bb-e5084a22c0ea' AND file_seq IN (133);
UPDATE website_prompts SET owned_base_url = 'kia.com/ie'
  WHERE site_id = 'b9690168-3c9c-401e-bb87-500a5d45b00c' AND file_seq IN (134);
UPDATE website_prompts SET owned_base_url = 'kia.com/is'
  WHERE site_id = 'b0017e4b-d364-462c-8375-052f6eaa23ef' AND file_seq IN (135);
UPDATE website_prompts SET owned_base_url = 'kia.com/mt'
  WHERE site_id = '35375f9a-6cfa-49dd-b1aa-5d2e8f8b70ce' AND file_seq IN (136);
UPDATE website_prompts SET owned_base_url = 'kia.com/my'
  WHERE site_id = '382c5263-6429-4a2c-9678-0d26ba5f8989' AND file_seq IN (137);
UPDATE website_prompts SET owned_base_url = 'kiavietnam.com.vn'
  WHERE site_id = '0f27ac4e-6655-40f6-b473-1a33e090a0ba' AND file_seq IN (138);
UPDATE website_prompts SET owned_base_url = 'genesis.com/fr'
  WHERE site_id = 'ce3069c9-760c-4010-8ae1-11d50528f301' AND file_seq IN (139);
UPDATE website_prompts SET owned_base_url = 'genesis.com/nl/nl'
  WHERE site_id = 'e750c193-ea06-47a0-8209-e0a93818900b' AND file_seq IN (140);
UPDATE website_prompts SET owned_base_url = 'kia.com/be/nl'
  WHERE site_id = 'b5a51c75-ec77-45c0-a7bb-e5084a22c0ea' AND file_seq IN (141);
UPDATE website_prompts SET owned_base_url = 'kia.com/sg'
  WHERE site_id = '066e17cd-764b-4a68-962c-16a08205a48a' AND file_seq IN (142);
UPDATE website_prompts SET owned_base_url = 'beijing-hyundai.com.cn'
  WHERE site_id = '00f02da9-a354-43d9-b6ac-44b3071f9d52' AND file_seq IN (143);
UPDATE website_prompts SET owned_base_url = 'kiaphilippines.com'
  WHERE site_id = 'abb09ede-e015-4c93-8d64-d8b030046c63' AND file_seq IN (144);
