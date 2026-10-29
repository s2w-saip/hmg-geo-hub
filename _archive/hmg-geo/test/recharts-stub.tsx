/**
 * recharts **얇은 스텁** — 갭 오버레이 렌더 가드들이 공유한다.
 *
 * 왜 필요한가: recharts 3.8 은 `renderToStaticMarkup` 에서 `<div class="recharts-wrapper">`
 * 만 내고 끝난다(폭·높이 보고가 effect 라서다). 그래서 차트 안쪽을 마크업으로 세려면
 * recharts 를 통째로 스텁으로 갈아끼워야 한다. 스텁은 children 을 그대로 통과시키고,
 * 축 스케일 훅에는 결정적 가짜 스케일을 준다 — 그러면 우리 코드가 직접 그리는 보조선
 * `<path>` 가 **진짜로 렌더되고** 그 `d` 를 눈으로 검산할 수 있다.
 *
 * ⚠️ export 이름은 **실제 모듈에서 가져온 것만** 만든다. Proxy 로 아무 이름이나 만들어
 * 주면 모듈을 `await` 할 때 `then` 까지 컴포넌트로 돌려줘서 thenable 로 오인돼 영원히
 * 안 풀린다(2026-09-11 실측).
 */
import { cloneElement, createElement, isValidElement, type ReactElement, type ReactNode } from "react";

/** 가짜 스케일의 상수 — 주 간격 40px · 값 1당 2px(SVG y 는 아래로 커지므로 부호 반전). */
export const STUB_X_STEP = 40;
export const STUB_Y_BASE = 200;
export const STUB_Y_UNIT = 2;

/**
 * `usePlotArea` 기본값. **실값**이어야 한다 — `undefined` 를 주면 오버슛 리미터의
 * 기준(`TrendBridgeOptions.plotSpan`)이 끝점 스팬으로 물러서서, 제품이 `plotSpan` 을
 * 아예 안 넘겨도 테스트가 눈치채지 못한다(재검증자 M6).
 */
export const STUB_PLOT_AREA = { x: 0, y: 0, width: 400, height: 200 } as const;

/** 각 테스트가 렌더 직전에 채우는 가변 상태. */
export interface RechartsStubState {
  /** x 축 카테고리(차트가 XAxis dataKey 로 쓰는 값 그대로). */
  xs: Array<string | number>;
  /** `usePlotArea` 반환값. 생략하면 `STUB_PLOT_AREA`, `null` 이면 "레이아웃 전"(undefined). */
  plotArea?: { x: number; y: number; width: number; height: number } | null;
  /**
   * 가짜 스케일 상수 override — 생략하면 `STUB_X_STEP`·`STUB_Y_BASE`·`STUB_Y_UNIT`.
   *
   * 실측 픽셀 좌표를 그대로 박은 픽스처(프리뷰 sweep 재현)를 쓰려면 스케일이
   * 그 좌표계와 맞아야 한다 — 예: `yBase 258 · yUnit 1` 이면 값 v 가 픽셀 `258 - v` 로
   * 실려서, 실측 y 를 값으로 되돌려 넣기만 하면 같은 기하가 재현된다.
   */
  xStep?: number;
  yBase?: number;
  yUnit?: number;
  /**
   * `Tooltip` 스텁이 `content` 에 넘길 payload — **지정한 테스트에서만** 툴팁 본문이
   * 실제로 렌더된다(기본은 종전대로 `content` 를 안 그린다. 다른 테스트 무영향).
   *
   * recharts 가 하는 일을 그대로 흉내낸다: `content` 가 엘리먼트면
   * `cloneElement(content, { active, payload, label })`(`Tooltip.js` 의 `renderContent`).
   * 그래서 갭 슬롯에서 툴팁 본문이 **정말 아무것도 안 내는지**를 차트 컴포넌트를
   * 통과시켜 마크업으로 확인할 수 있다 — 렌더된 툴팁은 `data-tip="1"` 로 표시된다.
   */
  tooltipPayload?: ReadonlyArray<Record<string, unknown>>;
  /** 툴팁 본문에 넘길 라벨(축 값). 생략하면 빈 문자열. */
  tooltipLabel?: string;
}

export interface RechartsStubOptions {
  /** `await vi.importActual("recharts")` 결과 — export 이름·상수를 여기서 딴다. */
  actual: Record<string, unknown>;
  state: RechartsStubState;
  /** 스텁 엘리먼트 태그(기본 `g`). */
  tag?: string;
  /** 엘리먼트 이름을 남길 속성(기본 `data-rc`). */
  nameAttr?: string;
  /** 마크업에 남길 prop → 속성 이름 매핑. 예: `{ x1: "data-x1" }`. */
  keep?: Readonly<Record<string, string>>;
}

