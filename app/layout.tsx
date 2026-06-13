import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Synthetic Harness Lab / Evidence Viewer",
  description:
    "A thin evidence viewer over a deterministic, keyless sweep. The same harness passes every technical check in both versions; the trace tells you what it cost. Technical pass holds flat at 100% while Cash Burned goes $5,140 to $0 and Trust 38 to 91.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
