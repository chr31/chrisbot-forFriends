// chrisbot-fe/app/layout.tsx
import './globals.css';

export const metadata = {
  title: 'ChrisBot',
  description: 'Un assistente AI per il team IT',
  // Aggiungi i metadati per la PWA
  manifest: '/manifest.json', 
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'ChrisBot',
  },
};

// Sposta themeColor in viewport come richiesto da Next.js
export const viewport = {
  themeColor: '#111827',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
          <link rel="apple-touch-icon" href="/icons/icon-180x180.png"/>
          
          <link rel="apple-touch-icon" sizes="120x120" href="/icons/icon-180x180.png"/>
          <link rel="apple-touch-icon" sizes="180x180" href="/icons/icon-180x180.png"/>
          
          <link rel="apple-touch-icon" sizes="152x152" href="/icons/icon-180x180.png"/>
          <link rel="apple-touch-icon" sizes="167x167" href="/icons/icon-180x180.png"/>
      </head>
      <body className="bg-gray-900">{children}</body>
    </html>
  );
}
