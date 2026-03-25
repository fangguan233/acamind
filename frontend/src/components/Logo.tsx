import { cn } from '@/lib/utils';
import { useContext, useMemo } from 'react';

import { ChainlitContext, useConfig } from '@chainlit/react-client';

import { useTheme } from './ThemeProvider';

interface Props {
  className?: string;
}

export const Logo = ({ className }: Props) => {
  const { variant } = useTheme();
  const { config } = useConfig();
  const apiClient = useContext(ChainlitContext);
  const cacheBust = useMemo(() => Date.now().toString(), []);
  const configuredLogo = config?.ui?.logo_file_url || '';
  let src = '';

  if (configuredLogo) {
    src = configuredLogo.includes('{theme}')
      ? configuredLogo.replace('{theme}', variant)
      : configuredLogo;
    if (src.startsWith('/public')) {
      src = apiClient.buildEndpoint(src);
    }
  } else {
    src = apiClient.getLogoEndpoint(variant, undefined);
  }

  if (src) {
    src = `${src}${src.includes('?') ? '&' : '?'}v=${cacheBust}`;
  }

  return (
    <img
      src={src}
      alt="logo"
      className={cn('logo block mx-auto', className)}
    />
  );
};
