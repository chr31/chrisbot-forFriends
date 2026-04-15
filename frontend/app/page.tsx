// app/page.tsx
import { redirect } from 'next/navigation';

export default function HomePage() {
  redirect('/agent-chat/new');
  
  return null;
}
