// app/layout.tsx
import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Look",
  description: "Ready to wear in minutes",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <head>
        {/* status bar do iOS / PWA no mesmo tom */}
        <meta name="theme-color" content="#F9F7F5" />
      </head>
      <body
        className="min-h-dvh text-black"
        style={{ backgroundColor: "#F9F7F5" }} // 👈 força o off-white quente no app inteiro
      >
        {children}
      </body>
    </html>
  );
}
