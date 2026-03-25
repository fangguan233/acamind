import getRouterBasename from '@/lib/router';
import App from 'App';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  useApi,
  useAuth,
  useChatInteract,
  useConfig
} from '@chainlit/react-client';

const isAuthRoute = (pathname: string) => {
  const basename = getRouterBasename();
  return (
    pathname === `${basename}/login` ||
    pathname === `${basename}/login/callback` ||
    pathname === `${basename}/register`
  );
};

const softReplacePath = (path: string) => {
  if (typeof window === 'undefined') return;
  const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (currentPath === path) return;
  window.history.replaceState(window.history.state, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
};

export default function AppWrapper() {
  const [translationLoaded, setTranslationLoaded] = useState(false);
  const { isReady, user } = useAuth();
  const { language: languageInUse } = useConfig();
  const { i18n } = useTranslation();
  const { windowMessage } = useChatInteract();

  function handleChangeLanguage(languageBundle: any): void {
    i18n.addResourceBundle(languageInUse, 'translation', languageBundle);
    i18n.changeLanguage(languageInUse);
  }

  const { data: translations } = useApi<any>(
    `/project/translations?language=${languageInUse}`
  );

  useEffect(() => {
    if (!translations) return;
    handleChangeLanguage(translations.translation);
    setTranslationLoaded(true);
  }, [translations]);

  useEffect(() => {
    const handleWindowMessage = (event: MessageEvent) => {
      windowMessage(event.data);
    };
    window.addEventListener('message', handleWindowMessage);
    return () => window.removeEventListener('message', handleWindowMessage);
  }, [windowMessage]);

  useEffect(() => {
    if (!translationLoaded || !isReady || user) return;
    if (isAuthRoute(window.location.pathname)) return;
    softReplacePath(getRouterBasename() + '/login');
  }, [isReady, translationLoaded, user]);

  if (!translationLoaded) return null;
  return <App />;
}