/** recharts 모듈 스텁 한 벌. `vi.mock("recharts", …)` 팩토리에서 그대로 반환한다. */
export function makeRechartsStub({
  actual,
  state,
  tag = "g",
  nameAttr = "data-rc",
  keep = {},
}: RechartsStubOptions): Record<string, unknown> {
  const xScale = (v: unknown) => {
    const i = state.xs.indexOf(v as string | number);
    return i < 0 ? undefined : (state.xStep ?? STUB_X_STEP) * i;
  };
  const yScale = (v: unknown) =>
    typeof v === "number"
      ? (state.yBase ?? STUB_Y_BASE) - (state.yUnit ?? STUB_Y_UNIT) * v
      : undefined;
  const plotArea = () =>
    state.plotArea === undefined ? STUB_PLOT_AREA : (state.plotArea ?? undefined);

  const out: Record<string, unknown> = {};
  for (const name of Object.keys(actual)) {
    if (name === "useXAxisScale") out[name] = () => xScale;
    else if (name === "useYAxisScale") out[name] = () => yScale;
    else if (name === "usePlotArea") out[name] = plotArea;
    // 층 번호 상수는 **실제 값**을 그대로 쓴다 — 스텁으로 덮으면 우리 코드가 어느
    // 층을 고른 건지 알 수 없어진다(그리고 zIndex 가 undefined 가 돼 결함이 숨는다).
    else if (name === "DefaultZIndexes") out[name] = actual[name];
    // 툴팁은 `content` 가 prop 이라 children 통과만으로는 본문이 안 그려진다.
    // `state.tooltipPayload` 가 있을 때만 recharts 처럼 content 를 clone 해 렌더한다.
    else if (name === "Tooltip") {
      const T = (props: Record<string, unknown>) => {
        const payload = state.tooltipPayload;
        const content = props.content;
        if (!payload || !isValidElement(content)) {
          return createElement(tag, { [nameAttr]: name });
        }
        return createElement(
          tag,
          { [nameAttr]: name, "data-tip": "1" },
          cloneElement(content as ReactElement<Record<string, unknown>>, {
            active: true,
            payload,
            label: state.tooltipLabel ?? "",
          }),
        );
      };
      T.displayName = "Stub(Tooltip)";
      out[name] = T;
    }
    // 층 래퍼는 children 을 통과시키되 **요청한 zIndex 를 마크업에 남긴다**.
    else if (name === "ZIndexLayer") {
      const Layer = ({
        zIndex,
        children,
      }: {
        zIndex?: number;
        children?: ReactNode;
      }) =>
        createElement(
          tag,
          { [nameAttr]: "ZIndexLayer", "data-z": String(zIndex) },
          children,
        );
      Layer.displayName = "Stub(ZIndexLayer)";
      out[name] = Layer;
    } else if (name.startsWith("use")) out[name] = () => undefined;
    else if (typeof actual[name] === "function" || typeof actual[name] === "object") {
      const Stub = (props: Record<string, unknown>) => {
        const attrs: Record<string, unknown> = { [nameAttr]: name };
        for (const [prop, attr] of Object.entries(keep)) {
          const v = props[prop];
          attrs[attr] = v == null ? undefined : String(v);
        }
        return createElement(tag, attrs, (props.children as ReactNode) ?? null);
      };
      Stub.displayName = `Stub(${name})`;
      out[name] = Stub;
    } else out[name] = actual[name];
  }
  return out;
}

/** 마크업에서 보조선 path 들을 뽑는다(`d` 와 stroke 계열 속성). */
export function bridgePaths(html: string): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = [];
  const re = /<path[^>]*class="recharts-trend-gap-bridge"[^>]*>/g;
  for (const tagText of html.match(re) ?? []) {
    const attrs: Record<string, string> = {};
    for (const [, k, v] of tagText.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) attrs[k] = v;
    out.push(attrs);
  }
  return out;
}

/**
 * 보조선 path 중 **recharts 층(`ZIndexLayer`) 안에 있는 것**의 층 번호들.
 *
 * 층 래퍼는 보조선 하나를 정확히 감싸므로 여는 태그 바로 뒤에 path 가 온다 —
 * 그래서 중첩 걱정 없이 한 정규식으로 셀 수 있다.
 */
export function bridgeLayers(html: string, tag = "g", nameAttr = "data-rc"): string[] {
  const re = new RegExp(
    `<${tag} ${nameAttr}="ZIndexLayer" data-z="([^"]*)"><path[^>]*class="recharts-trend-gap-bridge"`,
    "g",
  );
  return [...html.matchAll(re)].map((m) => m[1]);
}

/**
 * 스텁이 렌더한 툴팁 본문의 **내용물**. 툴팁이 안 그려졌으면 `null`,
 * 본문이 `null` 을 돌려줬으면 `""`(= 빈 래퍼) 다.
 *
 * recharts 는 content 가 null 이면 래퍼 `<div>` 만 내는데 그 div 에는 배경·테두리가
 * 없다(`es6/component/TooltipBoundingBox.js` 의 `outerStyle` — 위치와 `wrapperStyle`
 * 뿐이고 박스 모양은 `contentStyle` 을 받는 본문에만 있다). 그래서 `""` = 화면에
 * 아무것도 안 보인다.
 *
 * 중첩된 같은 태그를 세어 짝 맞는 닫는 태그를 찾는다(정규식으로는 못 한다).
 */
export function tooltipBody(html: string, tag = "g", nameAttr = "data-rc"): string | null {
  const open = `<${tag} ${nameAttr}="Tooltip" data-tip="1">`;
  const at = html.indexOf(open);
  if (at < 0) return null;
  const rest = html.slice(at + open.length);
  const opensHere = (i: number) =>
    rest.startsWith(`<${tag}`, i) && /[\s>]/.test(rest[i + tag.length + 1] ?? "");
  let depth = 0;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest.startsWith(`</${tag}>`, i)) {
      if (depth === 0) return rest.slice(0, i);
      depth -= 1;
      i += tag.length + 2;
    } else if (opensHere(i)) {
      depth += 1;
    }
  }
  return null;
}
