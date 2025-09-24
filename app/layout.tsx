import "./globals.css";
import type { ReactNode } from "react";
import BottomNavGate from "@/components/BottomNavGate"; // ou caminho relativo

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body className="bg-[var(--background)] text-black antialiased">
        {children}
        <BottomNavGate />
      </body>
    </html>
  );
}
