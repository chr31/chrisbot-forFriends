// app/(protected)/layout.tsx
'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Sidebar from '@/components/Sidebar';
import { Bars3Icon } from '@heroicons/react/24/outline';

export default function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isAuth, setIsAuth] = useState(false);
  const router = useRouter();

  useEffect(() => {
    const token = localStorage.getItem('authToken');
    if (!token) {
      router.replace('/login');
    } else {
      // Questa transizione è intenzionale per abilitare il contenuto dopo il check client-side del token
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsAuth(true);
    }
  }, [router]);

  if (!isAuth) {
    return <div className="flex justify-center items-center h-screen">Caricamento...</div>;
  }

   return (
    <div>
      <Sidebar open={sidebarOpen} setOpen={setSidebarOpen} />
      <div className="lg:pl-72">
        <div className="sticky top-0 z-10 flex h-16 shrink-0 items-center gap-x-6 border-b border-white/5 bg-gray-900 px-4 shadow-sm sm:px-6 lg:hidden">
            <button type="button" className="-m-2.5 p-2.5 text-white lg:hidden" onClick={() => setSidebarOpen(true)}>
                <span className="sr-only">Apri sidebar</span>
                <Bars3Icon className="h-5 w-5" aria-hidden="true" />
            </button>
        </div>
        
        <main className="h-[calc(100vh-4rem)] lg:h-screen overflow-y-auto">
          <div className="px-4 sm:px-6 lg:px-8 h-full">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
