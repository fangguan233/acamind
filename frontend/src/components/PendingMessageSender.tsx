import { useEffect } from 'react';
import { toast } from 'sonner';

import { useAuth, useChatInteract, useChatSession } from '@chainlit/react-client';

const PENDING_MESSAGE_KEY = 'acamind_pending_message_v1';

export default function PendingMessageSender() {
  const { session } = useChatSession();
  const { sendMessage } = useChatInteract();
  const { user } = useAuth();

  useEffect(() => {
    if (!session?.socket?.connected) return;
    if (typeof window === 'undefined') return;

    const raw = window.sessionStorage.getItem(PENDING_MESSAGE_KEY);
    if (!raw) return;

    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      window.sessionStorage.removeItem(PENDING_MESSAGE_KEY);
      return;
    }

    const message =
      typeof parsed?.message === 'string' ? parsed.message.trim() : '';
    const command =
      typeof parsed?.command === 'string' ? parsed.command.trim() : '';

    window.sessionStorage.removeItem(PENDING_MESSAGE_KEY);

    if (!message) return;

    try {
      sendMessage({
        threadId: '',
        name: user?.identifier || 'User',
        type: 'user_message',
        output: message,
        metadata: { location: window.location.href },
        ...(command ? { command } : {})
      } as any);
    } catch (err) {
      toast.error(String(err));
    }
  }, [session?.socket?.connected, sendMessage, user?.identifier]);

  return null;
}
