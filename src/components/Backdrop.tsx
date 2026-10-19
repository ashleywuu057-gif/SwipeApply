"use client";

import { usePathname } from "next/navigation";

const SKY =
  "https://images.higgs.ai/?default=1&output=webp&url=https%3A%2F%2Fd8j0ntlcm91z4.cloudfront.net%2Fuser_38xzZboKViGWJOttwIXH07lWA1P%2Fhf_20260611_133301_d5f2a94a-b22e-4e4a-a6b6-eacdddf1f5b0.png&w=1280&q=85";
const GRASS = "https://res.cloudinary.com/dy5er7kv5/image/upload/q_auto/f_auto/v1781191264/grass_eam204.png";

/** 全站背景：天空 + 底部草地，都在内容下面；首页以外加一层白纱，表格、看板里的字才看得清 */
export default function Backdrop() {
  const home = usePathname() === "/";
  return (
    <>
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 bg-cover bg-center" style={{ backgroundImage: `url(${SKY})` }} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={GRASS} alt="" aria-hidden onError={(e) => (e.currentTarget.style.display = "none")} className="pointer-events-none fixed bottom-0 left-0 -z-10 w-full select-none" />
      {!home && <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 bg-white/55 backdrop-blur-[2px]" />}
    </>
  );
}
