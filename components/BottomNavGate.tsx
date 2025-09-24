"use client";

import { usePathname } from "next/navigation";
import BottomNav from "@/components/BottomNav";

const SHOW_ROUTES = ["/", "/saved", "/stores", "/bag", "/orders"];

export default function BottomNavGate() {
  const pathname = usePathname();

  const show = SHOW_ROUTES.some((base) =>
    base === "/"
      ? pathname === "/"
      : pathname === base || pathname.startsWith(base + "/")
  );

  if (!show) return null;
  return <BottomNav />;
}
