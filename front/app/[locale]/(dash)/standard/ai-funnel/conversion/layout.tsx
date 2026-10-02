import type { ReactNode } from "react";
import { ConversionSampleNoticeDialog } from "../_components/conversion-sample-notice-dialog";

// 진입 안내 팝업은 페이지가 아니라 이 레이아웃에 둔다. 페이지 세그먼트는 검색
// 파라미터(필터·기간)가 바뀔 때마다 새로 마운트되어, 페이지에 두면 필터를 바꿀
// 때마다 팝업이 다시 뜬다. 레이아웃은 다른 화면에서 이 경로로 들어올 때만 마운트된다.
export default function AiFunnelConversionLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <>
      {children}
      <ConversionSampleNoticeDialog />
    </>
  );
}
