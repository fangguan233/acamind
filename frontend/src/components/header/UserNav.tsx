import capitalize from 'lodash/capitalize';
import { LogOut } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { useAuth } from '@chainlit/react-client';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { Translator } from 'components/i18n';

export default function UserNav() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  if (!user) return null;
  const displayName = user?.display_name || user?.identifier;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          id="user-nav-button"
          variant="ghost"
          className="relative h-8 w-8 rounded-full"
        >
          <Avatar className="h-8 w-8">
            <AvatarImage src={user?.metadata.image} alt="user image" />
            <AvatarFallback className="bg-primary text-primary-foreground font-semibold">
              {capitalize(displayName[0])}
            </AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-26" align="end" forceMount>
        <DropdownMenuLabel className="font-normal">
          <div className="flex flex-col space-y-1">
            <p className="text-sm font-medium leading-none">{displayName}</p>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {user?.metadata?.is_admin ? (
          <DropdownMenuItem onClick={() => navigate('/admin')}>
            管理后台
          </DropdownMenuItem>
        ) : null}
        {user?.metadata?.is_admin ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem onClick={() => logout(true)}>
          <Translator path="navigation.user.menu.logout" />
          <LogOut className="ml-auto" />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
