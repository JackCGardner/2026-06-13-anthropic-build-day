import type { ReactNode } from "react";

export const metadata = {
  title: "Synthetic Harness Lab",
  description:
    "Evaluate agent-generated harnesses in a synthetic world before they touch real money or real customers.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
