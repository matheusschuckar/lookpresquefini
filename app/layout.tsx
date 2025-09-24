import "./globals.css";
import type { ReactNode } from "react";
import BottomNavGate from "@/components/BottomNavGate";

export const viewport = { viewportFit: "cover" }; // mantém safe-area no iOS

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body className="text-black antialiased bg-[var(--background)]">
        <main className="with-bottom-nav min-h-screen canvas">
          {children}
        </main>
        <BottomNavGate />
      </body>
    </html>
  );
}
